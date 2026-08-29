import { describe, expect, it } from 'vitest';

import { AgentIdV1Schema, MAX_AGENT_ROUTING_ID_BYTES } from './agentIdV1.js';

describe('AgentIdV1Schema', () => {
  it('admits the full qualified external routing identity bound', () => {
    const pluginId = 'p'.repeat(256);
    const localId = 'a'.repeat(256);

    expect(MAX_AGENT_ROUTING_ID_BYTES).toBe(513);
    expect(AgentIdV1Schema.parse(`${pluginId}/${localId}`)).toHaveLength(513);
    expect(AgentIdV1Schema.safeParse(`${pluginId}/${localId}x`).success).toBe(false);
  });
});
