# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
ARG BUILDPLATFORM

# Shared deps (alpine) for website/docs/webapp builds
FROM node:${NODE_VERSION}-alpine AS deps-alpine
WORKDIR /repo
RUN apk add --no-cache libc6-compat
ENV REDISMS_DISABLE_POSTINSTALL=1
ENV YARN_CACHE_FOLDER=/tmp/.yarn-cache

COPY package.json yarn.lock ./
RUN mkdir -p apps/ui apps/server apps/cli apps/website apps/docs packages/agents packages/cli-common packages/protocol packages/audio-stream-native packages/sherpa-native
COPY apps/ui/package.json apps/ui/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/website/package.json apps/website/
COPY apps/docs/package.json apps/docs/
COPY packages/agents/package.json packages/agents/
COPY packages/cli-common/package.json packages/cli-common/
COPY packages/protocol/package.json packages/protocol/
COPY packages/audio-stream-native/package.json packages/audio-stream-native/
COPY packages/sherpa-native/package.json packages/sherpa-native/

RUN yarn config set registry https://registry.npmjs.org/ \
    && is_transient_yarn_error() { \
      grep -Eq 'Request failed "(5[0-9]{2}|429)' "$1" && return 0; \
      grep -Eq 'EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up' "$1" && return 0; \
      return 1; \
    }; \
    for attempt in 1 2 3; do \
      if yarn install --frozen-lockfile --ignore-engines > /tmp/yarn-install.log 2>&1; then \
        cat /tmp/yarn-install.log; \
        break; \
      fi; \
      if is_transient_yarn_error /tmp/yarn-install.log; then \
        cat /tmp/yarn-install.log; \
        if [ "$attempt" -lt 3 ]; then \
          echo "yarn install failed due to transient network/registry issue (attempt ${attempt}/3), retrying..."; \
          sleep 5; \
          continue; \
        fi; \
        echo "yarn install failed with repeated transient network/registry failures after ${attempt} attempts." >&2; \
        exit 1; \
      fi; \
      cat /tmp/yarn-install.log >&2; \
      echo "yarn install failed with a non-transient error (attempt ${attempt}); not retrying." >&2; \
      exit 1; \
    done

# Shared deps (alpine) for web UI export embeds.
# We build the web export on the BUILDPLATFORM because the output is architecture-agnostic, and
# running Node/Yarn under QEMU for linux/arm64 has proven unstable (SIGILL).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS deps-alpine-build
WORKDIR /repo
RUN apk add --no-cache libc6-compat
ENV REDISMS_DISABLE_POSTINSTALL=1
ENV YARN_CACHE_FOLDER=/tmp/.yarn-cache

COPY package.json yarn.lock ./
RUN mkdir -p apps/ui apps/server apps/cli apps/website apps/docs packages/agents packages/cli-common packages/protocol packages/audio-stream-native packages/sherpa-native
COPY apps/ui/package.json apps/ui/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/website/package.json apps/website/
COPY apps/docs/package.json apps/docs/
COPY packages/agents/package.json packages/agents/
COPY packages/cli-common/package.json packages/cli-common/
COPY packages/protocol/package.json packages/protocol/
COPY packages/audio-stream-native/package.json packages/audio-stream-native/
COPY packages/sherpa-native/package.json packages/sherpa-native/

RUN yarn config set registry https://registry.npmjs.org/ \
    && is_transient_yarn_error() { \
      grep -Eq 'Request failed "(5[0-9]{2}|429)' "$1" && return 0; \
      grep -Eq 'EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up' "$1" && return 0; \
      return 1; \
    }; \
    for attempt in 1 2 3; do \
      if yarn install --frozen-lockfile --ignore-engines > /tmp/yarn-install.log 2>&1; then \
        cat /tmp/yarn-install.log; \
        break; \
      fi; \
      if is_transient_yarn_error /tmp/yarn-install.log; then \
        cat /tmp/yarn-install.log; \
        if [ "$attempt" -lt 3 ]; then \
          echo "yarn install failed due to transient network/registry issue (attempt ${attempt}/3), retrying..."; \
          sleep 5; \
          continue; \
        fi; \
        echo "yarn install failed with repeated transient network/registry failures after ${attempt} attempts." >&2; \
        exit 1; \
      fi; \
      cat /tmp/yarn-install.log >&2; \
      echo "yarn install failed with a non-transient error (attempt ${attempt}); not retrying." >&2; \
      exit 1; \
    done

