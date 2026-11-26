FROM node:24-bookworm
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    procps \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Monorepo uses Yarn classic.
RUN corepack enable && corepack prepare yarn@1.22.22 --activate

WORKDIR /work

COPY bin/ /opt/happier-npm-e2e/bin/
