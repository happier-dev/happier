import { describe, expect, it } from 'vitest';

import { resolveVoiceActionBlockMemoryRecallGuidanceEnabled } from './resolveVoiceActionBlockMemoryRecallGuidanceEnabled';

describe('resolveVoiceActionBlockMemoryRecallGuidanceEnabled', () => {
  it('checks memory recall guidance support only on the voice_action_block surface', async () => {
    const calls: Array<readonly string[] | undefined> = [];

    const enabled = await resolveVoiceActionBlockMemoryRecallGuidanceEnabled({
      deps: {
        resolveCliMemoryRecallGuidanceEnabled: async (args) => {
          calls.push(args?.surfaces);
          return true;
        },
      },
    });

    expect(enabled).toBe(true);
    expect(calls).toEqual([['voice_action_block']]);
  });
});
