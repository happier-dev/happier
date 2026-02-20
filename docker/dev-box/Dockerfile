# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm AS cli-builder
WORKDIR /repo

# Build deps for native modules used by the CLI toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV REDISMS_DISABLE_POSTINSTALL=1
ENV YARN_CACHE_FOLDER=/tmp/.yarn-cache

COPY package.json yarn.lock ./
RUN mkdir -p apps/cli apps/stack packages/agents packages/cli-common packages/protocol packages/release-runtime
COPY apps/cli/package.json apps/cli/
COPY apps/stack/package.json apps/stack/
COPY packages/agents/package.json packages/agents/
COPY packages/cli-common/package.json packages/cli-common/
COPY packages/protocol/package.json packages/protocol/
COPY packages/release-runtime/package.json packages/release-runtime/

COPY docker/scripts/yarn-install-with-retry.sh /usr/local/bin/yarn-install-with-retry
RUN chmod +x /usr/local/bin/yarn-install-with-retry

RUN --mount=type=cache,target=/tmp/.yarn-cache,sharing=locked \
    yarn config set registry https://registry.npmjs.org/ \
    && yarn-install-with-retry --frozen-lockfile --ignore-engines --network-timeout 600000 --prefer-offline --non-interactive

COPY packages/agents ./packages/agents
COPY packages/cli-common ./packages/cli-common
COPY packages/protocol ./packages/protocol
COPY packages/release-runtime ./packages/release-runtime
COPY apps/cli ./apps/cli
COPY apps/stack ./apps/stack

RUN yarn workspace @happier-dev/protocol postinstall:real \
	  && yarn workspace @happier-dev/agents postinstall:real \
	  && yarn workspace @happier-dev/release-runtime postinstall:real \
	  && yarn workspace @happier-dev/cli build

FROM node:${NODE_VERSION}-bookworm AS devbox

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    curl \
    ca-certificates \
    python3 \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Copy the built CLI + workspace deps (node_modules contains workspace symlinks).
WORKDIR /repo
COPY --from=cli-builder /repo/package.json /repo/package.json
COPY --from=cli-builder /repo/yarn.lock /repo/yarn.lock
COPY --from=cli-builder /repo/node_modules /repo/node_modules
COPY --from=cli-builder /repo/packages/agents /repo/packages/agents
COPY --from=cli-builder /repo/packages/cli-common /repo/packages/cli-common
COPY --from=cli-builder /repo/packages/protocol /repo/packages/protocol
COPY --from=cli-builder /repo/packages/release-runtime /repo/packages/release-runtime
COPY --from=cli-builder /repo/apps/cli /repo/apps/cli
COPY --from=cli-builder /repo/apps/stack /repo/apps/stack

RUN chmod +x /repo/apps/cli/bin/happier.mjs /repo/apps/cli/bin/happier-mcp.mjs \
  && ln -sf /repo/apps/cli/bin/happier.mjs /usr/local/bin/happier \
  && ln -sf /repo/apps/cli/bin/happier-mcp.mjs /usr/local/bin/happier-mcp

RUN chmod +x /repo/apps/stack/bin/hstack.mjs \
  && ln -sf /repo/apps/stack/bin/hstack.mjs /usr/local/bin/hstack

# Non-root user for better UX and safer default permissions.
RUN useradd -m -s /bin/bash happier
ENV NPM_CONFIG_PREFIX=/home/happier/.npm-global
ENV PATH=/home/happier/.npm-global/bin:$PATH

COPY docker/dev-box/entrypoint.sh /usr/local/bin/happier-dev-box-entrypoint
RUN chmod +x /usr/local/bin/happier-dev-box-entrypoint \
  && mkdir -p /home/happier/.npm-global \
  && chown -R happier:happier /home/happier/.npm-global

USER happier
WORKDIR /workspace

ENTRYPOINT ["happier-dev-box-entrypoint"]
CMD ["bash"]
