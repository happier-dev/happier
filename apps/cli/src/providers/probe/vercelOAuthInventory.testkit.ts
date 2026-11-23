import { PluginConnectedAccountAuthenticationV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';

import { PLUGIN as vercelMachine } from '../../../../../packages/plugins/machine-vercel/src/manifest';

/**
 * A Vercel sign-in as the Home inventory lists it, resolved by the production
 * purpose-target owner. `kind` is what the Vercel sign-in settled; the Home
 * stores it unchanged, so the catalog, launch and usage readers see this value.
 */
export function createVercelOAuthInventoryTargetResolver(
  input: Readonly<{
    account: QualifiedConnectedAccountRef;
    displayName: string;
    kind: QualifiedConnectedAccountProfileV4['kind'];
    readCredentialRevision(): string;
    isConnected?(): boolean;
  }>,
) {
  const service = input.account.service;
  const descriptor = vercelMachine.manifest.contributes.connectedAccountDescriptors?.find(
    (candidate) => candidate.id === service.localId,
  );
  if (service.pluginId !== vercelMachine.manifest.id || !descriptor)
    throw new Error('Expected the Vercel Account service');
  const authentication = PluginConnectedAccountAuthenticationV2Schema.parse(
    descriptor.authentication,
  );
  return createPurposeTargetResolver({
    available: true,
    resolveService: async (ref) =>
      ref.pluginId === service.pluginId && ref.localId === service.localId
        ? { service, authentication }
        : null,
    listAccounts: async () =>
      input.isConnected?.() === false
        ? []
        : [
            {
              ref: input.account,
              status: 'connected',
              authenticationModeId: 'oauth',
              revisionSemantics: 'revisioned',
              credentialRevision: input.readCredentialRevision(),
              configurationReady: true,
              configurationRevision: null,
              kind: input.kind,
              expiresAt: null,
              displayName: input.displayName,
              scopes: [],
            },
          ],
  });
}
