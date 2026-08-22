export type StressTargetMode = 'light' | 'full-compose' | 'external';
export type StressSocketTransport = 'websocket' | 'polling';
export type StressFilesBackend = 's3' | 'local';
export type StressKillTarget = 'api' | 'worker' | 'none';
export type StressComposeImageBuildStrategy = 'always' | 'if-missing' | 'never';
export type StressComposeFrontDoorMode = 'gateway' | 'api-direct';
export type StressComposeLoadGenerationMode = 'host' | 'compose-network';
export type StressMixedSessionMode = 'representative' | 'presence-fan-in';
export type StressMixedConnectPattern = 'burst' | 'ramped';

export type StressDurationConfig = Readonly<{
  warmupMs: number;
  durationMs: number;
  cooldownMs: number;
  soakMs: number;
}>;

export type StressLoadConfig = Readonly<{
  users: number;
  machinesPerUser: number;
  sessionsPerUser: number;
  rpcListenersPerUser: number;
  rpcReadinessProbeLimit?: number;
  mixedSetupConcurrency?: number;
  mixedConnectConcurrency?: number;
  mixedConnectPattern?: StressMixedConnectPattern;
  mixedConnectRampStepMs?: number;
  mixedSocketConnectTimeoutMs?: number;
  mixedConnectConvergenceTimeoutMs?: number;
  mixedSetupRequestTimeoutMs?: number;
  mixedSocketAutoReconnect?: boolean;
  mixedCaptureSocketEvents?: boolean;
  mixedRpcRegistrationConcurrency?: number;
  mixedRpcBatchConcurrency?: number;
  mixedPresencePulseConcurrency?: number;
  mixedMessageBatchConcurrency?: number;
  mixedMessageEmitterCount?: number;
  mixedRunnerShards?: number;
  mixedActiveSessionPercent?: number;
  mixedStreamingSegmentsPerSecond?: number;
  rpcCallsPerSecond: number;
  messagesPerSecond: number;
  reconnectRate: number;
  mixedSessionMode: StressMixedSessionMode;
}>;

export type StressOrchestrationConfig = Readonly<{
  rollingRestartEnabled: boolean;
  killTarget: StressKillTarget;
  expectedApiReplicas: number;
  expectedWorkerReplicas: number;
}>;

export type StressComposeConfig = Readonly<{
  apiReplicas: number;
  workerReplicas: number;
  imageBuildStrategy: StressComposeImageBuildStrategy;
  imageFingerprint?: string;
  reuseRunningTopology: boolean;
  frontDoorMode?: StressComposeFrontDoorMode;
  loadGenerationMode?: StressComposeLoadGenerationMode;
  dbConnectionLimit?: number;
  authLoginEligibilityAccountSnapshotCacheTtlMs?: number;
  apiHeapDiagnosticSignal?: NodeJS.Signals;
  apiHeapDiagnosticOldSpaceThresholdBytes?: number;
  gatewayWorkerConnections?: number;
  gatewayWorkerRlimitNoFile?: number;
  gatewayPort?: number;
  apiDirectPort?: number;
  postgresPort?: number;
  redisPort?: number;
  minioPort?: number;
  minioConsolePort?: number;
  metricsEnabled: boolean;
  filesBackend: StressFilesBackend;
}>;

export type StressArtifactsConfig = Readonly<{
  saveArtifactsOnSuccess: boolean;
  metricsScrapeEnabled: boolean;
  keepTopologyOnFailure: boolean;
  summaryOutputPath?: string;
}>;

export type StressConfig = Readonly<{
  targetMode: StressTargetMode;
  baseUrl?: string;
  repeat: number;
  seed?: number;
  flakeRetry: boolean;
  socketTransport: StressSocketTransport;
  duration: StressDurationConfig;
  load: StressLoadConfig;
  orchestration: StressOrchestrationConfig;
  compose: StressComposeConfig;
  artifacts: StressArtifactsConfig;
}>;
