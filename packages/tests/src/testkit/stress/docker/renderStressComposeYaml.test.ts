import { describe, expect, it } from 'vitest';

import { renderStressComposeYaml } from './renderStressComposeYaml';

describe('renderStressComposeYaml', () => {
  it('renders the canonical full-compose services and expected runtime env', () => {
    const yaml = renderStressComposeYaml({
      repoRootDir: '/repo/root',
      composeDir: '/tmp/run/topology',
      serverImageName: 'happier-stress-test-server',
      gatewayConfigPath: '/tmp/run/topology/nginx.conf',
      publicBaseUrl: 'http://127.0.0.1:43080',
      repoRootFingerprint: 'repo-fingerprint',
      secrets: {
        postgresDb: 'stressdb',
        postgresUser: 'stress',
        postgresPassword: 'secret-pg',
        masterSecret: 'secret-master',
        minioAccessKey: 'minio-user',
        minioSecretKey: 'minio-secret',
        s3Bucket: 'stress-bucket',
      },
      peerMediation: {
        allowedPorts: [3000],
        routeGrantSigningKeyId: 'stress-route-key',
        routeGrantSigningPrivateKey: 'stress-private-seed',
        routeGrantSigningPublicKey: 'stress-public-key',
        routeGrantSigningExpiresAt: '2099-01-01T00:00:00.000Z',
      },
      config: {
        apiReplicas: 3,
        workerReplicas: 2,
        imageBuildStrategy: 'if-missing',
        reuseRunningTopology: false,
        frontDoorMode: 'api-direct',
        gatewayWorkerConnections: 16384,
        gatewayWorkerRlimitNoFile: 65535,
        gatewayPort: 43080,
        apiDirectPort: 43081,
        postgresPort: 45432,
        redisPort: 46379,
        minioPort: 49000,
        minioConsolePort: 49001,
        dbConnectionLimit: 4,
        authLoginEligibilityAccountSnapshotCacheTtlMs: 60000,
        metricsEnabled: true,
        filesBackend: 's3',
      },
    });

    expect(yaml).toContain('postgres:');
    expect(yaml).toContain('redis:');
    expect(yaml).toContain('minio:');
    expect(yaml).toContain('minio-init:');
    expect(yaml).toContain('api:');
    expect(yaml).toContain('worker:');
    expect(yaml).toContain('gateway:');
    expect(yaml).toContain('api-direct:');
    expect(yaml).toContain('image: happier-stress-test-server');
    expect(yaml).toContain('SERVER_ROLE: api');
    expect(yaml).toContain('SERVER_ROLE: worker');
    expect(yaml).toContain('HAPPIER_SERVER_FLAVOR: full');
    expect(yaml).toContain('HAPPIER_SOCKET_ADAPTER: redis-streams');
    expect(yaml.match(/HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: "5"/g)).toHaveLength(2);
    expect(yaml).toContain('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1"');
    expect(yaml).toContain('HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: "1"');
    expect(yaml).toContain('HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: "3000"');
    expect(yaml).toContain('HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: stress-route-key');
    expect(yaml).toContain('HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: stress-private-seed');
    expect(yaml).toContain('HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: stress-public-key');
    expect(yaml).toContain('HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: 2099-01-01T00:00:00.000Z');
    expect(yaml).toContain('HAPPIER_FILES_BACKEND: s3');
    expect(yaml).toContain('S3_ACCESS_KEY: minio-user');
    expect(yaml).toContain('S3_SECRET_KEY: minio-secret');
    expect(yaml).not.toContain('S3_ACCESS_KEY_ID:');
    expect(yaml).not.toContain('S3_SECRET_ACCESS_KEY:');
    expect(yaml).toContain('S3_PUBLIC_URL: http://127.0.0.1:43080/files');
    expect(yaml).toContain('HAPPIER_SERVER_TRUST_PROXY: "1"');
    expect(yaml).toContain('HAPPIER_DB_CONNECTION_LIMIT: "4"');
    expect(yaml).toContain('AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: "60000"');
    expect(yaml).toContain('METRICS_ENABLED: "1"');
    expect(yaml).toContain('labels:');
    expect(yaml).toContain('happier.stress.owner: stress-harness');
    expect(yaml).toContain('happier.stress.repo-root: repo-fingerprint');
    expect(yaml).toContain('healthcheck:');
    expect(yaml).toContain('head -n 1 \\"$$PGDATA/postmaster.pid\\"');
    expect(yaml).toContain('= \\"1\\" && pg_isready -U stress -d stressdb');
    expect(yaml).toContain('http://127.0.0.1:53288/health');
    expect(yaml).toContain('127.0.0.1:43080:8080');
    expect(yaml).toContain('127.0.0.1:43081:53288');
    expect(yaml).toContain('/tmp/run/topology/nginx.conf:/etc/nginx/nginx.conf:ro');
    expect(yaml).toContain('entrypoint: ["/bin/sh"]');
    expect(yaml).toContain('- "-lc"');
    expect(yaml).toContain('until mc alias set local http://minio:9000 minio-user minio-secret; do sleep 1; done; until mc ready local; do sleep 1; done; mc mb -p local/stress-bucket || true; mc anonymous set download local/stress-bucket || true');
    expect(yaml.match(/build:\n      context: \/repo\/root\n      dockerfile: Dockerfile\n      target: server-stress/g)?.length).toBe(1);
  });
});
