# Use the upstream relay binary built from the same Iroh release line as the
# native core. The version is intentionally explicit; floating tags are not
# acceptable for a self-hosted networking artifact.
ARG IROH_RELAY_VERSION=1.1.0
FROM ghcr.io/n0-computer/iroh-relay:${IROH_RELAY_VERSION}
COPY relay.toml /etc/iroh/relay.toml
ENTRYPOINT ["/usr/local/bin/iroh-relay", "--config", "/etc/iroh/relay.toml"]
