export type FingerprintPublicationState = Readonly<{
  lastPublishedFingerprint: string | null;
  rollbackFingerprint: string | null;
}>;

export type FingerprintPublicationDecision =
  | Readonly<{
    publish: false;
    state: FingerprintPublicationState;
    reason: 'unchanged';
  }>
  | Readonly<{
    publish: true;
    state: FingerprintPublicationState;
    reason: 'changed';
  }>;

function normalizeFingerprint(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

export function createFingerprintPublicationState(
  lastPublishedFingerprint: string | null | undefined = null,
): FingerprintPublicationState {
  return {
    lastPublishedFingerprint: normalizeFingerprint(lastPublishedFingerprint),
    rollbackFingerprint: null,
  };
}

export function resolveFingerprintPublication(params: Readonly<{
  state: FingerprintPublicationState;
  nextFingerprint: string;
}>): FingerprintPublicationDecision {
  const nextFingerprint = normalizeFingerprint(params.nextFingerprint);
  if (params.state.lastPublishedFingerprint === nextFingerprint) {
    return {
      publish: false,
      state: params.state,
      reason: 'unchanged',
    };
  }

  return {
    publish: true,
    state: {
      lastPublishedFingerprint: nextFingerprint,
      rollbackFingerprint: params.state.lastPublishedFingerprint,
    },
    reason: 'changed',
  };
}

export function rollbackFingerprintPublication(
  state: FingerprintPublicationState,
): FingerprintPublicationState {
  return {
    lastPublishedFingerprint: state.rollbackFingerprint,
    rollbackFingerprint: null,
  };
}
