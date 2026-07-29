import {
  ProviderRuntimeBindingBasisV1Schema,
  type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';

import type { ProviderSpawnAuthorization } from './resolve';

/**
 * Projects the bounded, non-secret, model-independent facts that were
 * authorized for one live Provider binding. This projection is carried by the
 * existing session binding metadata owner so later model transitions compare
 * against launch truth rather than reconstructing it from mutable settings.
 */
export function projectProviderRuntimeBindingBasis(
  authorization: ProviderSpawnAuthorization,
): ProviderRuntimeBindingBasisV1 {
  const binding = authorization.binding;
  const common = {
    v: 1 as const,
    agentTargetKey: binding.agentTargetKey,
    connectionId: binding.selection.connectionId,
    contributionKey: binding.contributionKey,
    runtimeCredentialTransport: binding.runtimeCredentialTransport,
    prepared: authorization.prepared,
    adapterVersion: authorization.adapterVersion,
    agentSupport: authorization.support,
  };
  return ProviderRuntimeBindingBasisV1Schema.parse(
    authorization.deployment.kind === 'managedLocal'
      ? {
          ...common,
          deployment: {
            kind: 'managedLocal',
            securityFacts: {
              implementationIdentity:
                authorization.deployment.implementation
                  .implementationIdentity,
              managedEndpoint:
                authorization.deployment.implementation.facet
                  .managedEndpoint,
              connectedAccounts:
                authorization.deployment.implementation.facet
                  .connectedAccounts,
              requestAuthUses:
                authorization.deployment.implementation.facet
                  .requestAuthUses,
            },
            purposeBindings:
              authorization.deployment.implementation.purposeBindings,
          },
          endpoint: authorization.binding.endpoint,
          credentialAuthorization: {
            connectionSecurityFingerprint:
              authorization.ticket.connectionSecurityFingerprint,
            grantFingerprint: authorization.ticket.grantFingerprint,
          },
        }
      : {
          ...common,
          deployment: { kind: 'external' },
          endpoint: authorization.binding.endpoint,
          credentialAuthorization: {
            connectionSecurityFingerprint:
              authorization.ticket.connectionSecurityFingerprint,
            grantFingerprint: authorization.ticket.grantFingerprint,
            selectedSecretBindingId:
              authorization.ticket.selectedSecretBindingId,
            selectedSecretRecordFingerprint:
              authorization.ticket.selectedSecretRecordFingerprint,
          },
        },
  );
}
