import { describe, expect, it } from 'vitest';

import {
  VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION,
  VERCEL_GATEWAY_PROVIDER_IDENTITY,
} from '../../../../../packages/plugins/vercel-ai-gateway/src/provider/contribution.js';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';
import { projectAgentProviderBrokerApplications } from '@happier-dev/protocol/providers/catalog/brokerApplicationProjectionV1';

describe('Team credential Provider application demand', () => {
  it('offers the compatible endpoint for the declared request-auth purpose', () => {
    const definition = ProviderContributionV1Schema.parse(VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION);
    const input = {
      agentTargetKey: 'agent:happier.agent.codex/codex',
      acceptedProtocols: ['openai-responses'] as const,
      providers: [{ identity: VERCEL_GATEWAY_PROVIDER_IDENTITY, definition }],
    };

    expect(projectAgentProviderBrokerApplications(input)).toEqual([{
      agentTargetKey: input.agentTargetKey,
      implementationIdentity: VERCEL_GATEWAY_PROVIDER_IDENTITY,
      endpointTemplateId: 'vercel-responses',
      protocol: 'openai-responses',
    }]);
    expect(projectAgentProviderBrokerApplications({
      ...input, providers: [{ identity: VERCEL_GATEWAY_PROVIDER_IDENTITY, definition: { ...definition, requestAuthUses: [] } }],
    })).toEqual([]);
  });
});
