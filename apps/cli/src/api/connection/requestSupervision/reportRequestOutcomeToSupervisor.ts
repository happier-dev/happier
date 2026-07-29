import type { ManagedConnectionSupervisor, ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { createAuthenticationHttpStatusError, isAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { isNetworkError, readNormalizedErrorCode } from '@/api/offline/serverConnectionErrors';

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function toProbeResult(params: Readonly<{
  statusCode: number | null;
  error?: unknown;
  hadAuth: boolean;
  outcomeSupervision: 'connection_health' | 'authentication_only';
}>): Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>> | null {
  if (params.hadAuth && isAuthenticationStatus(params.statusCode)) {
    return {
      status: 'auth_failed',
      ...(typeof params.statusCode === 'number' ? { statusCode: params.statusCode } : {}),
      errorMessage: readErrorMessage(params.error, `HTTP ${params.statusCode}`),
    };
  }

  if (params.outcomeSupervision === 'authentication_only') {
    return null;
  }

  if (typeof params.statusCode === 'number' && params.statusCode >= 500) {
    return {
      status: 'retry_later',
      errorMessage: readErrorMessage(params.error, `HTTP ${params.statusCode}`),
    };
  }

  const networkErrorCode = readNormalizedErrorCode(params.error);
  if (networkErrorCode && isNetworkError(networkErrorCode)) {
    return {
      status: 'server_unreachable',
      errorMessage: readErrorMessage(params.error, `Request failed (${networkErrorCode})`),
    };
  }

  return null;
}

export function reportRequestOutcomeToSupervisor(params: Readonly<{
  supervisor: ManagedConnectionSupervisor;
  statusCode?: number | null;
  error?: unknown;
  hadAuth: boolean;
  scope?: ReturnType<NonNullable<ManagedConnectionSupervisor['captureProbeReportScope']>>;
  outcomeSupervision?: 'connection_health' | 'authentication_only';
}>): void {
  const scope = params.scope ?? params.supervisor.captureProbeReportScope?.();
  const probe = toProbeResult({
    statusCode: params.statusCode ?? readHttpStatus(params.error),
    error: params.error,
    hadAuth: params.hadAuth,
    outcomeSupervision: params.outcomeSupervision ?? 'connection_health',
  });
  if (!probe) {
    return;
  }
  // Avoid passing a meaningless trailing `undefined` so test harnesses and
  // light-weight supervisor stubs can assert on a stable call signature.
  if (scope === undefined) {
    params.supervisor.reportProbeResult?.(probe);
    return;
  }
  params.supervisor.reportProbeResult?.(probe, scope);
}

export function handleRequestAuthenticationFailure(params: Readonly<{
  supervisor?: ManagedConnectionSupervisor | null;
  statusCode?: number | null;
  error?: unknown;
  hadAuth: boolean;
}>): boolean {
  const statusCode = params.statusCode ?? readHttpStatus(params.error);
  if (!params.hadAuth || !isAuthenticationStatus(statusCode)) {
    return false;
  }

  if (params.supervisor) {
    reportRequestOutcomeToSupervisor({
      supervisor: params.supervisor,
      statusCode,
      error: params.error,
      hadAuth: params.hadAuth,
    });
    return true;
  }

  throw params.error ?? createAuthenticationHttpStatusError(statusCode, `Authentication failed (${statusCode})`);
}
