import type {
  ConnectedServiceBindingSelectionV1,
  ConnectedServiceBindingsV1,
  SessionContinuationRecoveryIdentityV1,
} from '@happier-dev/protocol';

function normalizeNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readConnectedBindingIdentity(input: Readonly<{
  serviceId: string;
  binding: ConnectedServiceBindingSelectionV1 | undefined;
  failureFingerprint?: string | null;
  targetGeneration?: number | null;
}>): SessionContinuationRecoveryIdentityV1 | null {
  const serviceId = normalizeNonEmpty(input.serviceId);
  if (!serviceId) return null;
  const binding = input.binding;
  if (!binding || binding.source !== 'connected') return null;

  const profileId = normalizeNonEmpty((binding as { profileId?: unknown }).profileId);
  const failureFingerprint = normalizeNonEmpty(input.failureFingerprint);
  const targetGeneration = typeof input.targetGeneration === 'number' && Number.isFinite(input.targetGeneration)
    ? Math.max(0, Math.trunc(input.targetGeneration))
    : null;

  if (binding.selection === 'group') {
    const groupId = normalizeNonEmpty((binding as { groupId?: unknown }).groupId);
    if (!groupId) return null;
    return {
      serviceId,
      selectionKind: 'group',
      groupId,
      ...(profileId ? { profileId } : {}),
      ...(failureFingerprint ? { failureFingerprint } : {}),
      ...(targetGeneration === null ? {} : { targetGeneration }),
    };
  }

  if (!profileId) return null;
  return {
    serviceId,
    selectionKind: 'profile',
    profileId,
    ...(failureFingerprint ? { failureFingerprint } : {}),
    ...(targetGeneration === null ? {} : { targetGeneration }),
  };
}

export function buildContinuationRecoveryIdentityFromBindings(input: Readonly<{
  serviceIds: ReadonlySet<string>;
  bindings: ConnectedServiceBindingsV1;
  failureFingerprint?: string | null;
  targetGenerationByServiceId?: Readonly<Record<string, number | null | undefined>> | null;
}>): SessionContinuationRecoveryIdentityV1 | null {
  if (input.serviceIds.size !== 1) return null;
  const serviceId = [...input.serviceIds][0];
  if (!serviceId) return null;
  return readConnectedBindingIdentity({
    serviceId,
    binding: input.bindings.bindingsByServiceId[serviceId],
    failureFingerprint: input.failureFingerprint,
    targetGeneration: input.targetGenerationByServiceId?.[serviceId] ?? null,
  });
}

export function listContinuationRecoveryIdentitiesFromBindings(
  bindings: ConnectedServiceBindingsV1,
): SessionContinuationRecoveryIdentityV1[] {
  const identities: SessionContinuationRecoveryIdentityV1[] = [];
  for (const [serviceId, binding] of Object.entries(bindings.bindingsByServiceId)) {
    const identity = readConnectedBindingIdentity({ serviceId, binding });
    if (identity) identities.push(identity);
  }
  return identities;
}
