import { QualifiedConnectedAccountPurposeBindingsV1Schema, qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { PluginContributionIdentityV1, QualifiedConnectedAccountPurposeBindingTargetV1, QualifiedConnectedAccountPurposeBindingV1, QualifiedConnectedAccountPurposeBindingsV1, QualifiedConnectedAccountPurposeV1, ResolvedProviderManagedRuntimeDeclarationV1 } from '@happier-dev/protocol';
import { createProviderErrorV1, ProviderErrorV1Schema, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { rethrowRequesterHomeReadFailure } from '@/daemon/sessionEncryption/requesterCurrentness';
import { ProviderOperationAbandonedError } from '../operationLifetime';
import { isConnectedAccountSourceReconnectRequiredError } from '@/daemon/connectedServices/purposeBindings/sourceHealth';
import { providerErrorFromRpcFailure } from '@happier-dev/protocol/providers/errors';

/** Binding absence requires repair; an unreadable Home cannot establish absence. */
export function providerManagedPurposeBindingError(error: unknown, context: Readonly<{ connectionId?: string; machineId: string }>): ProviderErrorV1 {
  if (error instanceof ProviderOperationAbandonedError || error instanceof Error && error.name === 'AbortError') throw error;
  if (isConnectedAccountSourceReconnectRequiredError(error)) return providerErrorFromRpcFailure(error, context);
  const typed = ProviderErrorV1Schema.safeParse(error);
  if (typed.success) return typed.data;
  try { rethrowRequesterHomeReadFailure(error); }
  catch { return createProviderErrorV1('provider_catalog_unavailable', context, error); }
  return createProviderErrorV1('provider_connection_invalid', context, error);
}

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
  connectedAccounts:
    ResolvedProviderManagedRuntimeDeclarationV1['connectedAccounts'];
  purposeBindingIntents: QualifiedConnectedAccountPurposeBindingsV1;
  resolveBindingIntent: ResolveManagedProviderPurposeBindingIntent;
  signal?: AbortSignal;
}>): Promise<QualifiedConnectedAccountPurposeBindingsV1> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const intents = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
    input.purposeBindingIntents,
  );
  const connectedAccounts = input.connectedAccounts;
  const declarationsByPurpose = new Map(
    connectedAccounts.map((declaration) => [
      declaration.purpose,
      declaration,
    ]),
  );
  if (
    declarationsByPurpose.size !== connectedAccounts.length
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
  if (connectedAccounts.some((declaration) => (
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
