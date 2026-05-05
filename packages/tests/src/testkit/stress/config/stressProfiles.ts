import type { StressConfig } from './stressScenarioSchema';

type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends Record<string, unknown> ? DeepPartial<T[Key]> : T[Key];
};

export const defaultStressConfig: StressConfig = {
  targetMode: 'light',
  baseUrl: undefined,
  repeat: 5,
  seed: undefined,
  flakeRetry: false,
  socketTransport: 'websocket',
  duration: {
    warmupMs: 1_000,
    durationMs: 30_000,
    cooldownMs: 1_000,
    soakMs: 0,
  },
  load: {
    users: 25,
    machinesPerUser: 1,
    sessionsPerUser: 1,
    rpcListenersPerUser: 1,
    rpcReadinessProbeLimit: undefined,
    mixedSetupConcurrency: 8,
    mixedConnectConcurrency: 128,
    mixedConnectPattern: 'burst',
    mixedConnectRampStepMs: 0,
    mixedSocketConnectTimeoutMs: 60_000,
    mixedConnectConvergenceTimeoutMs: undefined,
    mixedSetupRequestTimeoutMs: 15_000,
    mixedSocketAutoReconnect: true,
    mixedCaptureSocketEvents: true,
    mixedRpcRegistrationConcurrency: 8,
    mixedRpcBatchConcurrency: 32,
    mixedPresencePulseConcurrency: 32,
    mixedMessageBatchConcurrency: 32,
    mixedMessageEmitterCount: 1,
    mixedRunnerShards: 1,
    mixedActiveSessionPercent: 100,
    mixedStreamingSegmentsPerSecond: 0,
    rpcCallsPerSecond: 2,
    messagesPerSecond: 5,
    reconnectRate: 0,
    mixedSessionMode: 'representative',
  },
  orchestration: {
    rollingRestartEnabled: false,
    killTarget: 'none',
    expectedApiReplicas: 1,
    expectedWorkerReplicas: 0,
  },
  compose: {
    apiReplicas: 2,
    workerReplicas: 1,
    imageBuildStrategy: 'if-missing',
    reuseRunningTopology: false,
    frontDoorMode: 'gateway',
    loadGenerationMode: 'host',
    dbConnectionLimit: undefined,
    authLoginEligibilityAccountSnapshotCacheTtlMs: undefined,
    apiHeapDiagnosticSignal: undefined,
    apiHeapDiagnosticOldSpaceThresholdBytes: undefined,
    gatewayWorkerConnections: 16_384,
    gatewayWorkerRlimitNoFile: 65_535,
    gatewayPort: undefined,
    apiDirectPort: undefined,
    postgresPort: undefined,
    redisPort: undefined,
    minioPort: undefined,
    minioConsolePort: undefined,
    metricsEnabled: true,
    filesBackend: 's3',
  },
  artifacts: {
    saveArtifactsOnSuccess: false,
    metricsScrapeEnabled: false,
    keepTopologyOnFailure: false,
    summaryOutputPath: undefined,
  },
};

