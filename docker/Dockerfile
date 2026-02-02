# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

# Shared deps (alpine) for website/docs/webapp builds
FROM node:${NODE_VERSION}-alpine AS deps-alpine
WORKDIR /repo
RUN apk add --no-cache libc6-compat

COPY package.json yarn.lock ./
RUN mkdir -p apps/ui apps/server apps/cli apps/website apps/docs packages/agents packages/protocol
COPY apps/ui/package.json apps/ui/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/website/package.json apps/website/
COPY apps/docs/package.json apps/docs/
COPY packages/agents/package.json packages/agents/
COPY packages/protocol/package.json packages/protocol/

RUN yarn install --frozen-lockfile --ignore-engines

# Shared deps (debian) for server builds (needs toolchain for native deps)
FROM node:${NODE_VERSION} AS deps-debian
RUN apt-get update && apt-get install -y python3 ffmpeg make g++ build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

COPY package.json yarn.lock ./
RUN mkdir -p apps/ui apps/server apps/cli apps/website apps/docs packages/agents packages/protocol
COPY apps/ui/package.json apps/ui/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/website/package.json apps/website/
COPY apps/docs/package.json apps/docs/
COPY packages/agents/package.json packages/agents/
COPY packages/protocol/package.json packages/protocol/

RUN yarn install --frozen-lockfile --ignore-engines

#
# Targets
#

# Website (Vite static)
FROM deps-alpine AS website-builder
COPY apps/website ./apps/website
RUN yarn workspace @happier-dev/website build

FROM nginx:alpine AS website
COPY --from=website-builder /repo/apps/website/dist /usr/share/nginx/html
RUN rm /etc/nginx/conf.d/default.conf
RUN echo 'server { \
    listen 80; \
    server_name _; \
    root /usr/share/nginx/html; \
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
EXPOSE 80

# Webapp (Expo export static)
FROM deps-alpine AS webapp-builder
ARG POSTHOG_API_KEY=""
ARG REVENUE_CAT_STRIPE=""

ENV NODE_ENV=production
ENV APP_ENV=production
ENV EXPO_PUBLIC_POSTHOG_API_KEY=$POSTHOG_API_KEY
ENV EXPO_PUBLIC_REVENUE_CAT_STRIPE=$REVENUE_CAT_STRIPE

COPY apps/ui ./apps/ui
COPY packages/agents ./packages/agents
COPY packages/protocol ./packages/protocol

RUN yarn workspace @happier-dev/agents postinstall:real && yarn workspace @happier-dev/protocol postinstall:real
RUN yarn workspace @happier-dev/app postinstall:real
RUN yarn workspace @happier-dev/app expo export --platform web --output-dir dist

FROM nginx:alpine AS webapp
COPY --from=webapp-builder /repo/apps/ui/dist /usr/share/nginx/html
RUN rm /etc/nginx/conf.d/default.conf
RUN echo 'server { \
    listen 80; \
    \
    location /_expo/ { \
        root   /usr/share/nginx/html; \
        try_files $uri =404; \
    } \
    \
    location /assets/ { \
        root   /usr/share/nginx/html; \
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
EXPOSE 80

# Docs (Next.js)
FROM deps-alpine AS docs-builder
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/docs ./apps/docs
RUN yarn workspace docs postinstall:real && yarn workspace docs build

FROM node:${NODE_VERSION}-alpine AS docs
WORKDIR /repo
RUN apk add --no-cache libc6-compat
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
COPY --from=docs-builder /repo/node_modules /repo/node_modules
COPY --from=docs-builder /repo/apps/docs /repo/apps/docs
EXPOSE 3000
CMD ["yarn", "--cwd", "apps/docs", "start"]

# Server
FROM deps-debian AS server-builder
COPY apps/server ./apps/server
COPY packages/agents ./packages/agents
COPY packages/protocol ./packages/protocol
RUN yarn workspace @happier-dev/agents postinstall:real && yarn workspace @happier-dev/protocol postinstall:real
RUN yarn workspace @happier-dev/server postinstall:real
RUN yarn workspace @happier-dev/server build

FROM node:${NODE_VERSION} AS server
WORKDIR /repo
RUN apt-get update && apt-get install -y python3 ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=server-builder /repo/node_modules /repo/node_modules
COPY --from=server-builder /repo/apps/server /repo/apps/server
EXPOSE 3000
CMD ["sh", "-lc", "yarn --cwd apps/server prisma migrate deploy && exec yarn --cwd apps/server start"]

