import type { TeamCredentialProviderModelCatalogEntryV1, TeamCredentialRouteV1 } from '@happier-dev/protocol/teams';
import { resolveProviderBindingCompatibilityFromSourceFactsV1, ProviderModelBindingSourceV1Schema, type ProviderModelBindingSourceV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { readLeasedAgentProviderBindingAdapter } from '@/plugins/runtime/providerBindings/adapter';
import { teamCredentialBrokerLocalCredentialTransport } from './providerBrokerPrivateProtocol';

export type TeamCredentialModelCompatibilityInput = Pick<TeamCredentialProviderModelCatalogEntryV1,
  'descriptor' | 'application' | 'sourceFacts'> & Readonly<{ deliveryMode: TeamCredentialRouteV1 }>;

/** The source supplies declarations; experimental Team pairings are informational.
 * Only this worker's admitted adapter establishes compatibility. */
export async function resolveTeamCredentialModelCompatibility(input: Readonly<{
  model: TeamCredentialModelCompatibilityInput;
  lease: PluginRuntimeRegistryLease;
  agentId: string;
  signal?: AbortSignal;
}>) {
  const adapter = readLeasedAgentProviderBindingAdapter(input);
  const facts = ProviderModelBindingSourceV1Schema.safeParse(input.model.sourceFacts);
  if (!adapter || !facts.success || facts.data.endpoint.id !== input.model.application.endpointTemplateId
    || facts.data.endpoint.protocol !== input.model.application.protocol) {
    throw Object.assign(new Error('provider_incompatible_with_agent'), createProviderErrorV1('provider_incompatible_with_agent'));
  }
  const brokerCredential = { kind: 'apiKey' as const, required: true, slotId: 'apiKey',
    transports: [teamCredentialBrokerLocalCredentialTransport(input.model.application.protocol)] } satisfies NonNullable<ProviderModelBindingSourceV1['credential']>;
  const compatibility = resolveProviderBindingCompatibilityFromSourceFactsV1({
    agentTargetKey: input.model.application.agentTargetKey, agent: adapter.support,
    adapterVersion: adapter.adapter.adapterVersion, endpoints: [facts.data.endpoint],
    credential: input.model.deliveryMode === 'brokered' ? brokerCredential : facts.data.credential,
    compatibilityOverrides: facts.data.compatibilityOverrides, model: input.model.descriptor,
  });
  return { ...compatibility, confirmed: compatibility.result.status !== 'incompatible' };
}

export async function assertTeamCredentialModelAdmission(input: Parameters<typeof resolveTeamCredentialModelCompatibility>[0]): Promise<void> {
  input.signal?.throwIfAborted();
  const compatibility = await resolveTeamCredentialModelCompatibility(input);
  input.signal?.throwIfAborted();
  const code = compatibility.result.status === 'incompatible' ? 'provider_incompatible_with_agent' : null;
  if (code) throw Object.assign(new Error(code), createProviderErrorV1(code));
}
