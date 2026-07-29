import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

export type ReplayForkContinuation = Readonly<{
  /**
   * Provider-specific spawn overrides required to preserve runtime semantics for the forked session.
   * Example: environmentVariables that select the provider runtime flavor.
   */
  spawn: Partial<SpawnSessionOptions>;
  /**
   * Provider-specific metadata overlay to persist at session creation time for replay forks.
   * Must be safe to store in session metadata.
   */
  metadata: Readonly<Record<string, unknown>>;
}>;

export type ReplayForkContinuationHandler = (params: Readonly<{
  parentMetadata: Record<string, unknown>;
}>) => Promise<ReplayForkContinuation | null>;
