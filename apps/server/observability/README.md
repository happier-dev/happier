# Happier Server Observability Pack

This folder contains the repo-owned Prometheus, Grafana, and Alertmanager pack for self-hosted Happier Server deployments.

It is designed for Docker and Dokploy-style deployments where:

- your Happier API and worker run as separate containers
- each process exposes `/metrics`
- Prometheus scrapes each API replica and each worker directly
- Grafana reads from Prometheus
- Alertmanager receives Prometheus alerts

## Included components

- `docker-compose.yml`
  - launches Prometheus, Grafana, and Alertmanager
- `prometheus/prometheus.yml`
  - scrape and rule-loading configuration
- `prometheus/targets/*.yml`
  - editable scrape target lists for API and worker processes
- `prometheus/rules/happier-server-alerts.yml`
  - baseline alert rules for RPC, HTTP latency, DB saturation, presence, and runtime health
- `grafana/provisioning/**`
  - datasource and dashboard provisioning
- `grafana/dashboards/*.json`
  - four provisioned Happier dashboards
- `alertmanager/alertmanager.yml`
  - safe local default that stores alerts but does not send notifications until you add a receiver

## Quick start

1. Copy the env template:

   ```bash
   cp apps/server/observability/.env.example apps/server/observability/.env
   ```

2. Ensure your Happier API and worker containers:

   - run on the same Docker network named by `HAPPIER_OBSERVABILITY_TARGET_NETWORK`
   - expose `METRICS_ENABLED=true`
   - expose `METRICS_PORT=9090`

3. Edit scrape targets if your service names differ from the defaults:

   - `prometheus/targets/happier-api.yml`
   - `prometheus/targets/happier-worker.yml`

4. Start the observability stack:

   ```bash
   docker compose \
     --env-file apps/server/observability/.env \
     -f apps/server/observability/docker-compose.yml \
     up -d
   ```

5. Open Grafana at `http://127.0.0.1:${HAPPIER_GRAFANA_HOST_PORT}` and log in with the configured admin credentials.

6. Stop the observability stack when you are done:

   ```bash
   docker compose \
     --env-file apps/server/observability/.env \
     -f apps/server/observability/docker-compose.yml \
     down
   ```

## Important operational notes

- Scrape each API replica and each worker directly. Do not scrape only the public load balancer.
- Keep Prometheus and Alertmanager bound to localhost unless you intentionally place them behind an authenticated reverse proxy.
- The bundled Alertmanager config is safe by default: it accepts alerts but does not forward them anywhere until you add a real receiver.
- Sticky sessions are still required for browser clients when polling fallback is enabled on the Happier server.
- Reverse proxy idle timeout must be greater than `pingInterval + pingTimeout`. The current server defaults require more than `60s`; use a higher timeout such as several minutes.
- The bundled dashboards and alerts prefer the canonical `websocket_connections_active` gauge and the Redis consumer-group backlog metric `presence_stream_redis_pending_entries`, while still preserving the legacy compatibility gauges in the server runtime.
- Prometheus/Grafana cover server metrics, Sentry remains the error/tracing surface, and PostHog remains the product analytics surface.

## Dokploy note

In Dokploy, deploy this folder as a separate Compose app or service group on the same internal Docker network as your Happier API/worker containers. Then point the target files at the internal service names that Dokploy assigns to your API and worker services.
