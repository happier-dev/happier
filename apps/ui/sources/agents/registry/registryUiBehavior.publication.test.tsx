import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { AGENT_IDS as SHARED_AGENT_IDS } from '@happier-dev/agents';

import { AGENT_IDS, getAgentBehavior, getAgentCore } from '@/agents/catalog/catalog';
import { renderScreen } from '@/dev/testkit';
import { makeSettings } from './registryUiBehavior.testHelpers';

// Consume the real catalog and behavior initialization used by NewSessionScreen.
// Shared identity survives an optional plugin publication failure; presentation
// membership must follow the published UI cores rather than that identity list.
function CatalogPermissionsConsumer() {
    const settings = makeSettings();
    const rows = SHARED_AGENT_IDS.map((agentId) => {
        const behavior = getAgentBehavior(agentId);
        return {
            agentId,
            listed: AGENT_IDS.includes(agentId),
            readOnlyAfterStop: behavior.permissions?.footer?.forceReadOnlyAfterStop,
            direct: behavior.newSession?.supportsTranscriptStorageMode?.({ agentId, settings, storageMode: 'direct' }) === true,
        };
    });
    return <>{JSON.stringify(rows)}</>;
}

describe('Agent catalog after optional plugin publication failure', () => {
    it('renders healthy Agent permissions and leaves unpublished Agents unavailable', async () => {
        const screen = await renderScreen(<CatalogPermissionsConsumer />);
        const rows: unknown = JSON.parse(String(screen.tree.toJSON()));

        expect(rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ agentId: 'claude', listed: true, readOnlyAfterStop: true }),
            expect.objectContaining({ agentId: 'codex', listed: true, readOnlyAfterStop: false }),
        ]));
        for (const agentId of SHARED_AGENT_IDS) {
            if (getAgentCore(agentId) !== null) continue;
            expect(rows).toEqual(expect.arrayContaining([
                { agentId, listed: false, readOnlyAfterStop: true, direct: false },
            ]));
        }
    });
});
