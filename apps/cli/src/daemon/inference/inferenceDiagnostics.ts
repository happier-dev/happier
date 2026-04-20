export type InferenceRuntimeState =
  | 'unavailable'
  | 'idle'
  | 'downloading'
  | 'warming'
  | 'ready'
  | 'degraded'
  | 'error';

export type InferenceDiagnostics = Readonly<{
  runtimeState: InferenceRuntimeState;
  usingFallback: boolean;
  lastError: string | null;
}>;

export function createInferenceDiagnostics(
  params: Readonly<{
    runtimeState: InferenceRuntimeState;
    usingFallback?: boolean;
    lastError?: string | null;
  }>,
): InferenceDiagnostics {
  return {
    runtimeState: params.runtimeState,
    usingFallback: params.usingFallback ?? false,
    lastError: params.lastError ?? null,
  };
}

export function createUnavailableInferenceDiagnostics(): InferenceDiagnostics {
  return createInferenceDiagnostics({ runtimeState: 'unavailable' });
}
