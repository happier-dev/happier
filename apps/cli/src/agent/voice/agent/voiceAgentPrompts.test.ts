import { describe, expect, it } from 'vitest';

describe('voiceAgentPrompts', () => {
  it('filters disabled actions out of the embedded local voice system prompt', async () => {
    const prev = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['voice_tool'], disabledPlacements: [] },
      },
    });
    try {
      const { buildVoiceAgentBootstrapPrompt } = await import('./voiceAgentPrompts');
      const prompt = buildVoiceAgentBootstrapPrompt({
        verbosity: 'short',
        initialContext: '',
        mode: 'ready_handshake',
      });
      expect(prompt).not.toContain('startReview');
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = prev;
    }
  });
});
