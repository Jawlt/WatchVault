import express, { query } from "express";
import axios from "axios";
import bodyParser from "body-parser";
import { MongoClient } from "mongodb";
import session from "express-session";
import MongoDBStore from 'connect-mongodb-session';
import bcrypt from "bcryptjs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from "path";
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const API_URL = "";

//Middleware
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Get __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.set("view engine", "ejs");
app.set('views', path.join(__dirname, 'views'));

//MongoDB Connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
const usersCollection = client.db("WatchVault").collection("users");

//MongoDB session store setup
const store = new MongoDBStore({
    uri: process.env.MONGODB_URI,
    collection: 'sessions'
});

// Use MongoDB session store
app.use(session({
    secret: 'watch-vault-project',
    resave: false,
    saveUninitialized: false,
    store: store,  // Persistent store instead of MemoryStore
    cookie: { secure: false }  // Set secure to true if using HTTPS
}));

function checkLoginAuth(req, res, next) {
    if(req.session && req.session.user) {
        next();
    } else {
        res.redirect("/login");
    }
}

async function main() {
    try {
        await client.connect();
    } catch (e) {
        console.error(e)
    }
}

main().catch(console.error);

//AWS Connection
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

//TMDB API
const TMDB_API_URL = "https://api.themoviedb.org/3";

//Routes
app.get("/", checkLoginAuth, (req, res) => {
    console.log(`Welcome, ${req.session.user.username}`);
    res.render("index", { user: req.session.user, currentPath: req.path });
});

app.get("/login", (req, res) => {
    res.render("login");
});

app.get("/signup", (req, res) => {
    res.render("signup");
});

app.get("/logout", (req, res) => {
    console.log(`Logged Out`);
    req.session.destroy((err) => {
        if(err) {
            return res.redirect("/");
        }
        
        res.clearCookie('connect.sid');
        res.redirect("/");
    });
});

app.get("/movies", checkLoginAuth, async (req, res) => {
    console.log(`Movies, ${req.session.user.username}`);

    const user = await usersCollection.findOne({ username: req.session.user.username });
    let firstMovie = false;

    if (user && (!user.movies || user.movies.length === 0)) {
        console.log("User has no movies");
        firstMovie = true;
    }

    res.render("movies", { user: req.session.user, currentPath: req.path, movies: user.movies, firstMovie: firstMovie });
});

app.get("/tvshows", checkLoginAuth, async (req, res) => {
    console.log(`TV Shows, ${req.session.user.username}`);

    const user = await usersCollection.findOne({ username: req.session.user.username });
    let firstTvShow = false;

    if (user && (!user.tvshows || user.tvshows.length === 0)) {
        console.log("User has no tvshows");
        firstTvShow = true;
    }

    res.render("tvshows", { user: req.session.user, currentPath: req.path, tvshows: user.tvshows, firstTvShow: firstTvShow });
});

app.get("/animes", checkLoginAuth, async (req, res) => {
    console.log(`Anime, ${req.session.user.username}`);

    const user = await usersCollection.findOne({ username: req.session.user.username });
    let firstAnime = false;

    if (user && (!user.animes || user.animes.length === 0)) {
        console.log("User has no anime");
        firstAnime = true;
    }

    res.render("animes", { user: req.session.user, currentPath: req.path, animes: user.animes, firstAnime: firstAnime});
});


//Handling login
app.post("/login", async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await usersCollection.findOne({ email: email });
        if(user && await bcrypt.compare(password, user.password)) {
            req.session.user = user;
            res.redirect("/")
        } else {
            res.redirect("/login");
            console.log("Invalid Credentials.");
        }
    } catch (e) {
        console.error(e);
        res.status(500).send("Error logging in.");
    }
});

//Handling signup
app.post("/signup", async (req, res) => {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    try {
        const result = usersCollection.insertOne({
            username: username,
            email: email,
            password: hashedPassword,
        });

        console.log("User Registered.", result);
        res.redirect("/");
    } catch (e) {
        console.error(e);
        res.status(500).send("Error signing up.");
    }
});

app.post("/movies/add", async (req, res) => {
    const { movieName, opinion } = req.body;

    const user = await usersCollection.findOne({ username: req.session.user.username });

    const movies = user.movies || [];

    for (let i = 0; i < movies.length; i++) {
        if (movies[i].name === movieName) {
            return res.status(400).json({ error: "Movie already exists" });
        }
    }

    console.log("Received data:", req.body);

    try {
        console.log(`Looking for user with username: ${req.session.user.username}`);

        const tmdbResponse = await axios.get(`${TMDB_API_URL}/search/movie`, {
            params: {
                api_key: process.env.TMDB_API_KEY,
                query: movieName
            }
        });

        const movieData = tmdbResponse.data.results[0];
        const posterPath = movieData.poster_path;
        const posterUrl = `https://image.tmdb.org/t/p/original/${posterPath}`;

        const s3PosterUrl = await uploadImageToS3(posterUrl, `${movieName}.jpg`, 'movie');

        const updatedUser = await usersCollection.findOneAndUpdate(
            { username: req.session.user.username },
            {
                $push: { 
                    movies: { name: movieName, opinion: opinion, url: s3PosterUrl }
                }
            },
            { returnDocument: "after" }
        );
        
        console.log("findOneAndUpdate result:", updatedUser.movies);
        res.status(200).json({ message: "Movie added successfully" });
    } catch (error) {
        console.error("Error adding movie:", error); 
        res.status(500).json({ success: false, message: 'Error adding movie', error: error.message });
    }
});

