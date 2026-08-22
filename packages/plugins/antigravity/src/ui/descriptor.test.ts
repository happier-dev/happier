import { describe, expect, it } from 'vitest';

import { ANTIGRAVITY_UI_DESCRIPTOR } from './descriptor.js';

describe('Antigravity UI descriptor', () => {
  it('keeps Antigravity UI projection as no-execute descriptor data', () => {
    expect(JSON.parse(JSON.stringify(ANTIGRAVITY_UI_DESCRIPTOR))).toEqual(ANTIGRAVITY_UI_DESCRIPTOR);
    expect(ANTIGRAVITY_UI_DESCRIPTOR).toMatchObject({
      kind: 'plugin.ui.v1',
      pluginId: 'antigravity',
      agentId: 'antigravity',
      display: {
        nameKey: 'agentInput.agent.antigravity',
        connectedService: { serviceId: 'gemini' },
        localControl: true,
      },
      behavior: {},
    });
    expect(ANTIGRAVITY_UI_DESCRIPTOR).not.toHaveProperty('settings');
  });
});
