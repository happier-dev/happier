import type { ManagedConnectionState, ManagedConnectionTimingPolicy, ReadinessProbeResult } from './managedConnectionTypes.js';

export type ManagedEndpointSupervisorState = ManagedConnectionState &
  Readonly<{
    lastProbe: ReadinessProbeResult | null;
  }>;

export interface ManagedEndpointSupervisorConfig extends ManagedConnectionTimingPolicy {
  probeReadiness: () => Promise<ReadinessProbeResult>;
  onStateChange?: (state: ManagedEndpointSupervisorState) => void;
}

export type ManagedEndpointFailureReport = Readonly<{
  errorMessage?: string;
}>;

export interface ManagedEndpointSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  invalidate(): void;
  reportFailure(report: ManagedEndpointFailureReport): void;
  waitUntilOnline(params?: Readonly<{ timeoutMs?: number }>): Promise<void>;
  getState(): ManagedEndpointSupervisorState;
  subscribe(listener: (state: ManagedEndpointSupervisorState) => void): () => void;
}
