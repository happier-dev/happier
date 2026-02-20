# happierdev/dev-box

Run Happier CLI + daemon inside a container, and pair it to your account without opening a browser.

Quick start (preview):

```bash
docker run --rm -it happierdev/dev-box:preview
```

Recommended: persist `~/.happier` so credentials and machine state survive restarts:

```bash
docker run --rm -it \
  -v happier-home:/home/happier/.happier \
  happierdev/dev-box:preview
```

Optional: install provider CLIs on first boot:

```bash
docker run --rm -it \
  -e HAPPIER_PROVIDER_CLIS=claude,codex \
  happierdev/dev-box:preview
```

Docs:

- Dev Containers: https://docs.happier.dev/development/devcontainers
