import { describe, expect, it } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { resolveDefaultProviderUsageProfileRef } from './resolveDefaultProviderUsageProfileRef';

const connectedServices = AccountProfileSchema.parse({
    id: 'account',
    connectedServicesV2: [
        { serviceId: 'claude-subscription', profiles: [{ profileId: 'claude-2', status: 'connected' }] },
        { serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected' }] },
    ],
}).connectedServicesV2;

describe('resolveDefaultProviderUsageProfileRef', () => {
    it('selects the provider\'s own connected login', () => {
        expect(resolveDefaultProviderUsageProfileRef({ agentId: 'claude', connectedServices }))
            .toEqual({ serviceId: 'claude-subscription', profileId: 'claude-2' });
        expect(resolveDefaultProviderUsageProfileRef({ agentId: 'codex', connectedServices }))
            .toEqual({ serviceId: 'openai-codex', profileId: 'work' });
    });

    it.each(['opencode', 'pi'] as const)('never borrows another provider\'s login for %s', (agentId: AgentId) => {
        expect(resolveDefaultProviderUsageProfileRef({ agentId, connectedServices })).toBeNull();
    });
});