export const namedStressProfiles = {
  'capacity.small': {
    targetMode: 'full-compose',
    repeat: 1,
    duration: {
      warmupMs: 1_000,
      durationMs: 20_000,
      cooldownMs: 1_000,
      soakMs: 2_000,
    },
    load: {
      users: 250,
      machinesPerUser: 2,
      sessionsPerUser: 2,
      rpcListenersPerUser: 1,
      rpcReadinessProbeLimit: undefined,
      rpcCallsPerSecond: 10,
      messagesPerSecond: 250,
      reconnectRate: 1,
      mixedSessionMode: 'representative',
    },
    compose: {
      apiReplicas: 1,
      workerReplicas: 1,
      metricsEnabled: true,
    },
    artifacts: {
      metricsScrapeEnabled: true,
    },
  },
  'capacity.medium': {
    targetMode: 'full-compose',
    repeat: 1,
    duration: {
      warmupMs: 1_000,
      durationMs: 20_000,
      cooldownMs: 1_000,
      soakMs: 2_000,
    },
    load: {
      users: 500,
      machinesPerUser: 2,
      sessionsPerUser: 2,
      rpcListenersPerUser: 1,
      rpcReadinessProbeLimit: undefined,
      rpcCallsPerSecond: 20,
      messagesPerSecond: 500,
      reconnectRate: 1,
      mixedSessionMode: 'representative',
    },
    compose: {
      apiReplicas: 2,
      workerReplicas: 1,
      metricsEnabled: true,
    },
    artifacts: {
      metricsScrapeEnabled: true,
    },
  },
  'capacity.large': {
    targetMode: 'full-compose',
    repeat: 1,
    duration: {
      warmupMs: 1_000,
      durationMs: 20_000,
      cooldownMs: 1_000,
      soakMs: 5_000,
    },
    load: {
      users: 1_000,
      machinesPerUser: 2,
      sessionsPerUser: 2,
      rpcListenersPerUser: 2,
      rpcReadinessProbeLimit: undefined,
      rpcCallsPerSecond: 40,
      messagesPerSecond: 1_000,
      reconnectRate: 2,
      mixedSessionMode: 'representative',
    },
    compose: {
      apiReplicas: 2,
      workerReplicas: 2,
      metricsEnabled: true,
    },
    artifacts: {
      metricsScrapeEnabled: true,
    },
  },
  'capacity.presence-heavy': {
    targetMode: 'full-compose',
    repeat: 1,
    duration: {
      warmupMs: 1_000,
      durationMs: 20_000,
      cooldownMs: 1_000,
      soakMs: 5_000,
    },
    load: {
      users: 1_500,
      machinesPerUser: 2,
      sessionsPerUser: 2,
      rpcListenersPerUser: 1,
      rpcReadinessProbeLimit: undefined,
      rpcCallsPerSecond: 5,
      messagesPerSecond: 100,
      reconnectRate: 0,
      mixedSessionMode: 'representative',
    },
    compose: {
      apiReplicas: 2,
      workerReplicas: 2,
      metricsEnabled: true,
    },
    artifacts: {
      metricsScrapeEnabled: true,
    },
  },
  'capacity.rpc-heavy': {
    targetMode: 'full-compose',
    repeat: 1,
    duration: {
      warmupMs: 1_000,
      durationMs: 20_000,
      cooldownMs: 1_000,
      soakMs: 2_000,
    },
    load: {
      users: 40,
      machinesPerUser: 1,
      sessionsPerUser: 1,
      rpcListenersPerUser: 2,
      rpcReadinessProbeLimit: undefined,
      rpcCallsPerSecond: 40,
      messagesPerSecond: 50,
      reconnectRate: 0,
      mixedSessionMode: 'representative',
    },
    compose: {
      apiReplicas: 2,
      workerReplicas: 1,
      metricsEnabled: true,
    },
    artifacts: {
      metricsScrapeEnabled: true,
    },
  },
  'capacity.mixed-realistic': {
    targetMode: 'full-compose',
    repeat: 1,
    duration: {
      warmupMs: 1_000,
      durationMs: 20_000,
      cooldownMs: 1_000,
      soakMs: 5_000,
    },
    load: {
      users: 250,
      machinesPerUser: 2,
      sessionsPerUser: 2,
      rpcListenersPerUser: 1,
      rpcReadinessProbeLimit: undefined,
      rpcCallsPerSecond: 10,
      messagesPerSecond: 250,
      reconnectRate: 2,
      mixedSessionMode: 'representative',
    },
    compose: {
      apiReplicas: 2,
      workerReplicas: 1,
      metricsEnabled: true,
    },
    artifacts: {
      metricsScrapeEnabled: true,
    },
  },
  'capacity.mixed-presence-heavy': {
    targetMode: 'full-compose',
    repeat: 1,
    duration: {
      warmupMs: 1_000,
      durationMs: 20_000,
      cooldownMs: 1_000,
      soakMs: 5_000,
    },
    load: {
      users: 1_000,
      machinesPerUser: 2,
      sessionsPerUser: 2,
      rpcListenersPerUser: 1,
      rpcReadinessProbeLimit: 32,
      mixedSetupConcurrency: 32,
      mixedSetupRequestTimeoutMs: 60_000,
      mixedRpcRegistrationConcurrency: 64,
      mixedRpcBatchConcurrency: 128,
      mixedPresencePulseConcurrency: 128,
      mixedMessageBatchConcurrency: 128,
      rpcCallsPerSecond: 20,
      messagesPerSecond: 1_000,
      reconnectRate: 2,
      mixedSessionMode: 'presence-fan-in',
    },
    compose: {
      apiReplicas: 2,
      workerReplicas: 2,
      metricsEnabled: true,
    },
    artifacts: {
      metricsScrapeEnabled: true,
    },
  },
} as const satisfies Record<string, DeepPartial<StressConfig>>;

export type StressProfileId = keyof typeof namedStressProfiles;

function mergeNested<T extends Record<string, unknown>>(
  base: Readonly<T>,
  override: DeepPartial<T> | undefined,
): T {
  if (!override) {
    return { ...base };
  }

  const merged = { ...base } as T;
  for (const [key, value] of Object.entries(override) as [keyof T, DeepPartial<T[keyof T]>][]) {
    if (value === undefined) {
      continue;
    }
    const existing = merged[key];
    if (
      existing
      && typeof existing === 'object'
      && !Array.isArray(existing)
      && value
      && typeof value === 'object'
      && !Array.isArray(value)
    ) {
      merged[key] = mergeNested(existing as Record<string, unknown>, value as DeepPartial<Record<string, unknown>>) as T[keyof T];
      continue;
    }
    merged[key] = value as T[keyof T];
  }
  return merged;
}

export function resolveStressProfile(profileId: string | undefined): StressConfig {
  if (!profileId) {
    return defaultStressConfig;
  }

  const override = namedStressProfiles[profileId as StressProfileId];
  if (!override) {
    throw new Error(
      `Unknown HAPPIER_STRESS_PROFILE=${profileId}. Available profiles: ${Object.keys(namedStressProfiles).join(', ')}`,
    );
  }

  return mergeNested(defaultStressConfig, override);
}
