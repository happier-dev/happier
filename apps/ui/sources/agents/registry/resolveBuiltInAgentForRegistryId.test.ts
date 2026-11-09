import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { adaptDaemonContributionRegistryProjectionToMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveBuiltInAgentForRegistryId } from './resolveBuiltInAgentForRegistryId';

function catalogEntries(isBuiltIn: boolean) {
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
        claude: { id: 'claude', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            isBuiltIn, acpRegistryIds: ['claude-acp', 'alternate-claude'] },
    } });
    const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
    return [resolveAgentCatalogProjection('claude', { enabledAgentIds: [],
        mergedProviderProjectionById: adapted.mergedProviderProjectionById })];
}

describe('resolveBuiltInAgentForRegistryId', () => {
    it('returns the built-in catalog entry declaring the exact registry identity', () => {
        const entries = catalogEntries(true);
        expect(resolveBuiltInAgentForRegistryId(entries, 'claude-acp')).toBe(entries[0]);
        expect(resolveBuiltInAgentForRegistryId(entries, 'alternate-claude')).toBe(entries[0]);
        expect(resolveBuiltInAgentForRegistryId(entries, 'claude')).toBeNull();
        expect(resolveBuiltInAgentForRegistryId(entries, 'unknown-agent')).toBeNull();
        expect(resolveBuiltInAgentForRegistryId([], 'claude-acp')).toBeNull();
    });

    it('does not label installed plugins or configured entries as built into Happier', () => {
        expect(resolveBuiltInAgentForRegistryId(catalogEntries(false), 'claude-acp')).toBeNull();
    });
});
