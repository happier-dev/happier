import { isDeepStrictEqual } from 'node:util';
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
  effect: WorkspaceCheckoutEffect;
  owner: Owner;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}>): Owner {
  const purposes = (input.effect.contributions.scmHostingProviders ?? [])
    .map(deriveScmHostingProviderConnectedAccountPurposeAuthorization).filter(value => value !== null);
  const refusal = () => privateProjectCheckoutRefusal();
  const authorize = async (request: Parameters<Owner['getBinding']>[0]) => {
    input.signal.throwIfAborted();
    await input.assertCurrent();
    const purpose = purposes.find(value => isDeepStrictEqual(value.purpose, request.purpose)
      && isDeepStrictEqual(value.serviceRefs, request.serviceRefs));
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
