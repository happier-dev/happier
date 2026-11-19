FROM node:22.14.0-bookworm-slim AS build
WORKDIR /fixture
RUN npm install --no-audit --no-fund --no-save esbuild@0.28.2
COPY browserChecks.js ./browserChecks.js
RUN ./node_modules/.bin/esbuild browserChecks.js --minify --sourcemap=external --outfile=public/browserChecks.min.js

FROM node:22.14.0-bookworm-slim
WORKDIR /fixture
ARG FIXTURE_APP_REVISION
RUN test -n "$FIXTURE_APP_REVISION"
ENV FIXTURE_APP_REVISION=$FIXTURE_APP_REVISION
LABEL org.opencontainers.image.revision=$FIXTURE_APP_REVISION
COPY server.mjs route.mjs index.html browser.js ./
COPY --from=build /fixture/public ./public
EXPOSE 3000
CMD ["node", "server.mjs"]
