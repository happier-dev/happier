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
  }, 15_000);

  it('filters explicitly disabled discovery actions from seeded prompts', async () => {
    const { buildVoiceAgentSeededUserTurnPrompt } = await import('./voiceAgentPrompts');
    const prompt = buildVoiceAgentSeededUserTurnPrompt({
      verbosity: 'short',
      initialContext: 'CTX',
      userText: 'hello',
      disabledActionIds: ['review.start', 'machines.list'],
    });

    expect(prompt).not.toContain('startReview');
    expect(prompt).not.toContain('listMachines');
    expect(prompt).toContain('listAgentBackends');
  });

  it('forwards memory recall guidance into the embedded local voice system prompt', async () => {
    const { buildVoiceAgentBootstrapPrompt } = await import('./voiceAgentPrompts');
    const prompt = buildVoiceAgentBootstrapPrompt({
      verbosity: 'short',
      initialContext: '',
      mode: 'ready_handshake',
      memoryRecallGuidanceEnabled: true,
    });

    expect(prompt).toContain('If the user asks what you remember from earlier conversations or decisions');
    expect(prompt).toContain('use memorySearch first');
  });

  it('appends resolved voice prompt stack blocks to bootstrap and seeded prompts', async () => {
    const { buildVoiceAgentBootstrapPrompt, buildVoiceAgentSeededUserTurnPrompt } = await import('./voiceAgentPrompts');

    const bootstrapPrompt = buildVoiceAgentBootstrapPrompt({
      verbosity: 'short',
      initialContext: '',
      mode: 'ready_handshake',
      systemAppendBlocks: ['Voice stack block'],
    });
    const seededPrompt = buildVoiceAgentSeededUserTurnPrompt({
      verbosity: 'short',
      initialContext: 'CTX',
      userText: 'hello',
      systemAppendBlocks: ['Voice stack block'],
    });

    expect(bootstrapPrompt).toContain('Voice stack block');
    expect(seededPrompt).toContain('Voice stack block');
  });
});
