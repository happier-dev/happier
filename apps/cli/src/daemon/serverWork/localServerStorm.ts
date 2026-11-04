import type { RuntimeAuthRecoveryDiagnostic, RuntimeAuthRecoverySchedulerDeps } from '../connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { classifyDaemonServerWorkError } from './classifyDaemonServerWorkError';

export function shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure(input: Readonly<{
  retryable?: boolean | null;
  kind?: string | null;
}> | null | undefined): boolean {
  return Boolean(input?.retryable && (input.kind === 'timeout' || input.kind === 'network' || input.kind === 'server_error'));
}

/** Shared daemon admission composition; HTTP outcomes remain owned by the tracker. */
export function createRuntimeAuthRecoveryLocalServerGate(input: Readonly<{
  nowMs: () => number;
  isShuttingDown: () => boolean;
  storm: Pick<ReturnType<typeof createLocalServerStormTracker>, 'failureCount'>;
  threshold: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitterMs: () => number;
}>): NonNullable<RuntimeAuthRecoverySchedulerDeps['gate']> {
  return ({ intent }) => {
    const nowMs = input.nowMs();
    if (input.isShuttingDown()) return { status: 'delayed',
      retryAtMs: intent.nextRetryAtMs ?? nowMs, reason: 'daemon_lifecycle_unavailable' };
    if (!shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure(intent.lastErrorClassification)) return { status: 'open' };
    const stormCount = input.storm.failureCount();
    if (stormCount < input.threshold) return { status: 'open' };
    return { status: 'delayed', reason: 'local_server_storm', retryAtMs: nowMs + Math.min(
      input.maxBackoffMs,
      input.baseBackoffMs * (2 ** Math.min(6, stormCount - input.threshold + 1)),
    ) + input.jitterMs() };
  };
}

export function createLocalServerStormTracker(input: Readonly<{ nowMs: () => number; windowMs: number;
  serverUrl?: string; client?: AxiosInstance }>) {
  const failures: number[] = [];
  const serverOrigin = input.serverUrl ? new URL(input.serverUrl).origin : null;
  const client = input.client ?? axios;
  const isLocalRequest = (config: AxiosRequestConfig | undefined): boolean => {
    if (!serverOrigin || !config?.url) return false;
    try { return new URL(config.url, config.baseURL).origin === serverOrigin; }
    catch { return false; } // Malformed URLs never establish local-server health.
  };
  // Observe completed HTTP attempts, never classifications replayed by recovery intents.
  // This also sees successful ordinary server reads while quota/recovery work is gated.
  const observer = serverOrigin === null ? null : client.interceptors.response.use((response) => {
    if (isLocalRequest(response.config)) {
      if (response.status >= 200 && response.status < 400) failures.length = 0;
      else if (shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure(
        classifyDaemonServerWorkError({ status: response.status }),
      )) failures.push(input.nowMs());
    }
    return response;
  }, (error: unknown) => {
    if (axios.isAxiosError(error) && isLocalRequest(error.config)
      && shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure(classifyDaemonServerWorkError(error))) {
      failures.push(input.nowMs());
    }
    return Promise.reject(error);
  });
  return {
    recordRecoveryDiagnostic(event: RuntimeAuthRecoveryDiagnostic): void {
      if (event.event === 'runtime_auth_recovery_success') failures.length = 0;
    },
    recordSuccess(): void { failures.length = 0; },
    dispose(): void { if (observer !== null) client.interceptors.response.eject(observer); },
    failureCount(): number {
      while (failures.length > 0 && failures[0]! <= input.nowMs() - input.windowMs) failures.shift();
      return failures.length;
    },
  };
}
