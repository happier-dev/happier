import type { BackendTargetRefV1 } from '@happier-dev/protocol';

export type PreflightSessionControlsProbeFailureCacheStrategy = 'cooldown' | 'retry';

export type PreflightSessionControlsProbeParams = Readonly<{
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>;

/**
 * Provider-owned adapter for probing dynamic session controls (models/modes/config options)
 * without starting a full ACP session.
 *
 * The probe functions return raw payloads (best-effort). Callers must normalize/validate.
 */
export type PreflightSessionControlsProbeAdapter = Readonly<{
  failureCacheStrategy?: PreflightSessionControlsProbeFailureCacheStrategy;
  probeModelsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  cliModelsCommandArgs?: ReadonlyArray<string>;
  probeModesRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probeConfigOptionsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
}>;
