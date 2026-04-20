import { readHttpStatus } from '@/api/client/httpStatusError';
import { connectionState, isNetworkError, readNormalizedErrorCode } from '@/api/offline/serverConnectionErrors';

function readBootstrapNetworkErrorCode(error: unknown): string | null {
  return readNormalizedErrorCode(error);
}

function markOfflineBootstrapFailure(params: Readonly<{
  operation: string;
  url: string;
  errorCode: string;
  caller?: string;
  details?: readonly string[];
}>): void {
  connectionState.fail({
    operation: params.operation,
    caller: params.caller,
    errorCode: params.errorCode,
    url: params.url,
    details: params.details ? [...params.details] : undefined,
  });
}

function shouldTreatBootstrapErrorAsOffline(params: Readonly<{
  error: unknown;
  operation: string;
  url: string;
  caller?: string;
  treat404AsOffline?: boolean;
  treat5xxAsOffline?: boolean;
  ignoredStatuses?: readonly number[];
  retryDetails?: readonly string[];
}>): boolean {
  const networkErrorCode = readBootstrapNetworkErrorCode(params.error);
  if (networkErrorCode && isNetworkError(networkErrorCode)) {
    markOfflineBootstrapFailure({
      operation: params.operation,
      caller: params.caller,
      errorCode: networkErrorCode,
      url: params.url,
    });
    return true;
  }

  const status = readHttpStatus(params.error);
  if (status === null) {
    return false;
  }

  if (params.ignoredStatuses?.includes(status)) {
    return false;
  }

  if (params.treat404AsOffline === true && status === 404) {
    markOfflineBootstrapFailure({
      operation: params.operation,
      caller: params.caller,
      errorCode: '404',
      url: params.url,
    });
    return true;
  }

  if (params.treat5xxAsOffline === true && status >= 500) {
    markOfflineBootstrapFailure({
      operation: params.operation,
      caller: params.caller,
      errorCode: String(status),
      url: params.url,
      details: params.retryDetails,
    });
    return true;
  }

  return false;
}

export function shouldTreatGetOrCreateSessionErrorAsOffline(
  error: unknown,
  params: Readonly<{ url: string }>
): boolean {
  return shouldTreatBootstrapErrorAsOffline({
    error,
    operation: 'Session creation',
    caller: 'api.getOrCreateSession',
    url: params.url,
    treat404AsOffline: true,
  });
}

export function shouldTreatGetOrCreateMachineErrorAsOffline(
  error: unknown,
  params: Readonly<{ url: string }>
): boolean {
  return shouldTreatBootstrapErrorAsOffline({
    error,
    operation: 'Machine registration',
    caller: 'api.getOrCreateMachine',
    url: params.url,
    treat404AsOffline: true,
    treat5xxAsOffline: true,
    ignoredStatuses: [409],
    retryDetails: ['Server encountered an error, will retry automatically'],
  });
}
