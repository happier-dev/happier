import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('Pi strict Agent capabilities', () => {
  it('declares real session and execution-run operations without legacy media wrappers', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents[0];
    expect(agent?.primary).toBe('sessions');
    expect(agent?.capabilities.sessions.delivery).toEqual(['newTurn', 'steer', 'followUp']);
    expect(agent?.capabilities.sessions.startupInstructions).toEqual({ versions: [1] });
    expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([]);
    expect(agent?.capabilities.executionRuns).toEqual({ open: ['create'], checkpoint: false, stop: true });
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      capability: 'filesystem',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }));
  });
});
