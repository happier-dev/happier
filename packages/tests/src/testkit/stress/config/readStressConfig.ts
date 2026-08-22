import { envFlag } from '../../env';
import { parsePositiveInt } from '../../numbers';
import type {
  StressComposeFrontDoorMode,
  StressComposeImageBuildStrategy,
  StressComposeLoadGenerationMode,
  StressConfig,
  StressFilesBackend,
  StressKillTarget,
  StressMixedConnectPattern,
  StressMixedSessionMode,
  StressSocketTransport,
  StressTargetMode,
} from './stressScenarioSchema';
import { resolveStressProfile } from './stressProfiles';

function readString(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readOptionalInt(keys: readonly string[]): number | undefined {
  const raw = readString(keys);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPositiveInt(keys: readonly string[], fallback: number): number {
  return parsePositiveInt(readString(keys), fallback);
}

function readNonNegativeInt(keys: readonly string[], fallback: number): number {
  const raw = readString(keys);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readTargetMode(): StressTargetMode {
  const profileConfig = resolveStressProfile(readString(['HAPPIER_STRESS_PROFILE']));
  const raw = (readString(['HAPPIER_STRESS_TARGET_MODE']) ?? profileConfig.targetMode).toLowerCase();
  if (raw === 'light' || raw === 'full-compose' || raw === 'external') {
    return raw;
  }
  return profileConfig.targetMode;
}

function readSocketTransport(fallback: StressSocketTransport): StressSocketTransport {
  const raw = (readString(['HAPPIER_STRESS_SOCKET_TRANSPORT']) ?? fallback).toLowerCase();
  if (raw === 'polling') return 'polling';
  return 'websocket';
}

function readFilesBackend(fallback: StressFilesBackend): StressFilesBackend {
  const raw = (readString(['HAPPIER_STRESS_COMPOSE_FILES_BACKEND']) ?? fallback).toLowerCase();
  return raw === 'local' ? 'local' : 's3';
}

function readImageBuildStrategy(fallback: StressComposeImageBuildStrategy): StressComposeImageBuildStrategy {
  const raw = (
    readString(['HAPPIER_STRESS_COMPOSE_IMAGE_BUILD_STRATEGY'])
    ?? fallback
  ).toLowerCase();
  if (raw === 'always' || raw === 'never') {
    return raw;
  }
  return 'if-missing';
}

function readFrontDoorMode(fallback: StressComposeFrontDoorMode): StressComposeFrontDoorMode {
  const raw = (readString(['HAPPIER_STRESS_COMPOSE_FRONT_DOOR']) ?? fallback).toLowerCase();
  return raw === 'api-direct' ? 'api-direct' : 'gateway';
}

function readLoadGenerationMode(fallback: StressComposeLoadGenerationMode): StressComposeLoadGenerationMode {
  const raw = (readString(['HAPPIER_STRESS_COMPOSE_LOAD_GENERATION_MODE']) ?? fallback).toLowerCase();
  return raw === 'compose-network' ? 'compose-network' : 'host';
}

function readKillTarget(fallback: StressKillTarget): StressKillTarget {
  const raw = (readString(['HAPPIER_STRESS_KILL_TARGET']) ?? fallback).toLowerCase();
  if (raw === 'api' || raw === 'worker' || raw === 'none') {
    return raw;
  }
  return fallback;
}

function readMixedSessionMode(fallback: StressMixedSessionMode): StressMixedSessionMode {
  const raw = (readString(['HAPPIER_STRESS_MIXED_SESSION_MODE']) ?? fallback).toLowerCase();
  return raw === 'presence-fan-in' ? 'presence-fan-in' : 'representative';
}

function readMixedConnectPattern(fallback: StressMixedConnectPattern): StressMixedConnectPattern {
  const raw = (readString(['HAPPIER_STRESS_MIXED_CONNECT_PATTERN']) ?? fallback).toLowerCase();
  return raw === 'ramped' ? 'ramped' : 'burst';
}

export function readStressConfig(): StressConfig {
  const profileConfig = resolveStressProfile(readString(['HAPPIER_STRESS_PROFILE']));
  const targetMode = readTargetMode();
  const baseUrl = readString(['HAPPIER_STRESS_BASE_URL']);
  if (targetMode === 'external' && !baseUrl) {
    throw new Error('HAPPIER_STRESS_BASE_URL is required when HAPPIER_STRESS_TARGET_MODE=external');
  }

  return {
    targetMode,
    baseUrl,
    repeat: readPositiveInt(['HAPPIER_STRESS_REPEAT', 'HAPPIER_E2E_REPEAT', 'HAPPY_E2E_REPEAT'], profileConfig.repeat),
    seed: readOptionalInt(['HAPPIER_STRESS_SEED', 'HAPPIER_E2E_SEED', 'HAPPY_E2E_SEED']),
    flakeRetry: envFlag(['HAPPIER_STRESS_FLAKE_RETRY', 'HAPPIER_E2E_FLAKE_RETRY', 'HAPPY_E2E_FLAKE_RETRY'], profileConfig.flakeRetry),
    socketTransport: readSocketTransport(profileConfig.socketTransport),
    duration: {
      warmupMs: readNonNegativeInt(['HAPPIER_STRESS_WARMUP_MS'], profileConfig.duration.warmupMs),
      durationMs: readPositiveInt(['HAPPIER_STRESS_DURATION_MS'], profileConfig.duration.durationMs),
      cooldownMs: readNonNegativeInt(['HAPPIER_STRESS_COOLDOWN_MS'], profileConfig.duration.cooldownMs),
      soakMs: readNonNegativeInt(['HAPPIER_STRESS_SOAK_MS'], profileConfig.duration.soakMs),
    },
    load: {
      users: readPositiveInt(['HAPPIER_STRESS_USERS'], profileConfig.load.users),
      machinesPerUser: readPositiveInt(['HAPPIER_STRESS_MACHINES_PER_USER'], profileConfig.load.machinesPerUser),
      sessionsPerUser: readPositiveInt(['HAPPIER_STRESS_SESSIONS_PER_USER'], profileConfig.load.sessionsPerUser),
      rpcListenersPerUser: readPositiveInt(['HAPPIER_STRESS_RPC_LISTENERS_PER_USER'], profileConfig.load.rpcListenersPerUser),
      rpcReadinessProbeLimit: readOptionalInt(['HAPPIER_STRESS_RPC_READINESS_PROBE_LIMIT']) ?? profileConfig.load.rpcReadinessProbeLimit,
      mixedSetupConcurrency: readOptionalInt(['HAPPIER_STRESS_MIXED_SETUP_CONCURRENCY']) ?? profileConfig.load.mixedSetupConcurrency,
      mixedConnectConcurrency:
        readOptionalInt(['HAPPIER_STRESS_MIXED_CONNECT_CONCURRENCY'])
        ?? profileConfig.load.mixedConnectConcurrency,
      mixedConnectPattern: readMixedConnectPattern(profileConfig.load.mixedConnectPattern ?? 'burst'),
      mixedConnectRampStepMs:
        readNonNegativeInt(
          ['HAPPIER_STRESS_MIXED_CONNECT_RAMP_STEP_MS'],
          profileConfig.load.mixedConnectRampStepMs ?? 0,
        ),
      mixedSocketConnectTimeoutMs:
        readOptionalInt(['HAPPIER_STRESS_MIXED_SOCKET_CONNECT_TIMEOUT_MS'])
        ?? profileConfig.load.mixedSocketConnectTimeoutMs,
      mixedConnectConvergenceTimeoutMs:
        readOptionalInt(['HAPPIER_STRESS_MIXED_CONNECT_CONVERGENCE_TIMEOUT_MS'])
        ?? profileConfig.load.mixedConnectConvergenceTimeoutMs,
      mixedSetupRequestTimeoutMs:
        readOptionalInt(['HAPPIER_STRESS_MIXED_SETUP_REQUEST_TIMEOUT_MS'])
        ?? profileConfig.load.mixedSetupRequestTimeoutMs,
      mixedSocketAutoReconnect:
        envFlag(['HAPPIER_STRESS_MIXED_SOCKET_AUTO_RECONNECT'], profileConfig.load.mixedSocketAutoReconnect ?? true),
      mixedCaptureSocketEvents:
        envFlag(['HAPPIER_STRESS_MIXED_CAPTURE_SOCKET_EVENTS'], profileConfig.load.mixedCaptureSocketEvents ?? true),
      mixedRpcRegistrationConcurrency:
        readOptionalInt(['HAPPIER_STRESS_MIXED_RPC_REGISTRATION_CONCURRENCY'])
        ?? profileConfig.load.mixedRpcRegistrationConcurrency,
      mixedRpcBatchConcurrency:
        readOptionalInt(['HAPPIER_STRESS_MIXED_RPC_BATCH_CONCURRENCY'])
        ?? profileConfig.load.mixedRpcBatchConcurrency,
      mixedPresencePulseConcurrency:
        readOptionalInt(['HAPPIER_STRESS_MIXED_PRESENCE_PULSE_CONCURRENCY'])
        ?? profileConfig.load.mixedPresencePulseConcurrency,
      mixedMessageBatchConcurrency:
        readOptionalInt(['HAPPIER_STRESS_MIXED_MESSAGE_BATCH_CONCURRENCY'])
        ?? profileConfig.load.mixedMessageBatchConcurrency,
      mixedMessageEmitterCount:
        readOptionalInt(['HAPPIER_STRESS_MIXED_MESSAGE_EMITTER_COUNT'])
        ?? profileConfig.load.mixedMessageEmitterCount,
      mixedRunnerShards:
        readOptionalInt(['HAPPIER_STRESS_MIXED_RUNNER_SHARDS'])
        ?? profileConfig.load.mixedRunnerShards,
      mixedActiveSessionPercent:
        readOptionalInt(['HAPPIER_STRESS_MIXED_ACTIVE_SESSION_PERCENT'])
        ?? profileConfig.load.mixedActiveSessionPercent,
      mixedStreamingSegmentsPerSecond:
        readOptionalInt(['HAPPIER_STRESS_MIXED_STREAMING_SEGMENTS_PER_SECOND'])
        ?? profileConfig.load.mixedStreamingSegmentsPerSecond,
      rpcCallsPerSecond: readPositiveInt(['HAPPIER_STRESS_RPC_CALLS_PER_SECOND'], profileConfig.load.rpcCallsPerSecond),
      messagesPerSecond: readPositiveInt(['HAPPIER_STRESS_MESSAGES_PER_SECOND'], profileConfig.load.messagesPerSecond),
      reconnectRate: readNonNegativeInt(['HAPPIER_STRESS_RECONNECT_RATE'], profileConfig.load.reconnectRate),
      mixedSessionMode: readMixedSessionMode(profileConfig.load.mixedSessionMode),
    },
    orchestration: {
      rollingRestartEnabled: envFlag(['HAPPIER_STRESS_ROLLING_RESTART_ENABLED'], profileConfig.orchestration.rollingRestartEnabled),
      killTarget: readKillTarget(profileConfig.orchestration.killTarget),
      expectedApiReplicas: readPositiveInt(['HAPPIER_STRESS_EXPECTED_API_REPLICAS'], targetMode === 'full-compose' ? profileConfig.compose.apiReplicas : profileConfig.orchestration.expectedApiReplicas),
      expectedWorkerReplicas: readPositiveInt(['HAPPIER_STRESS_EXPECTED_WORKER_REPLICAS'], targetMode === 'full-compose' ? profileConfig.compose.workerReplicas : profileConfig.orchestration.expectedWorkerReplicas || 1),
    },
    compose: {
      apiReplicas: readPositiveInt(['HAPPIER_STRESS_COMPOSE_API_REPLICAS'], profileConfig.compose.apiReplicas),
      workerReplicas: readPositiveInt(['HAPPIER_STRESS_COMPOSE_WORKER_REPLICAS'], profileConfig.compose.workerReplicas),
      imageBuildStrategy: readImageBuildStrategy(profileConfig.compose.imageBuildStrategy),
      imageFingerprint: readString(['HAPPIER_STRESS_COMPOSE_IMAGE_FINGERPRINT']),
      reuseRunningTopology: envFlag(
        ['HAPPIER_STRESS_COMPOSE_REUSE_RUNNING'],
        profileConfig.compose.reuseRunningTopology,
      ),
      frontDoorMode: readFrontDoorMode(profileConfig.compose.frontDoorMode ?? 'gateway'),
      loadGenerationMode: readLoadGenerationMode(profileConfig.compose.loadGenerationMode ?? 'host'),
      dbConnectionLimit: readOptionalInt(['HAPPIER_STRESS_COMPOSE_DB_CONNECTION_LIMIT']) ?? profileConfig.compose.dbConnectionLimit,
      authLoginEligibilityAccountSnapshotCacheTtlMs:
        readOptionalInt(['HAPPIER_STRESS_COMPOSE_AUTH_LOGIN_ELIGIBILITY_ACCOUNT_SNAPSHOT_CACHE_TTL_MS'])
        ?? profileConfig.compose.authLoginEligibilityAccountSnapshotCacheTtlMs,
      apiHeapDiagnosticSignal:
        (readString(['HAPPIER_STRESS_COMPOSE_API_HEAP_DIAGNOSTIC_SIGNAL']) as NodeJS.Signals | undefined)
        ?? profileConfig.compose.apiHeapDiagnosticSignal,
      apiHeapDiagnosticOldSpaceThresholdBytes:
        readOptionalInt(['HAPPIER_STRESS_COMPOSE_API_HEAP_DIAGNOSTIC_OLD_SPACE_THRESHOLD_BYTES'])
        ?? profileConfig.compose.apiHeapDiagnosticOldSpaceThresholdBytes,
      gatewayWorkerConnections: readPositiveInt(
        ['HAPPIER_STRESS_COMPOSE_GATEWAY_WORKER_CONNECTIONS'],
        profileConfig.compose.gatewayWorkerConnections ?? 16_384,
      ),
      gatewayWorkerRlimitNoFile: readPositiveInt(
        ['HAPPIER_STRESS_COMPOSE_GATEWAY_WORKER_RLIMIT_NOFILE'],
        profileConfig.compose.gatewayWorkerRlimitNoFile ?? 65_535,
      ),
      gatewayPort: readOptionalInt(['HAPPIER_STRESS_COMPOSE_GATEWAY_PORT']),
      apiDirectPort: readOptionalInt(['HAPPIER_STRESS_COMPOSE_API_DIRECT_PORT']),
      postgresPort: readOptionalInt(['HAPPIER_STRESS_COMPOSE_PG_PORT']),
      redisPort: readOptionalInt(['HAPPIER_STRESS_COMPOSE_REDIS_PORT']),
      minioPort: readOptionalInt(['HAPPIER_STRESS_COMPOSE_MINIO_PORT']),
      minioConsolePort: readOptionalInt(['HAPPIER_STRESS_COMPOSE_MINIO_CONSOLE_PORT']),
      metricsEnabled: envFlag(['HAPPIER_STRESS_COMPOSE_METRICS_ENABLED'], profileConfig.compose.metricsEnabled),
      filesBackend: readFilesBackend(profileConfig.compose.filesBackend),
    },
    artifacts: {
      saveArtifactsOnSuccess: envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], profileConfig.artifacts.saveArtifactsOnSuccess),
      metricsScrapeEnabled: envFlag(['HAPPIER_STRESS_METRICS_SCRAPE_ENABLED'], profileConfig.artifacts.metricsScrapeEnabled),
      keepTopologyOnFailure: envFlag(['HAPPIER_STRESS_KEEP_TOPOLOGY_ON_FAILURE'], profileConfig.artifacts.keepTopologyOnFailure),
      summaryOutputPath: readString(['HAPPIER_STRESS_SUMMARY_OUTPUT_PATH']),
    },
  };
}