app.post("/tvshows/add", async (req, res) => {
    const { tvShowName, opinion } = req.body;

    const user = await usersCollection.findOne({ username: req.session.user.username });

    const tvShows = user.tvshows || [];

    for (let i = 0; i < tvShows.length; i++) {
        if (tvShows[i].name === tvShowName) {
            return res.status(400).json({ error: "Tv show already exists" });
        }
    }

    console.log("Received data:", req.body);

    try {
        console.log(`Looking for user with username: ${req.session.user.username}`);

        const tmdbResponse = await axios.get(`${TMDB_API_URL}/search/tv`, {
            params: {
                api_key: process.env.TMDB_API_KEY,
                query: tvShowName
            }
        });

        const tvShowData = tmdbResponse.data.results[0];
        const posterPath = tvShowData.poster_path;
        const posterUrl = `https://image.tmdb.org/t/p/original/${posterPath}`;

        const s3PosterUrl = await uploadImageToS3(posterUrl, `${tvShowName}.jpg`, 'tvshow');

        const updatedUser = await usersCollection.findOneAndUpdate(
            { username: req.session.user.username },
            {
                $push: { 
                    tvshows: { name: tvShowName, opinion: opinion, url: s3PosterUrl }
                }
            },
            { returnDocument: "after" }
        );
        
        console.log("findOneAndUpdate result:", updatedUser.tvshows);
        res.status(200).json({ message: "Tv show added successfully" });
    } catch (error) {
        console.error("Error adding tv show:", error); 
        res.status(500).json({ success: false, message: 'Error adding tv show', error: error.message });
    }
});

app.post("/anime/add", async (req, res) => {
    const { animeName, opinion } = req.body;

    const user = await usersCollection.findOne({ username: req.session.user.username });

    const animes = user.animes || [];

    for (let i = 0; i < animes.length; i++) {
        if (animes[i].name === animeName) {
            return res.status(400).json({ error: "Anime already exists" });
        }
    }

    console.log("Received data:", req.body);

    try {
        console.log(`Looking for user with username: ${req.session.user.username}`);

        const jikanResponse = await axios.get(`https://api.jikan.moe/v4/anime`, {
            params: {
                q: animeName // Query parameter to search by anime name
            }
        });

        // Extract anime data from the response
        const animeData = jikanResponse.data.data[0]; // Get the first result
        if (!animeData) {
            throw new Error(`No anime found for "${animeName}"`);
        }
        // Extract the poster URL from the Jikan response
        const posterUrl = animeData.images.jpg.image_url; // Jikan returns the image URL in .jpg format

        const s3PosterUrl = await uploadImageToS3(posterUrl, `${animeName}.jpg`, 'anime');

        const updatedUser = await usersCollection.findOneAndUpdate(
            { username: req.session.user.username },
            {
                $push: { 
                    animes: { name: animeName, opinion: opinion, url: s3PosterUrl }
                }
            },
            { returnDocument: "after" }
        );
        
        console.log("findOneAndUpdate result:", updatedUser.animes);
        res.status(200).json({ message: "Anime added successfully" });
    } catch (error) {
        console.error("Error adding anime:", error); 
        res.status(500).json({ success: false, message: 'Error adding anime', error: error.message });
    }
});

app.patch('/movies/update-movie-opinion', async (req, res) => { 
    const { movieName, opinion } = req.body;
    let newOpinion;

    if (opinion === "liked") {
        newOpinion = 'disliked';
    } else if (opinion === "disliked") {
        newOpinion = 'liked';
    }
    console.log('Patch request reached', { newOpinion: newOpinion });
    
    try {
        // Update the opinion for the specific movie
        const result = await usersCollection.updateOne(
            { username: req.session.user.username, "movies.name": movieName }, // Ensure movies array is correctly matched
            { $set: { "movies.$.opinion": newOpinion } }, // Use positional operator to update the correct movie's opinion
        );

        console.log(result.modifiedCount);
        if (result.modifiedCount > 0) {
            res.status(200).send({ message: 'Opinion updated successfully.' });
        } else {
            res.status(404).send({ message: 'Movie or user not found.' });
        }
    } catch (error) {
        console.error('Error updating movie opinion:', error);
        res.status(500).send({ message: 'An error occurred while updating the opinion.' });
    }
});

