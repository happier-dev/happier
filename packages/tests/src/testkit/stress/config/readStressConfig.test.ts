import { describe, expect, it } from 'vitest';

import { withEnvOverrides } from '../../env';
import { readStressConfig } from './readStressConfig';

describe('readStressConfig', () => {
  it('defaults to light mode with legacy stress aliases wired through the canonical reader', async () => {
    await withEnvOverrides(
      {
        HAPPIER_STRESS_TARGET_MODE: undefined,
        HAPPIER_E2E_REPEAT: '7',
        HAPPIER_E2E_SEED: '1234',
        HAPPIER_E2E_FLAKE_RETRY: '1',
      },
      async () => {
        const config = readStressConfig();

        expect(config.targetMode).toBe('light');
        expect(config.repeat).toBe(7);
        expect(config.seed).toBe(1234);
        expect(config.flakeRetry).toBe(true);
        expect(config.compose.apiReplicas).toBe(2);
        expect(config.compose.workerReplicas).toBe(1);
        expect(config.compose.imageBuildStrategy).toBe('if-missing');
        expect(config.compose.reuseRunningTopology).toBe(false);
        expect(config.compose.metricsEnabled).toBe(true);
        expect(config.socketTransport).toBe('websocket');
      },
    );
  });

  it('reads full-compose topology knobs from the canonical env surface', async () => {
    await withEnvOverrides(
      {
        HAPPIER_STRESS_TARGET_MODE: 'full-compose',
        HAPPIER_STRESS_USERS: '250',
        HAPPIER_STRESS_MACHINES_PER_USER: '4',
        HAPPIER_STRESS_SESSIONS_PER_USER: '2',
        HAPPIER_STRESS_RPC_LISTENERS_PER_USER: '3',
        HAPPIER_STRESS_RPC_CALLS_PER_SECOND: '8',
        HAPPIER_STRESS_MESSAGES_PER_SECOND: '12',
        HAPPIER_STRESS_DURATION_MS: '45000',
        HAPPIER_STRESS_WARMUP_MS: '5000',
        HAPPIER_STRESS_SOAK_MS: '120000',
        HAPPIER_STRESS_RECONNECT_RATE: '5',
        HAPPIER_STRESS_RPC_READINESS_PROBE_LIMIT: '17',
        HAPPIER_STRESS_MIXED_SETUP_CONCURRENCY: '11',
        HAPPIER_STRESS_MIXED_CONNECT_CONCURRENCY: '29',
        HAPPIER_STRESS_MIXED_CONNECT_PATTERN: 'ramped',
        HAPPIER_STRESS_MIXED_CONNECT_RAMP_STEP_MS: '250',
        HAPPIER_STRESS_MIXED_SOCKET_CONNECT_TIMEOUT_MS: '65000',
        HAPPIER_STRESS_MIXED_SETUP_REQUEST_TIMEOUT_MS: '60000',
        HAPPIER_STRESS_MIXED_RPC_REGISTRATION_CONCURRENCY: '13',
        HAPPIER_STRESS_MIXED_RPC_BATCH_CONCURRENCY: '15',
        HAPPIER_STRESS_MIXED_PRESENCE_PULSE_CONCURRENCY: '17',
        HAPPIER_STRESS_MIXED_MESSAGE_BATCH_CONCURRENCY: '19',
        HAPPIER_STRESS_MIXED_MESSAGE_EMITTER_COUNT: '23',
        HAPPIER_STRESS_MIXED_RUNNER_SHARDS: '4',
        HAPPIER_STRESS_EXPECTED_API_REPLICAS: '5',
        HAPPIER_STRESS_EXPECTED_WORKER_REPLICAS: '2',
        HAPPIER_STRESS_COMPOSE_API_REPLICAS: '5',
        HAPPIER_STRESS_COMPOSE_WORKER_REPLICAS: '2',
        HAPPIER_STRESS_COMPOSE_IMAGE_BUILD_STRATEGY: 'never',
        HAPPIER_STRESS_COMPOSE_IMAGE_FINGERPRINT: '1111111111111111111111111111111111111111',
        HAPPIER_STRESS_COMPOSE_REUSE_RUNNING: '1',
        HAPPIER_STRESS_COMPOSE_FRONT_DOOR: 'api-direct',
        HAPPIER_STRESS_COMPOSE_GATEWAY_WORKER_CONNECTIONS: '32768',
        HAPPIER_STRESS_COMPOSE_GATEWAY_WORKER_RLIMIT_NOFILE: '131072',
        HAPPIER_STRESS_COMPOSE_GATEWAY_PORT: '43080',
        HAPPIER_STRESS_COMPOSE_API_DIRECT_PORT: '43081',
        HAPPIER_STRESS_COMPOSE_PG_PORT: '45432',
        HAPPIER_STRESS_COMPOSE_REDIS_PORT: '46379',
        HAPPIER_STRESS_COMPOSE_MINIO_PORT: '49000',
        HAPPIER_STRESS_COMPOSE_MINIO_CONSOLE_PORT: '49001',
        HAPPIER_STRESS_COMPOSE_DB_CONNECTION_LIMIT: '4',
        HAPPIER_STRESS_COMPOSE_AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS: '60000',
        HAPPIER_STRESS_COMPOSE_METRICS_ENABLED: '1',
        HAPPIER_STRESS_METRICS_SCRAPE_ENABLED: '1',
        HAPPIER_STRESS_KEEP_TOPOLOGY_ON_FAILURE: '1',
        HAPPIER_STRESS_SUMMARY_OUTPUT_PATH: '/tmp/stress-summary.json',
        HAPPIER_STRESS_SOCKET_TRANSPORT: 'polling',
      },
      async () => {
        const config = readStressConfig();

        expect(config.targetMode).toBe('full-compose');
        expect(config.load.users).toBe(250);
        expect(config.load.machinesPerUser).toBe(4);
        expect(config.load.sessionsPerUser).toBe(2);
        expect(config.load.rpcListenersPerUser).toBe(3);
        expect(config.load.rpcCallsPerSecond).toBe(8);
        expect(config.load.messagesPerSecond).toBe(12);
        expect(config.load.reconnectRate).toBe(5);
        expect(config.load.rpcReadinessProbeLimit).toBe(17);
        expect(config.load.mixedSetupConcurrency).toBe(11);
        expect(config.load.mixedConnectConcurrency).toBe(29);
        expect(config.load.mixedConnectPattern).toBe('ramped');
        expect(config.load.mixedConnectRampStepMs).toBe(250);
        expect(config.load.mixedSocketConnectTimeoutMs).toBe(65000);
        expect(config.load.mixedSetupRequestTimeoutMs).toBe(60000);
        expect(config.load.mixedRpcRegistrationConcurrency).toBe(13);
        expect(config.load.mixedRpcBatchConcurrency).toBe(15);
        expect(config.load.mixedPresencePulseConcurrency).toBe(17);
        expect(config.load.mixedMessageBatchConcurrency).toBe(19);
        expect(config.load.mixedMessageEmitterCount).toBe(23);
        expect(config.load.mixedRunnerShards).toBe(4);
        expect(config.duration.warmupMs).toBe(5000);
        expect(config.duration.durationMs).toBe(45000);
        expect(config.duration.soakMs).toBe(120000);
        expect(config.orchestration.expectedApiReplicas).toBe(5);
        expect(config.orchestration.expectedWorkerReplicas).toBe(2);
        expect(config.compose.apiReplicas).toBe(5);
        expect(config.compose.workerReplicas).toBe(2);
        expect(config.compose.imageBuildStrategy).toBe('never');
        expect(config.compose.imageFingerprint).toBe('1111111111111111111111111111111111111111');
        expect(config.compose.reuseRunningTopology).toBe(true);
        expect(config.compose.frontDoorMode).toBe('api-direct');
        expect(config.compose.gatewayWorkerConnections).toBe(32768);
        expect(config.compose.gatewayWorkerRlimitNoFile).toBe(131072);
        expect(config.compose.gatewayPort).toBe(43080);
        expect(config.compose.apiDirectPort).toBe(43081);
        expect(config.compose.postgresPort).toBe(45432);
        expect(config.compose.redisPort).toBe(46379);
        expect(config.compose.minioPort).toBe(49000);
        expect(config.compose.minioConsolePort).toBe(49001);
        expect(config.compose.dbConnectionLimit).toBe(4);
        expect(config.compose.authLoginEligibilityAccountSnapshotCacheTtlMs).toBe(60000);
        expect(config.compose.metricsEnabled).toBe(true);
        expect(config.socketTransport).toBe('polling');
        expect(config.artifacts.metricsScrapeEnabled).toBe(true);
        expect(config.artifacts.keepTopologyOnFailure).toBe(true);
        expect(config.artifacts.summaryOutputPath).toBe('/tmp/stress-summary.json');
      },
    );
  });

  it('applies named stress profiles before individual env overrides', async () => {
    await withEnvOverrides(
      {
        HAPPIER_STRESS_PROFILE: 'capacity.mixed-realistic',
        HAPPIER_STRESS_MESSAGES_PER_SECOND: '900',
      },
      async () => {
        const config = readStressConfig();

        expect(config.targetMode).toBe('full-compose');
        expect(config.load.users).toBe(250);
        expect(config.load.machinesPerUser).toBe(2);
        expect(config.load.sessionsPerUser).toBe(2);
        expect(config.load.rpcListenersPerUser).toBe(1);
        expect(config.load.rpcCallsPerSecond).toBe(10);
        expect(config.load.messagesPerSecond).toBe(900);
        expect(config.load.reconnectRate).toBe(2);
        expect(config.load.mixedSessionMode).toBe('representative');
        expect(config.load.rpcReadinessProbeLimit).toBeUndefined();
        expect(config.load.mixedSetupConcurrency).toBe(8);
        expect(config.load.mixedConnectConcurrency).toBe(128);
        expect(config.load.mixedConnectPattern).toBe('burst');
        expect(config.load.mixedConnectRampStepMs).toBe(0);
        expect(config.load.mixedSocketConnectTimeoutMs).toBe(60_000);
        expect(config.load.mixedSetupRequestTimeoutMs).toBe(15_000);
        expect(config.load.mixedRpcRegistrationConcurrency).toBe(8);
        expect(config.load.mixedRpcBatchConcurrency).toBe(32);
        expect(config.load.mixedPresencePulseConcurrency).toBe(32);
        expect(config.load.mixedMessageBatchConcurrency).toBe(32);
        expect(config.load.mixedMessageEmitterCount).toBe(1);
        expect(config.load.mixedRunnerShards).toBe(1);
        expect(config.duration.durationMs).toBe(20_000);
        expect(config.duration.soakMs).toBe(5_000);
        expect(config.compose.apiReplicas).toBe(2);
        expect(config.compose.workerReplicas).toBe(1);
        expect(config.compose.frontDoorMode).toBe('gateway');
        expect(config.compose.gatewayWorkerConnections).toBe(16384);
        expect(config.compose.gatewayWorkerRlimitNoFile).toBe(65535);
        expect(config.compose.metricsEnabled).toBe(true);
      },
    );
  });

  it('rejects unknown named stress profiles', async () => {
    await withEnvOverrides(
      {
        HAPPIER_STRESS_PROFILE: 'capacity.nope',
      },
      async () => {
        expect(() => readStressConfig()).toThrow(/Unknown HAPPIER_STRESS_PROFILE/);
      },
    );
  });

  it('supports a presence-fan-in mixed profile and explicit mixed session mode overrides', async () => {
    await withEnvOverrides(
      {
        HAPPIER_STRESS_PROFILE: 'capacity.mixed-presence-heavy',
        HAPPIER_STRESS_MIXED_SESSION_MODE: 'representative',
      },
      async () => {
        const config = readStressConfig();

        expect(config.targetMode).toBe('full-compose');
        expect(config.load.users).toBe(1000);
        expect(config.load.machinesPerUser).toBe(2);
        expect(config.load.sessionsPerUser).toBe(2);
        expect(config.load.mixedSessionMode).toBe('representative');
        expect(config.load.rpcReadinessProbeLimit).toBe(32);
        expect(config.load.mixedSetupRequestTimeoutMs).toBe(60_000);
        expect(config.load.mixedConnectConcurrency).toBe(128);
        expect(config.load.mixedSocketConnectTimeoutMs).toBe(60_000);
        expect(config.load.mixedMessageEmitterCount).toBe(1);
        expect(config.compose.apiReplicas).toBe(2);
        expect(config.compose.workerReplicas).toBe(2);
      },
    );
  });

  it('accepts an explicit base url in external mode', async () => {
    await withEnvOverrides(
      {
        HAPPIER_STRESS_TARGET_MODE: 'external',
        HAPPIER_STRESS_BASE_URL: 'https://stress.example.com',
      },
      async () => {
        const config = readStressConfig();
        expect(config.targetMode).toBe('external');
        expect(config.baseUrl).toBe('https://stress.example.com');
      },
    );
  });

  it('requires a base url in external mode', async () => {
    await withEnvOverrides(
      {
        HAPPIER_STRESS_TARGET_MODE: 'external',
        HAPPIER_STRESS_BASE_URL: undefined,
      },
      async () => {
        expect(() => readStressConfig()).toThrow(/HAPPIER_STRESS_BASE_URL/);
      },
    );
  });
});
