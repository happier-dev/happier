import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  qualifiedPurposeKey,
  type PluginContributionIdentityV1,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
  type QualifiedConnectedAccountPurposeBindingV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';

import type {
  ResolvedFirstPartyManagedProviderFacet,
} from './types';

export type ResolveManagedProviderPurposeBindingIntent = (
  input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    serviceRefs: readonly PluginContributionIdentityV1[];
    signal: AbortSignal;
  }>,
) => Promise<QualifiedConnectedAccountPurposeBindingV1>;

function serviceKey(service: PluginContributionIdentityV1): string {
  return JSON.stringify([service.pluginId, service.localId]);
}

function bindingKey(binding: QualifiedConnectedAccountPurposeBindingV1): string {
  return JSON.stringify(binding);
}

/**
 * Converts caller-owned Provider binding intent into an immutable runtime
 * snapshot only through the canonical Connected Accounts binding owner.
 */
export async function resolveManagedProviderPurposeBindingSnapshot(input: Readonly<{
  implementationIdentity: PluginContributionIdentityV1;
  facet: ResolvedFirstPartyManagedProviderFacet;
  purposeBindingIntents: QualifiedConnectedAccountPurposeBindingsV1;
  resolveBindingIntent: ResolveManagedProviderPurposeBindingIntent;
  signal?: AbortSignal;
}>): Promise<QualifiedConnectedAccountPurposeBindingsV1> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const intents = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
    input.purposeBindingIntents,
  );
  const declarationsByPurpose = new Map(
    input.facet.connectedAccounts.map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  if (
    declarationsByPurpose.size !== input.facet.connectedAccounts.length
    || intents.bindings.length === 0
  ) {
    throw new Error('managed_provider_purpose_binding_intent_invalid');
  }

  const seenPurposes = new Set<string>();
  const bindings: QualifiedConnectedAccountPurposeBindingV1[] = [];
  for (const intent of intents.bindings) {
    if (
      intent.purpose.consumer.pluginId !== input.implementationIdentity.pluginId
      || intent.purpose.consumer.localId !== input.implementationIdentity.localId
    ) {
      throw new Error('managed_provider_purpose_binding_consumer_invalid');
    }
    const purposeKey = qualifiedPurposeKey(intent.purpose);
    if (seenPurposes.has(purposeKey)) {
      throw new Error('managed_provider_purpose_binding_duplicate');
    }
    seenPurposes.add(purposeKey);
    const declaration = declarationsByPurpose.get(intent.purpose.purpose);
    const targetService = intent.target.kind === 'account'
      ? intent.target.account.service
      : intent.target.service;
    if (
      !declaration
      || serviceKey(declaration.service) !== serviceKey(targetService)
    ) {
      throw new Error('managed_provider_purpose_binding_service_invalid');
    }
    const resolved = await input.resolveBindingIntent({
      purpose: intent.purpose,
      target: intent.target,
      serviceRefs: [declaration.service],
      signal,
    });
    signal.throwIfAborted();
    if (bindingKey(resolved) !== bindingKey(intent)) {
      throw new Error('managed_provider_purpose_binding_owner_mismatch');
    }
    bindings.push(resolved);
  }
  if (input.facet.connectedAccounts.some((declaration) => (
    declaration.required === true
    && !bindings.some((binding) => binding.purpose.purpose === declaration.purpose)
  ))) {
    throw new Error('managed_provider_required_purpose_binding_missing');
  }
  return QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
    v: 1,
    bindings,
  });
}
