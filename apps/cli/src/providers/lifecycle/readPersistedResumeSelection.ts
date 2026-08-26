import {
  ProviderConnectionIdSchema,
  SESSION_PROVIDER_BINDING_METADATA_KEY_V1,
  createProviderErrorV1,
  readSessionModelSelectionIntentSourceV1,
  readSessionProviderBindingMetadataStateV1,
  type ProviderErrorV1,
  type SessionModelSelectionV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';

export class PersistedProviderResumeBindingError extends Error {
  readonly providerError: ProviderErrorV1;

  constructor(connectionId?: string) {
    const providerError = createProviderErrorV1('provider_binding_changed', {
      ...(connectionId ? { connectionId } : {}),
    });
    super(providerError.code);
    this.name = 'PersistedProviderResumeBindingError';
    this.providerError = providerError;
  }
}

function readCanonicalConnectionId(value: unknown): string | undefined {
  const parsed = ProviderConnectionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readRawConnectionIdHint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return readCanonicalConnectionId((value as Readonly<Record<string, unknown>>).connectionId);
}

function readRawIntentConnectionIdHint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const selection = (value as Readonly<Record<string, unknown>>).selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return undefined;
  return readCanonicalConnectionId(
    (selection as Readonly<Record<string, unknown>>).providerConnectionId,
  );
}

/**
 * Restores the next-launch model intent independently from the previous active
 * Provider binding. A restart-required proposal is expected to differ from the
 * still-active binding until the replacement launch commits.
 */
export function readPersistedProviderResumeState(
  metadata: Readonly<Record<string, unknown>> | null,
): Readonly<{
  selection: SessionModelSelectionV1 | null;
  binding: SessionProviderBindingMetadataV1 | null;
}> {
  const rawBinding = metadata?.[SESSION_PROVIDER_BINDING_METADATA_KEY_V1];
  const rawIntent = metadata?.modelSelectionIntentV1;
  const bindingState = readSessionProviderBindingMetadataStateV1(metadata);
  const binding = bindingState.kind === 'valid' ? bindingState.binding : null;
  // Protocol owns canonical-carrier presence and invalidity. In particular, a
  // present malformed value is corrupted state, never an implicit native
  // selection merely because it lacks a recognizable Provider-shaped field.
  const intentSource = readSessionModelSelectionIntentSourceV1({
    canonical: rawIntent,
    legacy: undefined,
  });
  const intentData = intentSource.status === 'canonical' ? intentSource.intent : null;
  const selection = intentData?.selection ?? null;
  if (bindingState.kind === 'invalid') {
    throw new PersistedProviderResumeBindingError(readRawConnectionIdHint(rawBinding));
  }
  const rawIntentConnectionIdHint = readRawIntentConnectionIdHint(rawIntent);
  if (intentSource.status === 'invalid') {
    throw new PersistedProviderResumeBindingError(rawIntentConnectionIdHint);
  }
  if (!intentData || !selection) {
    if (binding) {
      throw new PersistedProviderResumeBindingError(binding.connectionId);
    }
    return { selection: null, binding: null };
  }
  return {
    selection: { v: 1, updatedAt: intentData.updatedAt, ref: selection },
    binding,
  };
}
