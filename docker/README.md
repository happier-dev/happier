# Docker builds (unified)

Dockerfiles in this repo historically duplicated a lot of workspace install/build logic, which made fixes easy to miss.

`docker/Dockerfile` provides a single multi-target build with shared deps stages.

## Build targets

- Website (Vite static): `website`
- Webapp (Expo export static): `webapp`
- Docs (Next.js): `docs`
- Server (Node): `server`

## Examples

```bash
docker build -f docker/Dockerfile --target website -t happier-website:local .
docker build -f docker/Dockerfile --target webapp  -t happier-webapp:local  .
docker build -f docker/Dockerfile --target docs    -t happier-docs:local    .
docker build -f docker/Dockerfile --target server  -t happier-server:local  .
```

Or with Buildx Bake:

```bash
docker buildx bake -f docker/bake.hcl
```

