import type { BackendTargetRefV1 } from '@happier-dev/protocol';

export type PreflightModelsProbeFailureCacheStrategy = 'cooldown' | 'retry';

export type PreflightModelsProbeParams = Readonly<{
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  timeoutMs: number;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>;

/**
 * Provider-owned adapter for probing a dynamic model list without having to
 * start a full ACP session.
 *
 * - `probeModelsRaw` returns the raw model list payload (best-effort).
 *   The caller will normalize/validate the shape.
 * - `cliModelsCommandArgs` is a lightweight CLI fallback for providers that
 *   expose a `models` style command.
 */
export type PreflightModelsProbeAdapter = Readonly<{
  failureCacheStrategy?: PreflightModelsProbeFailureCacheStrategy;
  probeModelsRaw?: (params: PreflightModelsProbeParams) => Promise<unknown | null>;
  cliModelsCommandArgs?: ReadonlyArray<string>;
}>;
