# Secure File Manager Service

A hardened file management console built with Express, Multer, Prisma ORM, and MariaDB. The service stores file blobs on disk, tracks metadata and users in MariaDB, and exposes an authenticated UI for uploading, listing, previewing, downloading, and deleting files.

## Features

- **Authentication** – Session-based username/password login secured with bcrypt hashes.
- **Prisma-powered data layer** – Declarative schema, safe migrations, and typed access via Prisma Client.
- **Resumable uploads** – Chunked upload pipeline (default 8 MB chunks) with automatic assembly and validation up to 150 MB.
- **Link sharing** – Toggle per-file visibility for public downloads and copy shareable download/preview links instantly.
- **Safe file handling** – Sanitised filenames, strict MIME/extension allowlist (images, documents, archives, video), configurable chunk size.
- **Media-friendly downloads** – HTTP Range support for partial downloads/streaming.
- **Rich previews** – View images, video/audio, PDFs, and text files directly in the browser.
- **Responsive UI** – Modern front-end with login flow, status feedback, progress indicators, and preview panel.

## Getting Started (local)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the example environment and adjust secrets/credentials:
   ```bash
   cp .env.example .env
   # edit .env with secure values
   ```
3. Create the MariaDB database/user (skip if using Docker Compose):
   ```sql
   CREATE DATABASE filemanager CHARACTER SET utf8mb4;
   CREATE USER 'filemanager'@'%' IDENTIFIED BY 'change_me';
   GRANT ALL PRIVILEGES ON filemanager.* TO 'filemanager'@'%';
   FLUSH PRIVILEGES;
   ```
4. Apply migrations, generate Prisma client, and seed the admin user:
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   npx prisma db seed
   ```
5. Start the server:
   ```bash
   npm start
   ```
6. Visit [http://localhost:3001](http://localhost:3001), sign in, and manage files.


## API Overview

All endpoints require an authenticated session unless noted.

- `POST /api/auth/login` – Authenticate with `{ username, password }`.
- `POST /api/auth/logout` – Destroy the session.
- `GET /api/auth/me` – Returns the current session user.
- `GET /api/files` – List metadata for uploaded files.
- `POST /api/upload/init` – Prepare a resumable upload and receive an `uploadId`/chunk size.
- `POST /api/upload/chunk` – Send sequential file chunks (multipart `chunk` payload).
- `POST /api/upload` – Legacy single-request upload (still supported, honours the 150 MB limit).
- `GET /api/files/:id/preview` – Stream image files inline.
- `GET /api/files/:id/download` – Download the original file with HTTP Range support.
- `DELETE /api/files/:id` – Remove a file from disk and metadata from the database.
- `PATCH /api/files/:id/visibility` – Toggle the `isPublic` flag to allow or revoke anonymous downloads.

## Development Notes

- **Schema changes** – Modify `prisma/schema.prisma`, then run `npx prisma migrate dev --name <description>` to generate migrations.
- **Seeding** – `npx prisma db seed` creates the default admin user when `ADMIN_USERNAME/ADMIN_PASSWORD` are present.
- **Chunk size** – Override `CHUNK_SIZE` in the environment to tune chunk uploads (defaults to 8 MB).
- **Sessions** – The bundled `express-session` MemoryStore suits development only. For production, configure a durable session store (Redis, external DB, etc.).
- **TLS** – Terminate HTTPS (reverse proxy or Node TLS) to protect credentials and session cookies.
- **Backups** – Back up both the `uploads/` directory and the MariaDB database to restore files and metadata together.

## Why Not MinIO?

MinIO provides S3-compatible object storage, ideal for distributed or cloud-scale workloads. This service targets single-host deployments with local disk. Leveraging Express + Multer keeps the stack lightweight while still allowing future integration with MinIO or S3 by swapping the storage implementation without changing the API surface.
