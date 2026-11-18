import { describe, expect, it } from 'vitest';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';

import { resolveBulkTargetCatalogAgentId } from './useBulkSessionTargetIdentities';

describe('resolveBulkTargetCatalogAgentId', () => {
  it('names bundled Agents by their catalog id and contributed Agents by their qualified id, never dropping them', () => {
    const bundled = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } });
    const contributed = AgentExecutionTargetV1Schema.parse({ kind: 'agent', identity: { pluginId: 'acme.agents', localId: 'reviewer' } });
    expect(resolveBulkTargetCatalogAgentId(bundled)).toBe('codex');
    expect(resolveBulkTargetCatalogAgentId(contributed)).toBe('acme.agents/reviewer');
    expect(resolveBulkTargetCatalogAgentId(null)).toBeNull();
  });
});
