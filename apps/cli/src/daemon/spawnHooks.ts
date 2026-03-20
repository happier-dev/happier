import type { CodexBackendMode } from '@happier-dev/agents';
import type { AgentRuntimeDescriptorV1 } from '@happier-dev/protocol';

import { resolveCanonicalCodexBackendMode } from '@/rpc/handlers/codexBackendMode';

export type DaemonSpawnRuntimeSelection = Readonly<{
  experimentalCodexAcp?: boolean;
  codexBackendMode?: CodexBackendMode;
  agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
}>;

export function resolveDaemonSpawnRuntimeCodexBackendMode(selection: DaemonSpawnRuntimeSelection): CodexBackendMode | undefined {
  return resolveCanonicalCodexBackendMode(selection);
}

export type DaemonSpawnValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorMessage: string; reasonCode?: string }>;

export type DaemonSpawnAuthEnvResult = Readonly<{
  env: Record<string, string>;
  /**
   * Cleanup to run when we fail BEFORE the child is successfully spawned.
   */
  cleanupOnFailure?: (() => void) | null;
  /**
   * Cleanup to run when the spawned child exits (tracked by PID).
   */
  cleanupOnExit?: (() => void) | null;
}>;

export type DaemonSpawnHooks = Readonly<{
  buildAuthEnv?: (params: Readonly<{ token: string }>) => Promise<DaemonSpawnAuthEnvResult>;
  validateSpawn?: (params: DaemonSpawnRuntimeSelection) => Promise<DaemonSpawnValidationResult>;
  buildExtraEnvForChild?: (params: DaemonSpawnRuntimeSelection) => Record<string, string>;
}>;
