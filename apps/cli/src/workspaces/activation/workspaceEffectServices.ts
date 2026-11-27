import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { ConnectedAccountMaterializationRequestSchema } from '@happier-dev/protocol/connect/connected-account-purposes';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { deriveScmHostingProviderConnectedAccountPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { WorkspaceCheckoutEffect } from './workspaceEffect';
import { privateProjectCheckoutRefusal } from './privateProjectCheckout';

type Owner = Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'listAccounts' | 'materialize'>;

/** Only an existing requester-scoped owner may be supplied. This projection
 * narrows its existing declaration authority; it cannot create a target, binding
 * selection, credential, Session or native-home authority. */
export function createWorkspaceEffectConnectedAccounts(input: Readonly<{
  effect: Pick<WorkspaceCheckoutEffect, 'contributions'>;
  owner: Owner;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}>): Owner {
  const purposes = (input.effect.contributions.scmHostingProviders ?? [])
    .map(deriveScmHostingProviderConnectedAccountPurposeAuthorization).filter(value => value !== null);
  const refusal = () => privateProjectCheckoutRefusal();
  // By value: a request crossing the child's frame is plain JSON, while declarations are parsed identities.
  const serviceRefsKey = (refs: readonly Readonly<{ pluginId: string; localId: string }>[]) =>
    JSON.stringify(refs.map(ref => [ref.pluginId, ref.localId]));
  const requestKey = (request: Parameters<Owner['getBinding']>[0]) => {
    try { return `${qualifiedPurposeKey(request.purpose)}|${serviceRefsKey(request.serviceRefs)}`; }
    catch { throw refusal(); }
  };
  const authorize = async (request: Parameters<Owner['getBinding']>[0]) => {
    input.signal.throwIfAborted();
    await input.assertCurrent();
    const key = requestKey(request);
    const purpose = purposes.find(value => `${qualifiedPurposeKey(value.purpose)}|${serviceRefsKey(value.serviceRefs)}` === key);
    if (!purpose || request.exactPurposeBindingSubjectId !== undefined || request.sessionId !== undefined) throw refusal();
    return { purpose: purpose.purpose, serviceRefs: purpose.serviceRefs,
      signal: AbortSignal.any([input.signal, request.signal]) };
  };
  return {
    async getBinding(request) {
      const admitted = await authorize(request);
      const result = await input.owner.getBinding({ ...admitted, requireSelected: true });
      await input.assertCurrent(); return result;
    },
    async listAccounts(request) {
      const admitted = await authorize(request);
      const result = await input.owner.listAccounts({ ...admitted, ...(request.limit === undefined ? {} : { limit: request.limit }) });
      await input.assertCurrent(); return result;
    },
    async materialize(request) {
      const admitted = await authorize(request);
      const materialization = ConnectedAccountMaterializationRequestSchema.parse(request.request);
      // SCM receives HTTP authentication only. Files/native homes and callbacks
      // remain owned by their existing host materialization paths.
      if (materialization.kind !== 'httpHeaders' || request.nativeService !== undefined
        || request.existingFiles !== undefined || request.recordOperationCredentialUse !== undefined
        || request.credentialRevisionBasis !== undefined) throw refusal();
      const result = await input.owner.materialize({ ...admitted, request: materialization,
        ...(request.expectedAccount ? { expectedAccount: QualifiedConnectedAccountRefSchema.parse(request.expectedAccount) } : {}) });
      await input.assertCurrent(); return result;
    },
  };
}
