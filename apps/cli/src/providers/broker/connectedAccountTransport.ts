import type { ProviderEndpointTemplateV1, QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol';
import type { QualifiedConnectedAccountRequestAuthUseV1 } from '@happier-dev/protocol/connect/connectedAccountRequestAuth';
import { normalizeProviderEndpointUrlSyntax } from '@happier-dev/protocol/providers/safety/url';

import { scopeConnectedAccountPurposeBindingLease, type ConnectedAccountPurposeBindingLease } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { projectRequestAuthQueryParameters } from '@/daemon/connectedServices/requestAuth/parseHttpHeadersRequestAuthMaterial';
import { resolveProviderAddresses } from '@/providers/registry/dnsEvidence';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';

import { createProviderConnectionHttpTransport, type ProviderConnectionHttpTransport } from './providerConnectionHttpTransport';

/** Adapts one admitted Account-purpose binding to the shared pinned HTTP transport. */
export async function openConnectedAccountProviderTransport(input: Readonly<{
  endpoint: Pick<ProviderEndpointTemplateV1, 'id' | 'protocol' | 'baseUrl' | 'publicHeaders'>;
  purpose: QualifiedConnectedAccountPurposeV1;
  materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'];
  bindingLease: ConnectedAccountPurposeBindingLease;
  requestAuth: Pick<ConnectedAccountRequestAuthService, 'lookupRequestAuth' | 'refreshAfterAuthFailure'>;
  signal: AbortSignal;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  resolveAddresses?: typeof resolveProviderAddresses;
  transport?: ProviderConnectionHttpTransport;
}>) {
  const { endpoint, materialization, bindingLease, purpose } = input;
  if (!endpoint.baseUrl) return null;
  const { normalizedUrl } = normalizeProviderEndpointUrlSyntax(endpoint.baseUrl);
  const upstream = new URL(normalizedUrl);
  if (upstream.origin !== materialization.origin) return null;
  const addresses = await (input.resolveAddresses ?? resolveProviderAddresses)(upstream.hostname);
  input.signal.throwIfAborted();
  if (!addresses.length) return null;
  const http = input.transport ?? createProviderConnectionHttpTransport();
  const consumerBase = new URL(endpoint.protocol === 'anthropic' ? '/' : '/v1', upstream);
  return http.open({
    applicationEndpointTemplateId: endpoint.id,
    applicationBaseUrl: consumerBase.href,
    endpoint: { normalizedUrl, publicHeaders: endpoint.publicHeaders ?? {}, resolvedAddresses: addresses },
    signal: input.signal,
    isCurrent: input.isCurrent,
    acquireRequestCredential: async signal => {
      const redaction = createProviderRedactionLease({ values: [] });
      try {
        const subject = scopeConnectedAccountPurposeBindingLease({
          lease: bindingLease, subjectId: bindingLease.subjectId,
          uses: [{ purpose, materialization }], registerRedaction: redaction.add,
        });
        const material = await input.requestAuth.lookupRequestAuth({ subject, purpose, signal });
        const [primary, ...additionalCredentials] = Object.entries(material.headers).map(([name, value]) =>
          ({ kind: 'httpHeader' as const, name, value }));
        if (!primary) {
          redaction.close();
          return null;
        }
        return {
          credential: { ...primary, additionalCredentials },
          redact: redaction.redact,
          containsSensitiveValue: redaction.containsSensitiveValue,
          createStreamingSanitizer: redaction.createStreamingSanitizer,
          close: redaction.close,
          queryParameters: projectRequestAuthQueryParameters(materialization, material.facts),
          onResponse: async (status: number, requestSignal: AbortSignal) => {
            if (status !== 401) return;
            // Recover through the current lease's owner for the next explicit turn.
            await input.requestAuth.refreshAfterAuthFailure({
              subject,
              signal: requestSignal,
              request: {
                credentialContext: material.credentialContext,
                normalizedFailure: {
                  class: 'authentication',
                  evidence: { httpStatus: 401, limitCategory: 'auth_invalid', quotaScope: 'unknown',
                    evidenceSource: { kind: 'structured' } },
                },
              },
            });
          },
        };
      } catch (error) {
        redaction.close();
        throw error;
      }
    },
  });
}