app.patch('/tvshows/update-tvshow-opinion', async (req, res) => { 
    const { tvShowName, opinion } = req.body;
    let newOpinion;

    if (opinion === "liked") {
        newOpinion = 'disliked';
    } else if (opinion === "disliked") {
        newOpinion = 'liked';
    }
    console.log('Patch request reached', { newOpinion: newOpinion });
    
    try {
        // Update the opinion for the specific tv show
        const result = await usersCollection.updateOne(
            { username: req.session.user.username, "tvshows.name": tvShowName }, // Ensure tv show array is correctly matched
            { $set: { "tvshows.$.opinion": newOpinion } }, // Use positional operator to update the correct tv show's opinion
        );

        console.log(result.modifiedCount);
        if (result.modifiedCount > 0) {
            res.status(200).send({ message: 'Opinion updated successfully.' });
        } else {
            res.status(404).send({ message: 'Tv show or user not found.' });
        }
    } catch (error) {
        console.error('Error updating tv show opinion:', error);
        res.status(500).send({ message: 'An error occurred while updating the opinion.' });
    }
});

app.patch('/anime/update-anime-opinion', async (req, res) => { 
    const { animeName, opinion } = req.body;
    let newOpinion;

    if (opinion === "liked") {
        newOpinion = 'disliked';
    } else if (opinion === "disliked") {
        newOpinion = 'liked';
    }
    console.log('Patch request reached', { newOpinion: newOpinion });
    
    try {
        // Update the opinion for the specific movie
        const result = await usersCollection.updateOne(
            { username: req.session.user.username, "animes.name": animeName }, // Ensure animes array is correctly matched
            { $set: { "animes.$.opinion": newOpinion } }, // Use positional operator to update the correct animes's opinion
        );

        console.log(result.modifiedCount);
        if (result.modifiedCount > 0) {
            res.status(200).send({ message: 'Opinion updated successfully.' });
        } else {
            res.status(404).send({ message: 'Anime or user not found.' });
        }
    } catch (error) {
        console.error('Error updating anime opinion:', error);
        res.status(500).send({ message: 'An error occurred while updating the opinion.' });
    }
});

app.delete('/movies/delete', async (req, res) => {
    const { movieName } = req.body;
    try {
        const result = await usersCollection.updateOne(
            { username: req.session.user.username },
            { $pull: { movies: { name: movieName } } } // Remove the movie by name
        );

        if (result.modifiedCount > 0) {
            res.status(200).json({ message: 'Movie deleted successfully' });
        } else {
            res.status(400).json({ error: 'Movie not found' });
        }
    } catch (error) {
        console.error('Error deleting movie:', error);
        res.status(500).json({ error: 'An error occurred while deleting the movie' });
    }
});

app.delete('/tvshows/delete', async (req, res) => {
    const { tvShowName } = req.body;
    try {
        const result = await usersCollection.updateOne(
            { username: req.session.user.username },
            { $pull: { tvshows: { name: tvShowName } } } // Remove the tv show by name
        );

        if (result.modifiedCount > 0) {
            res.status(200).json({ message: 'Tv show deleted successfully' });
        } else {
            res.status(400).json({ error: 'Tv show not found' });
        }
    } catch (error) {
        console.error('Error deleting tv show:', error);
        res.status(500).json({ error: 'An error occurred while deleting the tv show' });
    }
});

app.delete('/anime/delete', async (req, res) => {
    const { animeName } = req.body;
    try {
        const result = await usersCollection.updateOne(
            { username: req.session.user.username },
            { $pull: { animes: { name: animeName } } } // Remove the anime by name
        );

        if (result.modifiedCount > 0) {
            res.status(200).json({ message: 'Anime deleted successfully' });
        } else {
            res.status(400).json({ error: 'Anime not found' });
        }
    } catch (error) {
        console.error('Error deleting anime:', error);
        res.status(500).json({ error: 'An error occurred while deleting the anime' });
    }
});

async function uploadImageToS3(imageUrl, filename, type) {
    const response = await axios({
        url: imageUrl,
        responseType: 'stream'
    });

    const upload = new Upload({
        client: s3Client,
        params: {
            Bucket: process.env.AWS_S3_BUCKET,
            Key: `posters/${type}/${filename}`, // Save under the 'posters/type' folder
            Body: response.data,
            ContentType: response.headers['content-type'],
        }
    });

    try {
        const uploadResult = await upload.done();
        return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/posters/${type}/${filename}`; // Return the S3 URL
    } catch (err) {
        console.error('Error uploading to S3:', err);
        throw err;
    }
}

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});