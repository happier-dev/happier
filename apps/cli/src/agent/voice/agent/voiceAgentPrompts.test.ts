import { describe, expect, it } from 'vitest';
import { buildVoiceAgentBootstrapPrompt, buildVoiceAgentSeededUserTurnPrompt } from './voiceAgentPrompts';

describe('voiceAgentPrompts', () => {
  it.each(['  Exact greeting.\n\n', '   ', ''])('retains explicitly selected welcome bytes %j', (welcomeText) => {
    const prompt = buildVoiceAgentBootstrapPrompt({
      verbosity: 'short', initialContext: '', mode: 'welcome', welcomeText,
    });
    expect(prompt).toContain(`Start this session by greeting the user with exactly this message:\n${welcomeText}\n\nThen, wait`);
    expect(prompt).not.toContain('Start this session with a short friendly greeting');
  });
  it('uses the admitted welcome policy literal without a conflicting default greeting', () => {
    const prompt = buildVoiceAgentBootstrapPrompt({ verbosity: 'short', initialContext: '', mode: 'welcome',
      voicePolicy: { welcome: { enabled: true, mode: 'immediate', text: '  ADMITTED_DOC\n' } },
    });
    expect(prompt).toContain('exactly this message:\n  ADMITTED_DOC\n\n\nThen, wait');
    expect(prompt).not.toContain('Start this session with a short friendly greeting');
  });

  it('filters disabled actions out of the embedded local voice system prompt', async () => {
    const prev = process.env.HAPPIER_ACTIONS_SETTINGS_V1;
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['voice'], disabledPlacements: [] },
      },
    });
    try {
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