# Shared deps (debian) for server builds (needs toolchain for native deps)
FROM node:${NODE_VERSION} AS deps-debian
RUN apt-get update && apt-get install -y python3 ffmpeg make g++ build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV REDISMS_DISABLE_POSTINSTALL=1
ENV YARN_CACHE_FOLDER=/tmp/.yarn-cache

COPY package.json yarn.lock ./
RUN mkdir -p apps/ui apps/server apps/cli apps/website apps/docs packages/agents packages/cli-common packages/protocol packages/audio-stream-native packages/sherpa-native
COPY apps/ui/package.json apps/ui/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/website/package.json apps/website/
COPY apps/docs/package.json apps/docs/
COPY packages/agents/package.json packages/agents/
COPY packages/cli-common/package.json packages/cli-common/
COPY packages/protocol/package.json packages/protocol/
COPY packages/audio-stream-native/package.json packages/audio-stream-native/
COPY packages/sherpa-native/package.json packages/sherpa-native/

RUN yarn config set registry https://registry.npmjs.org/ \
    && is_transient_yarn_error() { \
      grep -Eq 'Request failed "(5[0-9]{2}|429)' "$1" && return 0; \
      grep -Eq 'EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up' "$1" && return 0; \
      return 1; \
    }; \
    for attempt in 1 2 3; do \
      if yarn install --frozen-lockfile --ignore-engines > /tmp/yarn-install.log 2>&1; then \
        cat /tmp/yarn-install.log; \
        break; \
      fi; \
      if is_transient_yarn_error /tmp/yarn-install.log; then \
        cat /tmp/yarn-install.log; \
        if [ "$attempt" -lt 3 ]; then \
          echo "yarn install failed due to transient network/registry issue (attempt ${attempt}/3), retrying..."; \
          sleep 5; \
          continue; \
        fi; \
        echo "yarn install failed with repeated transient network/registry failures after ${attempt} attempts." >&2; \
        exit 1; \
      fi; \
      cat /tmp/yarn-install.log >&2; \
      echo "yarn install failed with a non-transient error (attempt ${attempt}); not retrying." >&2; \
      exit 1; \
    done

#
# Targets
#

# Website (Vite static)
FROM deps-alpine AS website-builder
ARG WEBSITE_VARIANT=prerelease
COPY apps/website ./apps/website
RUN test -f "apps/website/index.${WEBSITE_VARIANT}.html" && cp "apps/website/index.${WEBSITE_VARIANT}.html" "apps/website/index.html"
RUN yarn workspace @happier-dev/website build

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
ARG REVENUE_CAT_STRIPE=""

ENV NODE_ENV=production
ENV APP_ENV=production
ENV EXPO_PUBLIC_POSTHOG_API_KEY=$POSTHOG_API_KEY
ENV EXPO_PUBLIC_REVENUE_CAT_STRIPE=$REVENUE_CAT_STRIPE
ENV HAPPIER_EMBEDDED_POLICY_ENV=$HAPPIER_EMBEDDED_POLICY_ENV

COPY .github/feature-policy ./.github/feature-policy
COPY apps/ui ./apps/ui
COPY packages/agents ./packages/agents
COPY packages/protocol ./packages/protocol

RUN yarn workspace @happier-dev/protocol postinstall:real && yarn workspace @happier-dev/agents postinstall:real
RUN yarn workspace @happier-dev/app postinstall:real
RUN rm -rf apps/ui/dist
RUN yarn workspace @happier-dev/app expo export --platform web --output-dir dist

