# syntax=docker/dockerfile:1

ARG NODE_VERSION=24
ARG BUILDPLATFORM

# Shared deps (alpine) for website/docs/webapp builds
FROM node:${NODE_VERSION}-alpine AS deps-alpine
WORKDIR /repo
# Some workspace deps (e.g. node-pty) may not have prebuilt binaries for all architectures
# and will fall back to node-gyp. Install the minimal toolchain + Python for reliable builds.
RUN apk add --no-cache libc6-compat python3 build-base
ENV REDISMS_DISABLE_POSTINSTALL=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json packages/plugins/*/package.json ./
COPY apps/ui/tools/postinstall ./apps/ui/tools/postinstall
COPY scripts/workspaces ./scripts/workspaces
COPY scripts/ci/setup-pnpm.mjs ./scripts/ci/
COPY packages/cli-common/windowsCommandInvocation.mjs ./packages/cli-common/
COPY scripts/pipeline/expo/eas-postinstall.mjs scripts/pipeline/expo/
RUN node scripts/ci/setup-pnpm.mjs
RUN --mount=type=cache,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --prefer-offline
COPY apps/cli/scripts/build-owned/bundledPluginMembership.ts ./apps/cli/scripts/build-owned/bundledPluginMembership.ts
COPY apps/cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs ./apps/cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs
COPY apps/cli/scripts/buildPublication.mjs ./apps/cli/scripts/buildPublication.mjs
COPY apps/stack/bin/hstack-exec ./apps/stack/bin/hstack-exec
COPY apps/stack/scripts/utils ./apps/stack/scripts/utils
COPY apps/stack/scripts/build/sourceWebExportArgs.mjs ./apps/stack/scripts/build/sourceWebExportArgs.mjs
COPY apps/stack/scripts/provision/linux-inotify.mjs ./apps/stack/scripts/provision/linux-inotify.mjs

# Shared deps (alpine) for web UI export embeds.
# We build the web export on the BUILDPLATFORM because the output is architecture-agnostic, and
# running Node/pnpm under QEMU for linux/arm64 has proven unstable (SIGILL).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build
WORKDIR /repo
RUN apk add --no-cache libc6-compat python3 build-base
ENV REDISMS_DISABLE_POSTINSTALL=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json packages/plugins/*/package.json ./
COPY apps/ui/tools/postinstall ./apps/ui/tools/postinstall
COPY scripts/workspaces ./scripts/workspaces
COPY scripts/ci/setup-pnpm.mjs ./scripts/ci/
COPY packages/cli-common/windowsCommandInvocation.mjs ./packages/cli-common/
COPY scripts/pipeline/expo/eas-postinstall.mjs scripts/pipeline/expo/
RUN node scripts/ci/setup-pnpm.mjs
RUN --mount=type=cache,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --prefer-offline
COPY apps/cli/scripts/build-owned/bundledPluginMembership.ts ./apps/cli/scripts/build-owned/bundledPluginMembership.ts
COPY apps/cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs ./apps/cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs
COPY apps/cli/scripts/buildPublication.mjs ./apps/cli/scripts/buildPublication.mjs
COPY apps/stack/bin/hstack-exec ./apps/stack/bin/hstack-exec
COPY apps/stack/scripts/utils ./apps/stack/scripts/utils
COPY apps/stack/scripts/build/sourceWebExportArgs.mjs ./apps/stack/scripts/build/sourceWebExportArgs.mjs
COPY apps/stack/scripts/provision/linux-inotify.mjs ./apps/stack/scripts/provision/linux-inotify.mjs

