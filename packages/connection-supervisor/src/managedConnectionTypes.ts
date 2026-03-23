export type ManagedConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'auth_failed'
  | 'shutting_down';

export type ManagedConnectionReason =
  | 'initial_connect'
  | 'transport_disconnect'
  | 'server_unreachable'
  | 'server_restarting'
  | 'auth_invalid'
  | 'intentional_shutdown'
  | 'runtime_missing'
  | 'probe_failed'
  | 'manual_disconnect'
  | null;

export type ManagedConnectionState = Readonly<{
  phase: ManagedConnectionPhase;
  reason: ManagedConnectionReason;
  attempt: number;
  nextRetryAt: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastErrorMessage: string | null;
}>;

export type TransportDisconnectEvent = Readonly<{
  intentional?: boolean;
  reason?: string | null;
  error?: unknown;
}>;

export interface ManagedConnectionTransport {
  connect(): Promise<void>;
  disconnect(params?: { intentional?: boolean }): Promise<void>;
  destroy(): Promise<void>;
  isConnected(): boolean;
  onConnected(listener: () => void): () => void;
  onDisconnected(listener: (event: TransportDisconnectEvent) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
}

export type ReadinessProbeResult =
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'server_unreachable'; errorMessage?: string }>
  | Readonly<{ status: 'auth_failed'; statusCode?: number; errorMessage?: string }>
  | Readonly<{ status: 'retry_later'; retryAfterMs?: number; errorMessage?: string }>;

export type ManagedConnectionContext = Readonly<{
  state: ManagedConnectionState;
}>;

export type ManagedConnectionDisconnectContext = Readonly<{
  state: ManagedConnectionState;
  event: TransportDisconnectEvent;
}>;

export type ManagedConnectionAuthFailureContext = Readonly<{
  state: ManagedConnectionState;
  probe: Extract<ReadinessProbeResult, { status: 'auth_failed' }>;
}>;

export type ManagedConnectionReconnectContext = Readonly<{
  attempt: number;
  state: ManagedConnectionState;
}>;

export interface ManagedConnectionTimingPolicy {
  initialFastRetryDelayMs: number;
  maxFastRetries: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  jitterRatio: number;
}

export interface ManagedConnectionSupervisorConfig extends ManagedConnectionTimingPolicy {
  createTransport: () => ManagedConnectionTransport;
  probeReadiness: () => Promise<ReadinessProbeResult>;
  onStateChange?: (state: ManagedConnectionState) => void;
  onConnected?: (ctx: ManagedConnectionContext) => Promise<void> | void;
  onDisconnected?: (ctx: ManagedConnectionDisconnectContext) => Promise<void> | void;
  onAuthFailed?: (ctx: ManagedConnectionAuthFailureContext) => Promise<void> | void;
  onBeforeReconnect?: (ctx: ManagedConnectionReconnectContext) => Promise<void> | void;
}

export interface ManagedConnectionSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): ManagedConnectionState;
}
