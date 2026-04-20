import type { CodexBackendMode } from '@happier-dev/agents';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { CanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';

export type DaemonSpawnRuntimeSelection = CanonicalSpawnRuntimeSelection & Readonly<{
  codexBackendMode?: CodexBackendMode;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

export type DaemonSpawnValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorMessage: string; reasonCode?: string }>;

export type DaemonSpawnHooks = Readonly<{
  resolveRuntimePrerequisites?: (params: DaemonSpawnRuntimeSelection) => Promise<DaemonSpawnValidationResult>;
  augmentEnv?: (params: DaemonSpawnRuntimeSelection) => Record<string, string>;
}>;
