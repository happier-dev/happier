import type { BackendTargetRefV1, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { RegisterNativeCatalogCleanup } from './catalogProbeLifecycle';

export type PreflightSessionControlsProbeFailureCacheStrategy = 'cooldown' | 'retry';
export type PreflightModelsProbeCachePolicy = 'generic' | 'provider-owned';
export type PreflightSessionControlsProbeMethod = 'probeModels' | 'probeModes' | 'probeConfigOptions' | 'probeCatalogs';
export type PreflightConnectedServiceAuthStrategy = 'materialized-env' | 'provider-owned' | 'not-required';

export type PreflightSessionCatalogsRaw = Readonly<{
  /** Null denotes a channel the selected provider transport does not support. */
  commands: unknown[] | null;
  skills: unknown[] | null;
  diagnostic?: string;
}>;

export type PreflightSessionControlsProbeParams = Readonly<{
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs: number;
  /** Native catalogs consume the containing RPC budget, including preparation. */
  deadlineAt?: number;
  signal?: AbortSignal;
  /** Private host lifecycle hook: register only cleanup of resources actually acquired. */
  onNativeCleanup?: RegisterNativeCatalogCleanup;
  bypassCache?: boolean;
  includeConfiguredModel?: boolean;
  profileId?: string | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
  connectedServices?: ConnectedServiceBindingsV1 | null;
  processEnv?: NodeJS.ProcessEnv;
}>;

/**
 * Provider-owned adapter for probing dynamic controls and native command/skill catalogs
 * before starting a Happier session or submitting a user turn.
 *
 * Models may return an array or { availableModels, source?, observedAt?, refreshError? } when the
 * provider owns cached observation provenance. Null means discovery failed.
 * A models hook owns its complete provider fallback; null does not trigger generic
 * CLI or ACP discovery. Providers without a hook retain the generic discovery path.
 * Callers must normalize/validate all raw payloads.
 */
export type PreflightSessionControlsProbeAdapter = Readonly<{
  /** Static methods need no auth; provider-owned methods resolve credentials; ACP methods need materialization. */
  connectedServiceAuth?: 'materialized-env' | Readonly<Partial<Record<PreflightSessionControlsProbeMethod, PreflightConnectedServiceAuthStrategy>>>;
  modelProbeCachePolicy?: PreflightModelsProbeCachePolicy;
  failureCacheStrategy?: PreflightSessionControlsProbeFailureCacheStrategy;
  probeModelsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  cliModelsCommandArgs?: ReadonlyArray<string>;
  probeModesRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probeConfigOptionsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  /** Catalog hooks own discovery. Unsupported channels are null; unavailable discovery throws. */
  probeCatalogsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<PreflightSessionCatalogsRaw>;
}>;
