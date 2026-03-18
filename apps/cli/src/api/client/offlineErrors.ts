import axios from 'axios';

import { connectionState, isNetworkError } from '@/api/offline/serverConnectionErrors';

function readBootstrapErrorStatus(error: unknown): number | null {
  if (axios.isAxiosError(error)) {
    return typeof error.response?.status === 'number' ? error.response.status : null;
  }

  if (error && typeof error === 'object' && 'response' in error) {
    const status = (error as { response?: { status?: unknown } }).response?.status;
    return typeof status === 'number' ? status : null;
  }

  return null;
}

function readBootstrapNetworkErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
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

  const status = readBootstrapErrorStatus(params.error);
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
