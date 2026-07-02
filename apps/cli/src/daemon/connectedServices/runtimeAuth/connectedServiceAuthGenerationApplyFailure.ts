const CONNECTED_SERVICE_AUTH_GENERATION_APPLY_FAILED_PREFIX = 'connected_service_auth_generation_apply_failed:';

export type ConnectedServiceAuthGenerationApplyFailure = Readonly<{
  errorCode: string;
  diagnostics?: unknown;
}>;

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
    errorCode: code || 'unknown',
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}
