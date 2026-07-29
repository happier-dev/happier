import type { StressComposeConfig } from '../config/stressScenarioSchema';

export type StressComposeSecrets = Readonly<{
  postgresDb: string;
  postgresUser: string;
  postgresPassword: string;
  masterSecret: string;
  minioAccessKey: string;
  minioSecretKey: string;
  s3Bucket: string;
}>;

export type StressComposePeerMediation = Readonly<{
  allowedPorts: readonly number[];
  routeGrantSigningKeyId: string;
  routeGrantSigningPrivateKey: string;
  routeGrantSigningPublicKey: string;
  routeGrantSigningExpiresAt: string;
}>;

export function renderStressComposeYaml(params: {
  repoRootDir: string;
  repoRootFingerprint: string;
  composeDir: string;
  serverImageName: string;
  gatewayConfigPath: string;
  publicBaseUrl: string;
  config: StressComposeConfig;
  secrets: StressComposeSecrets;
  peerMediation: StressComposePeerMediation;
}): string {
  const {
    repoRootDir,
    repoRootFingerprint,
    composeDir,
    serverImageName,
    gatewayConfigPath,
    publicBaseUrl,
    config,
    secrets,
    peerMediation,
  } = params;
  const frontDoorMode = config.frontDoorMode ?? 'gateway';
  const metricsEnabled = config.metricsEnabled ? '"1"' : '"false"';
  const authLoginEligibilityAccountSnapshotCacheTtlMs =
    typeof config.authLoginEligibilityAccountSnapshotCacheTtlMs === 'number'
      ? `\n      AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "${config.authLoginEligibilityAccountSnapshotCacheTtlMs}"`
      : '';
  const stressLabels = `    labels:
      happier.stress.owner: stress-harness
      happier.stress.repo-root: ${repoRootFingerprint}`;
  const apiDirectService = frontDoorMode === 'api-direct'
    ? `
  api-direct:
    image: ${serverImageName}
${stressLabels}
    environment:
      PORT: "53288"
      SERVER_ROLE: api
      HAPPIER_SERVER_FLAVOR: full
      HAPPIER_DB_PROVIDER: postgres
      DATABASE_URL: postgres://${secrets.postgresUser}:${secrets.postgresPassword}@postgres:5432/${secrets.postgresDb}
      HAPPIER_DB_CONNECTION_LIMIT: "${config.dbConnectionLimit ?? ''}"
      REDIS_URL: redis://redis:6379
      HAPPIER_SOCKET_ADAPTER: redis-streams
      HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: "5"
      HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1"
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1"
      HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "${peerMediation.allowedPorts.join(',')}"
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: ${peerMediation.routeGrantSigningKeyId}
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: ${peerMediation.routeGrantSigningPrivateKey}
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: ${peerMediation.routeGrantSigningPublicKey}
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: ${peerMediation.routeGrantSigningExpiresAt}
      HANDY_MASTER_SECRET: ${secrets.masterSecret}
      HAPPIER_FILES_BACKEND: ${config.filesBackend}
      S3_HOST: minio
      S3_PORT: "9000"
      S3_USE_SSL: "false"
      S3_REGION: us-east-1
      S3_BUCKET: ${secrets.s3Bucket}
      S3_ACCESS_KEY: ${secrets.minioAccessKey}
      S3_SECRET_KEY: ${secrets.minioSecretKey}
      S3_PUBLIC_URL: ${publicBaseUrl}/files
      HAPPIER_SERVER_TRUST_PROXY: "1"
${authLoginEligibilityAccountSnapshotCacheTtlMs}
      METRICS_ENABLED: ${metricsEnabled}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:53288/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 5s
    ports:
      - "127.0.0.1:${config.apiDirectPort ?? 43081}:53288"
`
    : '';
  return `services:
  postgres:
    image: postgres:16-alpine
${stressLabels}
    environment:
      POSTGRES_DB: ${secrets.postgresDb}
      POSTGRES_USER: ${secrets.postgresUser}
      POSTGRES_PASSWORD: ${secrets.postgresPassword}
    ports:
      - "127.0.0.1:${config.postgresPort ?? 45432}:5432"
    volumes:
      - "${composeDir}/postgres:/var/lib/postgresql/data"
    healthcheck:
      test: ["CMD-SHELL", "test \\"$(head -n 1 \\"$$PGDATA/postmaster.pid\\" 2>/dev/null)\\" = \\"1\\" && pg_isready -U ${secrets.postgresUser} -d ${secrets.postgresDb}"]
      interval: 2s
      timeout: 3s
      retries: 30

  redis:
    image: redis:7-alpine
${stressLabels}
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]
    ports:
      - "127.0.0.1:${config.redisPort ?? 46379}:6379"
    volumes:
      - "${composeDir}/redis:/data"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 30

  minio:
    image: minio/minio:latest
${stressLabels}
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: ${secrets.minioAccessKey}
      MINIO_ROOT_PASSWORD: ${secrets.minioSecretKey}
    ports:
      - "127.0.0.1:${config.minioPort ?? 49000}:9000"
      - "127.0.0.1:${config.minioConsolePort ?? 49001}:9001"
    volumes:
      - "${composeDir}/minio:/data"

  minio-init:
    image: minio/mc:latest
${stressLabels}
    depends_on:
      - minio
    entrypoint: ["/bin/sh"]
    command:
      - "-lc"
      - >-
        until mc alias set local http://minio:9000 ${secrets.minioAccessKey} ${secrets.minioSecretKey}; do sleep 1; done; until mc ready local; do sleep 1; done; mc mb -p local/${secrets.s3Bucket} || true; mc anonymous set download local/${secrets.s3Bucket} || true
    restart: "no"

  api:
    image: ${serverImageName}
${stressLabels}
    build:
      context: ${repoRootDir}
      dockerfile: Dockerfile
      target: server-stress
    environment:
      PORT: "53288"
      SERVER_ROLE: api
      HAPPIER_SERVER_FLAVOR: full
      HAPPIER_DB_PROVIDER: postgres
      DATABASE_URL: postgres://${secrets.postgresUser}:${secrets.postgresPassword}@postgres:5432/${secrets.postgresDb}
      HAPPIER_DB_CONNECTION_LIMIT: "${config.dbConnectionLimit ?? ''}"
      REDIS_URL: redis://redis:6379
      HAPPIER_SOCKET_ADAPTER: redis-streams
      HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: "5"
      HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1"
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1"
      HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "${peerMediation.allowedPorts.join(',')}"
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: ${peerMediation.routeGrantSigningKeyId}
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: ${peerMediation.routeGrantSigningPrivateKey}
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: ${peerMediation.routeGrantSigningPublicKey}
      HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: ${peerMediation.routeGrantSigningExpiresAt}
      HANDY_MASTER_SECRET: ${secrets.masterSecret}
      HAPPIER_FILES_BACKEND: ${config.filesBackend}
      S3_HOST: minio
      S3_PORT: "9000"
      S3_USE_SSL: "false"
      S3_REGION: us-east-1
      S3_BUCKET: ${secrets.s3Bucket}
      S3_ACCESS_KEY: ${secrets.minioAccessKey}
      S3_SECRET_KEY: ${secrets.minioSecretKey}
      S3_PUBLIC_URL: ${publicBaseUrl}/files
      HAPPIER_SERVER_TRUST_PROXY: "1"
${authLoginEligibilityAccountSnapshotCacheTtlMs}
      METRICS_ENABLED: ${metricsEnabled}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:53288/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 5s
    expose:
      - "53288"

  worker:
    image: ${serverImageName}
${stressLabels}
    environment:
      PORT: "53288"
      SERVER_ROLE: worker
      HAPPIER_SERVER_FLAVOR: full
      HAPPIER_DB_PROVIDER: postgres
      DATABASE_URL: postgres://${secrets.postgresUser}:${secrets.postgresPassword}@postgres:5432/${secrets.postgresDb}
      HAPPIER_DB_CONNECTION_LIMIT: "${config.dbConnectionLimit ?? ''}"
      REDIS_URL: redis://redis:6379
      HAPPIER_SOCKET_ADAPTER: redis-streams
      HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1"
      HANDY_MASTER_SECRET: ${secrets.masterSecret}
      HAPPIER_FILES_BACKEND: ${config.filesBackend}
      S3_HOST: minio
      S3_PORT: "9000"
      S3_USE_SSL: "false"
      S3_REGION: us-east-1
      S3_BUCKET: ${secrets.s3Bucket}
      S3_ACCESS_KEY: ${secrets.minioAccessKey}
      S3_SECRET_KEY: ${secrets.minioSecretKey}
      S3_PUBLIC_URL: ${publicBaseUrl}/files
${authLoginEligibilityAccountSnapshotCacheTtlMs}
      METRICS_ENABLED: ${metricsEnabled}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully
    expose:
      - "53288"
${apiDirectService}

  gateway:
    image: nginx:1.27-alpine
${stressLabels}
    depends_on:
      - api
    ports:
      - "127.0.0.1:${config.gatewayPort ?? 43080}:8080"
    volumes:
      - "${gatewayConfigPath}:/etc/nginx/nginx.conf:ro"
`;
}
