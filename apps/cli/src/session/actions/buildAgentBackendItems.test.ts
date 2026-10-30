import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from '@happier-dev/agents';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { buildAgentBackendItems } from './buildAgentBackendItems';

describe('buildAgentBackendItems', () => {
  it('omits disabled backends by default and reports them disabled when included', () => {
    const disabledKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    const settings = { backendEnabledByTargetKey: { [disabledKey]: false } };

    const defaultItems = buildAgentBackendItems({ settings });
    expect(defaultItems.find((item) => item.agentId === 'codex')).toBeUndefined();
    expect(defaultItems.find((item) => item.agentId === 'claude')).toEqual(expect.objectContaining({ enabled: true }));

    const includingDisabled = buildAgentBackendItems({ settings, includeDisabled: true });
    expect(includingDisabled.find((item) => item.agentId === 'codex')).toEqual(expect.objectContaining({ enabled: false }));
    expect(includingDisabled.find((item) => item.agentId === 'claude')).toEqual(expect.objectContaining({ enabled: true }));
  });

  it('reports every catalog backend enabled when no disable settings exist', () => {
    expect(buildAgentBackendItems({ settings: {} })).toHaveLength(AGENT_IDS.length);
    expect(buildAgentBackendItems({ settings: undefined })).toHaveLength(AGENT_IDS.length);
  });
});
