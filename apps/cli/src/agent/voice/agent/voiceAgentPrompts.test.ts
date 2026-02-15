import { describe, expect, it } from 'vitest';

describe('voiceAgentPrompts', () => {
  it('filters disabled actions out of the embedded local voice system prompt', async () => {
    const prev = process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
    process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS = JSON.stringify(['review.start']);
    try {
      const { buildVoiceAgentBootstrapPrompt } = await import('./voiceAgentPrompts');
      const prompt = buildVoiceAgentBootstrapPrompt({
        verbosity: 'short',
        initialContext: '',
        mode: 'ready_handshake',
      });
      expect(prompt).not.toContain('startReview');
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS;
      else process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS = prev;
    }
  });
});
