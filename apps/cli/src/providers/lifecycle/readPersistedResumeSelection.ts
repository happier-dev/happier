import {
  ProviderConnectionIdSchema,
  SESSION_PROVIDER_BINDING_METADATA_KEY_V1,
  SessionModelSelectionIntentV1Schema,
  createProviderErrorV1,
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

function hasRawProviderIntent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = (value as Readonly<Record<string, unknown>>).selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return false;
  const selectionRecord = selection as Readonly<Record<string, unknown>>;
  return Object.prototype.hasOwnProperty.call(selectionRecord, 'providerConnectionId')
    && selectionRecord.providerConnectionId !== null;
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
  const intent = SessionModelSelectionIntentV1Schema.safeParse(rawIntent);
  const intentData = intent.success ? intent.data : null;
  const selection = intentData?.selection ?? null;
  if (bindingState.kind === 'invalid') {
    throw new PersistedProviderResumeBindingError(readRawConnectionIdHint(rawBinding));
  }
  const rawIntentConnectionIdHint = readRawIntentConnectionIdHint(rawIntent);
  if (!intent.success && hasRawProviderIntent(rawIntent)) {
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
