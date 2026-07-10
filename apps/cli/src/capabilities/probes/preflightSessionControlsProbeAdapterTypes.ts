import type { BackendTargetRefV1 } from '@happier-dev/protocol';

export type PreflightSessionControlsProbeFailureCacheStrategy = 'cooldown' | 'retry';
export type PreflightSessionControlsProbeKind = 'models' | 'modes' | 'configOptions';

export type PreflightSessionControlsProbeParams = Readonly<{
  backendTarget?: BackendTargetRefV1;
  probeKind?: PreflightSessionControlsProbeKind;
  cwd: string;
  timeoutMs: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  env?: NodeJS.ProcessEnv;
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
  verboseModelsCommandArgs?: ReadonlyArray<string>;
  probeModesRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
  probeConfigOptionsRaw?: (params: PreflightSessionControlsProbeParams) => Promise<unknown | null>;
}>;
