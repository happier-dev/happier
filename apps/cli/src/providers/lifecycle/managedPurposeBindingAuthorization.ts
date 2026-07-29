import {
  qualifiedPurposeKey,
  type QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';

import type {
  ResolvedFirstPartyManagedProviderFacet,
} from '@/providers/managed/types';

function serviceKey(service: Readonly<{
  pluginId: string;
  localId: string;
}>): string {
  return JSON.stringify([service.pluginId, service.localId]);
}

/**
 * Canonical effect-boundary check that a managed Provider's authorized
 * purpose snapshot contains only the exact services declared by its facet.
 */
export function managedPurposeBindingsMatchFacet(input: Readonly<{
  identity: Readonly<{ pluginId: string; localId: string }>;
  facet: ResolvedFirstPartyManagedProviderFacet;
  bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
}>): boolean {
  if (input.bindings.length === 0) return false;
  const declarationsByPurpose = new Map(
    input.facet.connectedAccounts.map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  if (declarationsByPurpose.size !== input.facet.connectedAccounts.length) {
    return false;
  }
  const seenPurposes = new Set<string>();
  for (const binding of input.bindings) {
    if (
      binding.purpose.consumer.pluginId !== input.identity.pluginId
      || binding.purpose.consumer.localId !== input.identity.localId
    ) {
      return false;
    }
    const purposeKey = qualifiedPurposeKey(binding.purpose);
    if (seenPurposes.has(purposeKey)) return false;
    seenPurposes.add(purposeKey);
    const declaration = declarationsByPurpose.get(binding.purpose.purpose);
    if (!declaration) return false;
    const targetService = binding.target.kind === 'account'
      ? binding.target.account.service
      : binding.target.service;
    if (serviceKey(targetService) !== serviceKey(declaration.service)) {
      return false;
    }
  }
  return input.facet.connectedAccounts.every((declaration) => (
    declaration.required !== true
    || input.bindings.some((binding) => (
      binding.purpose.purpose === declaration.purpose
    ))
  ));
}
