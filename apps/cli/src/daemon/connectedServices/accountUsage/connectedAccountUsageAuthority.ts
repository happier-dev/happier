import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-key';
import { createProviderErrorV1, type ProviderErrorCodeV1 } from '@happier-dev/protocol/providers/errors';
import type { DaemonProviderUsageRefreshResponseV1, ProviderConnectedAccountUsageSourceV1 } from '@happier-dev/protocol/rpc/providers';

import type { ProviderProbeOperationScope } from '@/providers/probe/authorization';
import { ProviderProbeCredentialResolutionError, ProviderProbeDestinationAuthorizationError } from '@/providers/probe/authorization';
import { ProviderProbeCancelledError, type createProviderProbeHttpClient } from '@/providers/probe/client';
import { awaitAbortableWithinProviderOperation, ProviderOperationAbandonedError } from '@/providers/operationLifetime';
import { readConnectedAccountCatalogSources } from '@/providers/modelManagement/connectedAccountCatalog';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import {
  scopeConnectedAccountPurposeBindingLease,
  type ConnectedAccountPurposeBindingOwner,
} from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ConnectedAccountRequestAuthService } from '../requestAuth/ConnectedAccountRequestAuthService';
import { projectRequestAuthQueryParameters } from '../requestAuth/parseHttpHeadersRequestAuthMaterial';
import { refreshProviderConnectionUsage, type ProviderUsageParserBinding } from './providerConnectionUsage';
import { randomUUID } from 'node:crypto';

export type ConnectedAccountUsageAuthority = Readonly<{
  resolveSelection: ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'];
  activatePurposeBindings: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
  lookupRequestAuth: ConnectedAccountRequestAuthService['lookupRequestAuth'];
}>;

/** Open one declared personal billing source for the lifetime of its usage read. */
export async function readConnectedAccountProviderUsage(input: Readonly<{
  selected: ProviderConnectedAccountUsageSourceV1;
  machineId: string;
  isCurrent(): boolean;
  authority?: ConnectedAccountUsageAuthority;
  resolveRegistry(): ProviderContributionRegistryView | Promise<ProviderContributionRegistryView>;
  resolveParsers(identity: ProviderConnectedAccountUsageSourceV1['purpose']['consumer']): Promise<ProviderUsageParserBinding | null>;
  client: Pick<ReturnType<typeof createProviderProbeHttpClient>, 'getUsage'>;
  operationScope: ProviderProbeOperationScope;
  staleAfterMs: number;
}>): Promise<DaemonProviderUsageRefreshResponseV1> {
  const { account, purpose, endpointTemplateId, usageSourceId } = input.selected;
  const target = { kind: 'account' as const, account };
  const identity = { machineId: input.machineId, connectedAccountTarget: target };
  const unavailable = (code: ProviderErrorCodeV1, cause?: unknown) => ({
    status: 'error' as const, error: createProviderErrorV1(code, identity, cause),
  });
  const authority = input.authority;
  if (!authority) return unavailable('provider_credential_transport_unavailable');
  try {
    return await awaitAbortableWithinProviderOperation(async signal => {
      const registry = await input.resolveRegistry();
      const contributionKey = buildQualifiedPluginContributionKey(purpose.consumer);
      const provider = registry.providersByContributionKey.get(contributionKey);
      const source = provider?.definition.usageSources?.find(candidate => candidate.id === usageSourceId
        && candidate.endpointTemplateId === endpointTemplateId && candidate.connectedAccount?.purpose === purpose.purpose);
      if (!provider || !source?.connectedAccount) return unavailable('provider_contribution_unavailable');
      const { headerNames } = source.connectedAccount;
      const [resolved] = await readConnectedAccountCatalogSources({ registry, target, provider,
        purpose: purpose.purpose, endpointTemplateId, resolveSelection: authority.resolveSelection, signal });
      if (!resolved) return unavailable('provider_authorization_changed');
      const use = resolved.requestAuthUses.find(candidate => candidate.purpose === purpose.purpose);
      const endpointUrl = resolved.endpoint.baseUrl;
      if (!use || !endpointUrl) return unavailable('provider_credential_transport_unavailable');
      const parsers = await input.resolveParsers(provider.identity);
      if (!parsers?.parsersByFormat[source.parser]) return unavailable('provider_contribution_unavailable');
      signal.throwIfAborted();
      if (!input.isCurrent()) return unavailable('provider_authorization_changed');
      const lease = authority.activatePurposeBindings({
        subject: { kind: 'operation', operationId: randomUUID(), consumer: provider.identity,
          isCurrent: () => !signal.aborted && input.isCurrent() },
        purposes: [purpose], bindings: [resolved.selection.binding],
      });
      const redaction = createProviderRedactionLease({ values: [] });
      try {
        const { materialization } = use;
        const subject = scopeConnectedAccountPurposeBindingLease({ lease, subjectId: lease.subjectId,
          uses: [{ purpose, materialization }], registerRedaction: redaction.add });
        let credentialRevision: string | undefined;
        return await refreshProviderConnectionUsage({ client: input.client, parsers, staleAfterMs: input.staleAfterMs,
          operationScope: { ...input.operationScope, lifetime: { ...input.operationScope.lifetime, signal } },
          accountSource: { source, identity, providerId: provider.definition.id, authority: {
            request: {
              endpointUrl, path: source.path, publicHeaders: resolved.endpoint.publicHeaders ?? {},
              credentialPolicy: 'required', followRedirects: false,
              authorizeDestination: async destination => {
                if (!subject.isCurrent() || destination.origin !== materialization.origin || destination.locality !== 'public') {
                  throw new ProviderProbeDestinationAuthorizationError(unavailable('provider_authorization_changed').error);
                }
              },
              resolveCredential: async () => {
                try {
                  const material = await authority.lookupRequestAuth({ subject, purpose, signal });
                  credentialRevision = material.credentialContext.credentialRevision;
                  const headers = headerNames.map(name => {
                    const value = material.headers[name];
                    if (!value) throw new ProviderProbeCredentialResolutionError(unavailable('provider_credential_transport_unavailable').error);
                    return { kind: 'httpHeader' as const, name, value };
                  });
                  const [primary, ...additionalHeaders] = headers;
                  if (!primary) throw new ProviderProbeCredentialResolutionError(unavailable('provider_credential_transport_unavailable').error);
                  const query = Object.entries(projectRequestAuthQueryParameters(materialization, material.facts) ?? {})
                    .map(([name, value]) => ({ kind: 'queryParameter' as const, name, value }));
                  return { credential: { ...primary, additionalCredentials: [...additionalHeaders, ...query] },
                    containsSensitiveValue: redaction.containsSensitiveValue, close: redaction.close };
                } catch (error) {
                  if (signal.aborted) throw new ProviderProbeCancelledError();
                  if (error instanceof ProviderProbeCredentialResolutionError) throw error;
                  throw new ProviderProbeCredentialResolutionError(unavailable('provider_credential_transport_unavailable', error).error);
                }
              },
            },
            readSubjectKey: () => ({ contributionKey, usageSourceId, ...identity, purpose, credentialRevision }),
          } },
        });
      } finally {
        lease.dispose();
        redaction.close();
      }
    }, input.operationScope.lifetime);
  } catch (error) {
    if (error instanceof ProviderProbeCancelledError
      || (error instanceof ProviderOperationAbandonedError && error.reason === 'cancelled')) throw new ProviderProbeCancelledError();
    return unavailable(error instanceof ProviderOperationAbandonedError ? 'provider_endpoint_unavailable' : 'provider_authorization_changed', error);
  }
}
