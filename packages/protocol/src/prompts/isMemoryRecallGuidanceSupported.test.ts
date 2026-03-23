import { describe, expect, it } from 'vitest';

import { isMemoryRecallGuidanceSupported } from './isMemoryRecallGuidanceSupported.js';

describe('isMemoryRecallGuidanceSupported', () => {
  it('requires both memory actions on the same surface', () => {
    const enabled = isMemoryRecallGuidanceSupported({
      surfaces: ['voice_tool', 'voice_action_block'],
      isActionEnabled: (actionId, surface) => {
        if (surface === 'voice_tool') return actionId === 'memory.search';
        if (surface === 'voice_action_block') return actionId === 'memory.get_window';
        return false;
      },
    });

    expect(enabled).toBe(false);
  });

  it('returns true when one requested surface exposes both memory actions', () => {
    const enabled = isMemoryRecallGuidanceSupported({
      surfaces: ['voice_tool', 'voice_action_block'],
      isActionEnabled: (actionId, surface) => {
        if (surface !== 'voice_action_block') return false;
        return actionId === 'memory.search' || actionId === 'memory.get_window';
      },
    });

    expect(enabled).toBe(true);
  });
});
