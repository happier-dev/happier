import type { AgentCliSessionCommandPluginSettingsV1, AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { PreflightCatalogCleanupScope } from './preflightCatalogCleanupScope';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { ProbedCatalogOptionValue } from '@happier-dev/protocol/capabilities';

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
  configOptionOverrides?: Readonly<Record<string, ProbedCatalogOptionValue>>;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** The containing preflight operation owns this deadline; direct callers retain the local budget. */
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
  /** Borrow the containing operation's cancellation and the existing declared process owner. */
  withNativeInspection?<T>(
    params: Pick<PreflightSessionControlsProbeParams, 'cwd' | 'env' | 'signal' | 'runtimeDescriptorV1'>,
    inspect: (context: Pick<AgentPreflightSessionControlsProbeContextV1, 'withDeclaredJsonRpcClient'>) => Promise<T>,
  ): Promise<T>;
  failureCacheStrategy?: PreflightSessionControlsProbeFailureCacheStrategy;
  probeCatalogsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown>;
  probeModelsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probeModesRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probeConfigOptionsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probePassiveRealtimeSetupRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
}>;
