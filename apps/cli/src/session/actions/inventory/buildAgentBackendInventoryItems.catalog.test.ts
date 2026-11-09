import { AccountSettingsSchema, AgentsBackendsListOutputSchema } from '@happier-dev/protocol';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { describe, expect, it } from 'vitest';

import { buildAgentBackendInventoryItems } from './buildAgentBackendInventoryItems';
import { buildReviewEngineInventoryItems } from './buildReviewEngineInventoryItems';

const emptyCatalog = { status: 'ready' as const, revision: 1, record: { v: 1 as const, definitions: [] } };
const definitions = ['review-a', 'review-b'].map((id) => AcpBackendDefinitionV1Schema.parse({
  id, name: id, title: id, launch: { kind: 'command' as const, command: id, args: [] }, env: {}, createdAt: 1, updatedAt: 1,
}));
const configuredCatalog = { status: 'ready', revision: 2, record: { v: 1 as const, definitions } } as const;

describe('buildAgentBackendInventoryItems with the bundled catalog', () => {
  it('returns selectable catalog Agents that satisfy the strict Action output contract', async () => {
    const items = await buildAgentBackendInventoryItems({ includeDisabled: true,
      acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } } });

    expect(AgentsBackendsListOutputSchema.parse({ items })).toEqual({ items });

    expect(items).toContainEqual(expect.objectContaining({
      agentId: 'antigravity',
      identity: { pluginId: 'happier.agent.antigravity', localId: 'antigravity' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.antigravity', localId: 'antigravity' } },
    }));
    expect(items.some((item) => item.identity?.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId)).toBe(false);
  });

  it('expands the contributed Custom ACP container into exactly its configured definition targets', async () => {
    const items = await buildAgentBackendInventoryItems({ includeDisabled: true, acpCatalogSnapshot: configuredCatalog });
    expect(AgentsBackendsListOutputSchema.parse({ items })).toEqual({ items });
    expect(items.filter((item) => item.identity?.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId)).toEqual(
      definitions.map((definition) => ({
        targetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: definition.id }),
        label: definition.title, enabled: true, agentId: 'custom-acp', backendId: definition.id,
        identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
        agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: definition.id },
      })),
    );
  });

  it('uses the same concrete choices for review and preserves per-definition enablement', async () => {
    const targetKey = buildBackendTargetKeyV2({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'review-a' });
    const accountSettings = AccountSettingsSchema.parse({ backendEnabledByTargetKey: { [targetKey]: false } });
    const inventory = await buildAgentBackendInventoryItems({ accountSettings, acpCatalogSnapshot: configuredCatalog });
    const reviews = await buildReviewEngineInventoryItems({ accountSettings, acpCatalogSnapshot: configuredCatalog });
    expect(inventory.filter((item) => item.agentId === 'custom-acp').map((item) => item.backendId)).toEqual(['review-b']);
    expect(reviews.filter((item) => item.backendId === 'review-a' || item.backendId === 'review-b').map((item) => item.backendId)).toEqual(['review-b']);
    expect(reviews.some((item) => item.engineId === 'custom-acp')).toBe(false);
    expect((await buildReviewEngineInventoryItems({ acpCatalogSnapshot: emptyCatalog })).some((item) => item.backendId === 'custom-acp')).toBe(false);
    const unavailableItems = await buildAgentBackendInventoryItems({ acpCatalogSnapshot: { status: 'unavailable', reason: 'source-transfer-required' } });
    expect(unavailableItems).toContainEqual(expect.objectContaining({ agentId: 'claude' }));
    expect(unavailableItems.some((item) => item.agentId === 'custom-acp')).toBe(false);
  });
});