FROM nginxinc/nginx-unprivileged:alpine AS webapp
USER root
RUN apk add --no-cache curl
COPY --from=webapp-builder /repo/apps/ui/dist /usr/share/nginx/html
RUN rm /etc/nginx/conf.d/default.conf
RUN echo 'server { \
    listen 8080; \
    \
    location = /health { \
        return 200 "ok\n"; \
    } \
    \
    location /_expo/ { \
        root   /usr/share/nginx/html; \
        add_header Cache-Control "public, max-age=31536000, immutable"; \
        try_files $uri =404; \
    } \
    \
    location /assets/ { \
        root   /usr/share/nginx/html; \
        add_header Cache-Control "public, max-age=31536000, immutable"; \
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
RUN yarn workspace docs postinstall:real && yarn workspace docs build

FROM node:${NODE_VERSION}-alpine AS docs
WORKDIR /repo
RUN apk add --no-cache libc6-compat curl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
COPY --from=docs-builder /repo/node_modules /repo/node_modules
COPY --from=docs-builder /repo/apps/docs /repo/apps/docs
EXPOSE 3000
CMD ["yarn", "--cwd", "apps/docs", "start"]

# Server
FROM deps-debian AS server-builder
ARG HAPPIER_EMBEDDED_POLICY_ENV=preview
ARG HAPPIER_BUILD_DB_PROVIDERS=""
ENV HAPPIER_BUILD_DB_PROVIDERS=$HAPPIER_BUILD_DB_PROVIDERS
ENV HAPPIER_EMBEDDED_POLICY_ENV=$HAPPIER_EMBEDDED_POLICY_ENV
COPY .github/feature-policy ./.github/feature-policy
COPY apps/server ./apps/server
COPY packages/agents ./packages/agents
COPY packages/protocol ./packages/protocol
RUN yarn workspace @happier-dev/protocol postinstall:real && yarn workspace @happier-dev/agents postinstall:real
RUN yarn workspace @happier-dev/server postinstall:real
RUN yarn workspace @happier-dev/server build

FROM node:${NODE_VERSION} AS server
WORKDIR /repo
RUN apt-get update && apt-get install -y python3 ffmpeg curl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=3005
ENV RUN_MIGRATIONS=1
COPY --from=server-builder --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=server-builder --chown=node:node /repo/packages/agents /repo/packages/agents
COPY --from=server-builder --chown=node:node /repo/packages/protocol /repo/packages/protocol
COPY --from=server-builder --chown=node:node /repo/apps/server /repo/apps/server
COPY --from=server-builder /repo/apps/server/scripts/run-server.sh /usr/local/bin/run-server
RUN chmod +x /usr/local/bin/run-server
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3005
CMD ["run-server"]

# Convenience: worker image variant (same bits, different defaults)
FROM server AS server-worker
ENV SERVER_ROLE=worker

# Relay server (self-host default: light + sqlite)
FROM server AS relay-server
# Embed the web UI bundle so self-hosted deployments can serve UI from the server.
# Disable at runtime by clearing HAPPIER_SERVER_UI_DIR (e.g. `-e HAPPIER_SERVER_UI_DIR=`).
COPY --from=webapp-builder --chown=node:node /repo/apps/ui/dist /repo/apps/ui/dist
ENV HAPPIER_SERVER_FLAVOR=light
ENV HAPPY_SERVER_FLAVOR=light
ENV HAPPIER_DB_PROVIDER=sqlite
ENV HAPPY_DB_PROVIDER=sqlite
ENV HAPPIER_SERVER_LIGHT_DATA_DIR=/data
ENV HAPPY_SERVER_LIGHT_DATA_DIR=/data
ENV HAPPIER_SERVER_UI_DIR=/repo/apps/ui/dist
ENV HAPPIER_SERVER_UI_PREFIX=/
ENV HAPPIER_SERVER_UI_REQUIRED=1
VOLUME ["/data"]

# Default target when building without --target
FROM server AS default