# Shared deps (debian) for server builds (needs toolchain for native deps)
FROM node:${NODE_VERSION} AS deps-debian
RUN apt-get update && apt-get install -y python3 ffmpeg make g++ build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV REDISMS_DISABLE_POSTINSTALL=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json packages/plugins/*/package.json ./
COPY apps/ui/tools/postinstall ./apps/ui/tools/postinstall
COPY scripts/workspaces ./scripts/workspaces
COPY scripts/ci/setup-pnpm.mjs ./scripts/ci/
COPY packages/cli-common/windowsCommandInvocation.mjs ./packages/cli-common/
COPY scripts/pipeline/expo/eas-postinstall.mjs scripts/pipeline/expo/

RUN node scripts/ci/setup-pnpm.mjs
RUN --mount=type=cache,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --prefer-offline
COPY apps/cli/scripts/build-owned/bundledPluginMembership.ts ./apps/cli/scripts/build-owned/bundledPluginMembership.ts
COPY apps/cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs ./apps/cli/scripts/build-owned/bundledPlugins/projectionPaths.mjs
COPY apps/cli/scripts/buildPublication.mjs ./apps/cli/scripts/buildPublication.mjs
COPY apps/stack/bin/hstack-exec ./apps/stack/bin/hstack-exec
COPY apps/stack/scripts/utils ./apps/stack/scripts/utils
COPY apps/stack/scripts/build/sourceWebExportArgs.mjs ./apps/stack/scripts/build/sourceWebExportArgs.mjs
COPY apps/stack/scripts/provision/linux-inotify.mjs ./apps/stack/scripts/provision/linux-inotify.mjs

#
# Targets
#

# Website (Vite static)
FROM deps-alpine AS website-builder
ARG WEBSITE_VARIANT=prerelease
COPY apps/website ./apps/website
RUN test -f "apps/website/index.${WEBSITE_VARIANT}.html" && cp "apps/website/index.${WEBSITE_VARIANT}.html" "apps/website/index.html"
RUN pnpm --filter @happier-dev/website run build

FROM nginxinc/nginx-unprivileged:alpine AS website
USER root
RUN apk add --no-cache curl
COPY --from=website-builder /repo/apps/website/dist /usr/share/nginx/html
RUN rm /etc/nginx/conf.d/default.conf
RUN echo 'server { \
    listen 8080; \
    server_name _; \
    root /usr/share/nginx/html; \
    \
    location = /health { \
        return 200 "ok\n"; \
    } \
    \
    location /assets/ { \
        try_files $uri =404; \
    } \
    \
    location /.well-known/ { \
        try_files $uri =404; \
    } \
    \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf
USER 101
EXPOSE 8080

# Webapp (Expo export static)
FROM deps-alpine-build AS webapp-builder
ARG HAPPIER_EMBEDDED_POLICY_ENV=preview
ARG POSTHOG_API_KEY=""
ARG POSTHOG_HOST=""
ARG SENTRY_DSN=""
ARG SENTRY_RELEASE=""
ARG REVENUE_CAT_STRIPE=""
ARG EXPO_PUBLIC_HAPPIER_SERVER_URL=""
ARG EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON=""
ARG EXPO_PUBLIC_HAPPY_SERVER_URL=""
ARG EXPO_PUBLIC_SERVER_URL=""

ENV NODE_ENV=production
ENV APP_ENV=production
ENV EXPO_PUBLIC_HAPPIER_SERVER_URL=$EXPO_PUBLIC_HAPPIER_SERVER_URL
ENV EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON=$EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON
ENV EXPO_PUBLIC_HAPPY_SERVER_URL=$EXPO_PUBLIC_HAPPY_SERVER_URL
ENV EXPO_PUBLIC_SERVER_URL=$EXPO_PUBLIC_SERVER_URL
ENV EXPO_PUBLIC_POSTHOG_KEY=$POSTHOG_API_KEY
ENV EXPO_PUBLIC_POSTHOG_HOST=$POSTHOG_HOST
ENV EXPO_PUBLIC_SENTRY_DSN=$SENTRY_DSN
ENV EXPO_PUBLIC_SENTRY_RELEASE=$SENTRY_RELEASE
ENV EXPO_UNSTABLE_WEB_MODAL=1
ENV EXPO_PUBLIC_REVENUE_CAT_STRIPE=$REVENUE_CAT_STRIPE
ENV HAPPIER_EMBEDDED_POLICY_ENV=$HAPPIER_EMBEDDED_POLICY_ENV

COPY .github/feature-policy ./.github/feature-policy
COPY apps/ui ./apps/ui
COPY packages/agents ./packages/agents
COPY packages/connection-supervisor ./packages/connection-supervisor
COPY packages/protocol ./packages/protocol
COPY packages/release-runtime ./packages/release-runtime
COPY packages/transfers ./packages/transfers
COPY scripts/pipeline/release/precompress-ui-web-assets.mjs ./scripts/pipeline/release/precompress-ui-web-assets.mjs
COPY apps/stack/scripts/build/precompress_ui_web_assets.mjs ./apps/stack/scripts/build/precompress_ui_web_assets.mjs

RUN pnpm --filter @happier-dev/protocol run postinstall:real \
    && pnpm --filter @happier-dev/release-runtime run postinstall:real \
    && pnpm --filter @happier-dev/agents run postinstall:real \
    && pnpm --filter @happier-dev/connection-supervisor run postinstall:real \
    && pnpm --filter @happier-dev/transfers run postinstall:real
RUN pnpm --filter @happier-dev/app run postinstall:real
RUN rm -rf apps/ui/dist
RUN pnpm --filter @happier-dev/app exec expo export --platform web --output-dir dist --max-workers 1
RUN node scripts/pipeline/release/precompress-ui-web-assets.mjs --dir apps/ui/dist --gzip-only

FROM nginxinc/nginx-unprivileged:alpine AS webapp
USER root
RUN apk add --no-cache curl
COPY --from=webapp-builder /repo/apps/ui/dist /usr/share/nginx/html
RUN rm /etc/nginx/conf.d/default.conf
RUN echo 'map $request_uri $happier_frame_ancestors { \
    ~^/embed/ ""; \
    default "frame-ancestors '\''none'\''"; \
} \
server { \
    listen 8080; \
    gzip_static on; \
    gzip_vary on; \
    add_header Content-Security-Policy $happier_frame_ancestors always; \
    \
    location = /health { \
        return 200 "ok\n"; \
    } \
    \
    location /_expo/ { \
        root   /usr/share/nginx/html; \
        add_header Cache-Control "public, max-age=31536000, immutable"; \
        add_header Content-Security-Policy $happier_frame_ancestors always; \
        try_files $uri =404; \
    } \
    \
    location /assets/ { \
        root   /usr/share/nginx/html; \
        add_header Cache-Control "public, max-age=31536000, immutable"; \
        add_header Content-Security-Policy $happier_frame_ancestors always; \
        try_files $uri =404; \
    } \
    \
    location /.well-known/ { \
        root   /usr/share/nginx/html; \
        try_files $uri =404; \
    } \
    \
    location / { \
        root   /usr/share/nginx/html; \
        index  index.html index.htm; \
        add_header Cache-Control "no-store"; \
        add_header Content-Security-Policy $happier_frame_ancestors always; \
        try_files $uri $uri.html $uri/index.html $uri/index.htm $uri/ /index.html /index.htm =404; \
    } \
    \
    error_page 500 502 503 504 /50x.html; \
    location = /50x.html { \
        root /usr/share/nginx/html; \
        try_files $uri @redirect_to_index; \
        internal; \
    } \
    \
    error_page 404 = @handle_404; \
    \
    location @handle_404 { \
        root /usr/share/nginx/html; \
        try_files /404.html @redirect_to_index; \
        internal; \
    } \
    \
    location @redirect_to_index { \
        return 302 /; \
    } \
}' > /etc/nginx/conf.d/default.conf
USER 101
EXPOSE 8080

# Docs (Next.js)
FROM deps-alpine AS docs-builder
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/docs ./apps/docs
COPY apps/ui/sources/assets/fonts ./apps/ui/sources/assets/fonts
RUN pnpm --filter docs run postinstall:real && pnpm --filter docs run build

FROM node:${NODE_VERSION}-alpine AS docs
WORKDIR /repo
RUN apk add --no-cache libc6-compat curl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
COPY --from=docs-builder /repo/node_modules /repo/node_modules
COPY --from=docs-builder /repo/apps/docs /repo/apps/docs
EXPOSE 3000
WORKDIR /repo/apps/docs
CMD ["node", "/repo/node_modules/next/dist/bin/next", "start"]

# Server
FROM deps-debian AS server-builder
ARG HAPPIER_EMBEDDED_POLICY_ENV=preview
ARG HAPPIER_BUILD_DB_PROVIDERS=""
ENV HAPPIER_BUILD_DB_PROVIDERS=$HAPPIER_BUILD_DB_PROVIDERS
ENV HAPPIER_EMBEDDED_POLICY_ENV=$HAPPIER_EMBEDDED_POLICY_ENV
COPY .github/feature-policy ./.github/feature-policy
COPY apps/server ./apps/server
COPY packages ./packages
COPY apps/stack/scripts/utils ./apps/stack/scripts/utils
RUN pnpm --filter @happier-dev/server run build:shared
RUN pnpm --filter @happier-dev/server run postinstall:real
RUN pnpm --filter @happier-dev/server run build

# Share the existing production dependency projection between server image variants.
FROM server-builder AS server-runtime
RUN node <<'NODE'
const fs = require('fs');
const path = require('path');

const repoRootDir = process.cwd();
const nodeModulesDir = path.join(repoRootDir, 'node_modules');
const keepEntries = new Set(['.bin', '.prisma']);
const visitedPackageJsonPaths = new Set();
const workspacePackageJsonPaths = new Map([
  ['@happier-dev/server', path.join(repoRootDir, 'apps/server/package.json')],
  ['@happier-dev/agents', path.join(repoRootDir, 'packages/agents/package.json')],
  ['@happier-dev/cli-common', path.join(repoRootDir, 'packages/cli-common/package.json')],
  ['@happier-dev/protocol', path.join(repoRootDir, 'packages/protocol/package.json')],
  ['@happier-dev/release-runtime', path.join(repoRootDir, 'packages/release-runtime/package.json')],
]);

function topLevelEntryForPackage(packageName) {
  if (packageName.startsWith('@')) {
    const [scope, entryName] = packageName.split('/');
    return `${scope}/${entryName}`;
  }
  return packageName;
}

function packageJsonPathCandidate(baseDir, packageName) {
  if (packageName.startsWith('@')) {
    const [scope, entryName] = packageName.split('/');
    return path.join(baseDir, 'node_modules', scope, entryName, 'package.json');
  }
  return path.join(baseDir, 'node_modules', packageName, 'package.json');
}

function packageJsonPathForPackage(fromDir, packageName) {
  if (workspacePackageJsonPaths.has(packageName)) {
    return workspacePackageJsonPaths.get(packageName);
  }

  let currentDir = fromDir;
  while (true) {
    const candidatePath = packageJsonPathCandidate(currentDir, packageName);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || currentDir === repoRootDir) {
      break;
    }
    currentDir = parentDir;
  }

  const fallbackPath = packageJsonPathCandidate(repoRootDir, packageName);
  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }

  return null;
}

function addPackageClosure(fromDir, packageName) {
  const packageJsonPath = packageJsonPathForPackage(fromDir, packageName);
  if (!packageJsonPath || visitedPackageJsonPaths.has(packageJsonPath)) {
    return;
  }

  visitedPackageJsonPaths.add(packageJsonPath);
  keepEntries.add(topLevelEntryForPackage(packageName));

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const dependencyNames = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.optionalDependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {}),
  ]);
  const packageDir = path.dirname(packageJsonPath);

  for (const dependencyName of dependencyNames) {
    addPackageClosure(packageDir, dependencyName);
  }
}

const serverPackageJson = JSON.parse(fs.readFileSync(path.join(repoRootDir, 'apps/server/package.json'), 'utf8'));
for (const dependencyName of [
  ...Object.keys(serverPackageJson.dependencies || {}),
  ...Object.keys(serverPackageJson.optionalDependencies || {}),
]) {
  addPackageClosure(path.join(repoRootDir, 'apps/server'), dependencyName);
}

for (const entryName of fs.readdirSync(nodeModulesDir)) {
  const absoluteEntryPath = path.join(nodeModulesDir, entryName);
  if (entryName.startsWith('@')) {
    for (const scopedEntryName of fs.readdirSync(absoluteEntryPath)) {
      const scopedPath = path.join(absoluteEntryPath, scopedEntryName);
      if (!keepEntries.has(`${entryName}/${scopedEntryName}`)) {
        fs.rmSync(scopedPath, { recursive: true, force: true });
      }
    }
    if (fs.readdirSync(absoluteEntryPath).length === 0) {
      fs.rmSync(absoluteEntryPath, { recursive: true, force: true });
    }
    continue;
  }

  if (!keepEntries.has(entryName)) {
    fs.rmSync(absoluteEntryPath, { recursive: true, force: true });
  }
}
NODE

# Compose-backed stress runs reuse the same prepared runtime without a second copy.
FROM server-runtime AS server-stress
ENV NODE_ENV=production
ENV PORT=3005
ENV RUN_MIGRATIONS=1
RUN chmod +x /repo/apps/server/scripts/run-server.sh
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3005
CMD ["/repo/apps/server/scripts/run-server.sh"]

FROM node:${NODE_VERSION} AS server
WORKDIR /repo
RUN apt-get update \
    && apt-get install -y --no-install-recommends -o APT::Keep-Downloaded-Packages=false python3 ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=3005
ENV RUN_MIGRATIONS=1
ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=$SENTRY_RELEASE
ENV HAPPIER_RELEASE_SOURCE_SHA=$SENTRY_RELEASE
COPY --from=server-runtime --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=server-runtime --chown=node:node /repo/scripts/workspaces /repo/scripts/workspaces
COPY --from=server-runtime --chown=node:node /repo/packages/cli-common/windowsCommandInvocation.mjs /repo/packages/cli-common/windowsCommandInvocation.mjs
COPY --from=server-runtime --chown=node:node /repo/apps/server /repo/apps/server
COPY --from=server-runtime --chown=node:node /repo/packages/agents /repo/packages/agents
COPY --from=server-runtime --chown=node:node /repo/packages/brand /repo/packages/brand
COPY --from=server-runtime --chown=node:node /repo/packages/cli-common /repo/packages/cli-common
COPY --from=server-runtime --chown=node:node /repo/packages/iroh-native /repo/packages/iroh-native
COPY --from=server-runtime --chown=node:node /repo/packages/peer-mediation /repo/packages/peer-mediation
COPY --from=server-runtime --chown=node:node /repo/packages/peer-transport /repo/packages/peer-transport
COPY --from=server-runtime --chown=node:node /repo/packages/plugin-sdk /repo/packages/plugin-sdk
COPY --from=server-runtime --chown=node:node /repo/packages/plugin-ui /repo/packages/plugin-ui
COPY --from=server-runtime --chown=node:node /repo/packages/plugins/kiro /repo/packages/plugins/kiro
COPY --from=server-runtime --chown=node:node /repo/packages/plugins/review-coderabbit /repo/packages/plugins/review-coderabbit
COPY --from=server-runtime --chown=node:node /repo/packages/plugins/review-deepsec /repo/packages/plugins/review-deepsec
COPY --from=server-runtime --chown=node:node /repo/packages/privacy-kit /repo/packages/privacy-kit
COPY --from=server-runtime --chown=node:node /repo/packages/protocol /repo/packages/protocol
COPY --from=server-runtime --chown=node:node /repo/packages/release-runtime /repo/packages/release-runtime
COPY --from=server-runtime --chown=node:node /repo/packages/session-core /repo/packages/session-core
COPY --from=server-runtime --chown=node:node /repo/packages/transfers /repo/packages/transfers
COPY --from=server-runtime /repo/apps/server/scripts/run-server.sh /usr/local/bin/run-server
RUN chmod +x /usr/local/bin/run-server
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3005
CMD ["run-server"]

# Convenience: worker image variant (same bits, different defaults)
FROM server AS server-worker
ENV SERVER_ROLE=worker

# Local relay server image for source-backed release candidate upgrade QA.
FROM server AS relay-server-local-source
USER root
RUN mkdir -p /opt/happier/ui-web \
    && chown -R node:node /opt/happier
COPY --from=webapp-builder --chown=node:node /repo/apps/ui/dist /opt/happier/ui-web
ENV HAPPIER_SERVER_FLAVOR=light
ENV HAPPY_SERVER_FLAVOR=light
ENV HAPPIER_DB_PROVIDER=sqlite
ENV HAPPY_DB_PROVIDER=sqlite
ENV HAPPIER_SERVER_LIGHT_DATA_DIR=/data
ENV HAPPY_SERVER_LIGHT_DATA_DIR=/data
ENV HAPPIER_SERVER_UI_DIR=/opt/happier/ui-web
ENV HAPPIER_SERVER_UI_PREFIX=/
ENV HAPPIER_SERVER_UI_REQUIRED=1
ENV HAPPIER_SQLITE_AUTO_MIGRATE=1
USER node

# Relay server (self-host default: light + sqlite)
FROM debian:12-slim AS relay-artifacts
ARG TARGETARCH
ARG HAPPIER_RELEASE_BASE_URL="https://github.com/happier-dev/happier/releases/download"
ARG HAPPIER_RELAY_SERVER_RELEASE_TAG=""
ARG HAPPIER_RELAY_SERVER_VERSION=""
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar minisign \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/pipeline/docker/fetch-verified-release-artifact.sh /usr/local/bin/fetch-verified-release-artifact
COPY scripts/release/installers/happier-release.pub /tmp/happier-release.pub
RUN chmod +x /usr/local/bin/fetch-verified-release-artifact
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) artifact_arch="x64" ;; \
      arm64) artifact_arch="arm64" ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    fetch-verified-release-artifact \
      --base-url "$HAPPIER_RELEASE_BASE_URL" \
      --release-tag "$HAPPIER_RELAY_SERVER_RELEASE_TAG" \
      --product happier-server \
      --version "$HAPPIER_RELAY_SERVER_VERSION" \
      --os linux \
      --arch "$artifact_arch" \
      --dest /opt/happier/server \
      --pubkey /tmp/happier-release.pub; \
    rm -rf /opt/happier/server/generated/mysql-client; \
    case "$TARGETARCH" in \
      amd64) \
        find /opt/happier/server/generated/sqlite-client -name '*.node' \
            ! -name "libquery_engine-debian-openssl-3.0.x.so.node" -delete; \
        rm -rf /opt/happier/server/node_modules/@img/sharp-libvips-linuxmusl-x64 \
               /opt/happier/server/node_modules/@img/sharp-linuxmusl-x64 ;; \
      arm64) \
        find /opt/happier/server/generated/sqlite-client -name '*.node' \
            ! -name "libquery_engine-linux-arm64-openssl-3.0.x.so.node" -delete; \
        rm -rf /opt/happier/server/node_modules/@img/sharp-libvips-linuxmusl-arm64 \
               /opt/happier/server/node_modules/@img/sharp-linuxmusl-arm64 ;; \
    esac

FROM debian:12-slim AS relay-server
WORKDIR /opt/happier/server
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash happier \
    && mkdir -p /data /opt/happier/server \
    && chown -R happier:happier /data /opt/happier
COPY --from=relay-artifacts --chown=happier:happier /opt/happier/server /opt/happier/server
COPY --from=server-builder /repo/apps/server/scripts/run-server.sh /usr/local/bin/run-server
RUN chmod +x /usr/local/bin/run-server
ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=$SENTRY_RELEASE
ENV HAPPIER_RELEASE_SOURCE_SHA=$SENTRY_RELEASE
ARG SENTRY_SERVER_CENTRAL_DSN=""
ENV HAPPIER_SENTRY_CENTRAL_DSN=$SENTRY_SERVER_CENTRAL_DSN
ENV HAPPIER_SENTRY_USE_CENTRAL_DSN=1
ENV NODE_ENV=production
ENV PORT=3005
ENV HAPPIER_SERVER_FLAVOR=light
ENV HAPPY_SERVER_FLAVOR=light
ENV HAPPIER_DB_PROVIDER=sqlite
ENV HAPPY_DB_PROVIDER=sqlite
ENV HAPPIER_SERVER_LIGHT_DATA_DIR=/data
ENV HAPPY_SERVER_LIGHT_DATA_DIR=/data
ENV HAPPIER_SERVER_UI_DIR=/opt/happier/server/ui-web/current
ENV HAPPIER_SERVER_UI_PREFIX=/
ENV HAPPIER_SERVER_UI_REQUIRED=1
ENV HAPPIER_SQLITE_AUTO_MIGRATE=1
ENV HAPPIER_SQLITE_MIGRATIONS_DIR=/opt/happier/server/prisma/sqlite/migrations
ENV HAPPY_SQLITE_MIGRATIONS_DIR=/opt/happier/server/prisma/sqlite/migrations
USER happier
EXPOSE 3005
VOLUME ["/data"]
CMD ["run-server", "/opt/happier/server/happier-server"]

# Default target when building without --target
FROM server AS default
