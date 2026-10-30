const CONNECTED_SERVICE_AUTH_GENERATION_APPLY_FAILED_PREFIX = 'connected_service_auth_generation_apply_failed:';

export type ConnectedServiceAuthGenerationApplyFailure = Readonly<{
  errorCode: string;
  retryable?: true;
  diagnostics?: unknown;
}>;

export function isRetryableConnectedServiceCredentialApplyFailure(
  errorCode: string,
): errorCode is 'credential_revision_missing' | 'credential_revision_superseded' {
  return errorCode === 'credential_revision_missing' || errorCode === 'credential_revision_superseded';
}

export function createConnectedServiceAuthGenerationApplyFailureError(
  failure: ConnectedServiceAuthGenerationApplyFailure,
): Error {
  const error = new Error(`${CONNECTED_SERVICE_AUTH_GENERATION_APPLY_FAILED_PREFIX}${failure.errorCode || 'unknown'}`);
  Object.assign(error, {
    connectedServiceAuthGenerationApplyFailure: {
      errorCode: failure.errorCode || 'unknown',
      ...(failure.diagnostics === undefined ? {} : { diagnostics: failure.diagnostics }),
    },
  });
  return error;
}

export function readConnectedServiceAuthGenerationApplyFailure(
  error: unknown,
): ConnectedServiceAuthGenerationApplyFailure | null {
  if (!(error instanceof Error)) return null;
  if (!error.message.startsWith(CONNECTED_SERVICE_AUTH_GENERATION_APPLY_FAILED_PREFIX)) return null;
  const code = error.message.slice(CONNECTED_SERVICE_AUTH_GENERATION_APPLY_FAILED_PREFIX.length).trim();
  const metadata = (error as Readonly<{
    connectedServiceAuthGenerationApplyFailure?: unknown;
  }>).connectedServiceAuthGenerationApplyFailure;
  const diagnostics = metadata && typeof metadata === 'object'
    ? (metadata as Readonly<{ diagnostics?: unknown }>).diagnostics
    : undefined;
  return {
    errorCode: code.length > 0 ? code : 'unknown',
    ...(isRetryableConnectedServiceCredentialApplyFailure(code) ? { retryable: true as const } : {}),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}
