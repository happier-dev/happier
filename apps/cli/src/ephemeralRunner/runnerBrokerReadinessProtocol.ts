import { resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type { AgentProviderRequirementsV1, ProviderApiKeyCredentialRequirementV1, ProviderBrokerApplicationBindingV1, ProviderEndpointTemplateV1 } from '@happier-dev/protocol';

export function resolveReviewedRunnerBrokerApplicationCompatibility(input: Readonly<{
  agentTargetKey: string;
  agent: AgentProviderRequirementsV1;
  endpoints: readonly ProviderEndpointTemplateV1[];
  application: ProviderBrokerApplicationBindingV1;
  credential?: ProviderApiKeyCredentialRequirementV1;
}>): Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'unavailable'; reason: 'reviewed_application_changed' | 'reviewed_application_incompatible' }> {
  if (input.application.agentTargetKey !== input.agentTargetKey) {
    return { status: 'unavailable', reason: 'reviewed_application_changed' };
  }
  const endpoint = input.endpoints.find((candidate) => (
    candidate.id === input.application.endpointTemplateId
    && candidate.protocol === input.application.protocol
  ));
  if (!endpoint) return { status: 'unavailable', reason: 'reviewed_application_changed' };
  const assessed = resolveProviderBindingCompatibilityWithFingerprintV1({
    adapterVersion: 1,
    agentTargetKey: input.agentTargetKey,
    endpoints: [endpoint],
    credential: input.credential,
    agent: input.agent,
  }).result;
  return assessed.status === 'incompatible'
    ? { status: 'unavailable', reason: 'reviewed_application_incompatible' }
    : { status: 'ready' };
}
