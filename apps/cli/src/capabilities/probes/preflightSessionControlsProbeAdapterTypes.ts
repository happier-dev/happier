import type { AgentCliSessionCommandPluginSettingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { PreflightCatalogCleanupScope } from './preflightCatalogCleanupScope';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

export type PreflightSessionControlsProbeFailureCacheStrategy = 'cooldown' | 'retry';
export type PreflightSessionControlsProbeKind = 'models' | 'modes' | 'configOptions' | 'passiveRealtimeSetup' | 'catalogs';

export type PreflightSessionControlsProbeParams = Readonly<{
  backendTarget?: BackendTargetRefV1;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
  runtimeKindOverride?: string;
  probeKind?: PreflightSessionControlsProbeKind;
  bypassCache?: boolean;
  cwd: string;
  timeoutMs: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  pluginSettings?: AgentCliSessionCommandPluginSettingsV1;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Existing containing catalog operation owns this deadline; direct callers retain the local budget. */
  deadlineSignal?: AbortSignal;
  cleanupScope?: PreflightCatalogCleanupScope;
}>;

/**
 * Provider-owned adapter for probing dynamic session controls (models/modes/config options)
 * without starting a full ACP session.
 *
 * The probe functions return raw payloads (best-effort). Callers must normalize/validate.
 */
export type PreflightSessionControlsProbeAdapter = Readonly<{
  failureCacheStrategy?: PreflightSessionControlsProbeFailureCacheStrategy;
  probeCatalogsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown>;
  probeModelsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probeModesRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probeConfigOptionsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probePassiveRealtimeSetupRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
}>;
