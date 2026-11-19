import { describe, expect, it } from 'vitest';
import { buildVoiceAgentBootstrapPrompt, buildVoiceAgentSeededUserTurnPrompt, buildVoiceAgentUserTurnPrompt } from './voiceAgentPrompts';

describe('voiceAgentPrompts', () => {
  it('asks a native MCP carrier to acknowledge accepted input and end its reply until there is a child outcome', () => {
    const prompt = buildVoiceAgentSeededUserTurnPrompt({ actionTransport: 'mcp', verbosity: 'short',
      initialContext: '', userText: 'Start a coding Session' });

    expect(prompt).toMatch(/If the coding Session reports a terminal failure, use that failure as the outcome\./);
    expect(prompt).not.toContain('say only that you are waiting for the coding assistant update');
  });

  it.each(['native', 'mcp'] as const)('captures %s prompt cost without multiplying context or conversation history', actionTransport => {
    const options = { actionTransport, verbosity: 'short' as const, initialContext: '' };
    const empty = buildVoiceAgentSeededUserTurnPrompt({ ...options, userText: 'list sessions' });
    const context = 'Current session: billing rewrite.';
    const history = [{ role: 'user' as const, text: 'Show my sessions.' },
      { role: 'assistant' as const, text: 'Four sessions are available.' }];
    const seeded = buildVoiceAgentSeededUserTurnPrompt({ ...options, initialContext: context,
      userText: 'list sessions', history });
    const twice = buildVoiceAgentSeededUserTurnPrompt({ ...options, initialContext: context.repeat(2),
      userText: 'list sessions', history: [...history, ...history] });
    const bootstrap = buildVoiceAgentBootstrapPrompt({ ...options, mode: 'ready_handshake' });
    const turn = buildVoiceAgentUserTurnPrompt({ userText: 'list sessions' });
    const bytes = (value: string) => Buffer.byteLength(value);
    // 49,604 B is the captured 11-14 empty seeded native prompt,
    // before removing duplicated workflow guidance. A regression basis,
    // never a product limit or truncation of a person's context/history.
    expect(bytes(empty)).toBeLessThan(49_604);
    expect(bytes(twice) - bytes(seeded)).toBe(bytes(context)
      + history.reduce((total, item) => total + bytes(`${item.role === 'user' ? 'User' : 'Voice agent'}: ${item.text}\n`), 0));
    expect(turn).toBe('User: list sessions\nVoice agent:');
    expect(seeded).toContain(context);
    for (const item of history) expect(seeded).toContain(item.text);
    console.info(JSON.stringify({ voicePromptCost: { actionTransport,
      bootstrapBytes: bytes(bootstrap), seededBytes: bytes(seeded),
      emptySeededBytes: bytes(empty), retainedTurnBytes: bytes(turn), contextBytes: bytes(context),
      historyTurns: history.length } }));
  });
  it.each(['  Exact greeting.\n\n', '   ', ''])('retains explicitly selected welcome bytes %j', (welcomeText) => {
    const prompt = buildVoiceAgentBootstrapPrompt({
      verbosity: 'short', initialContext: '', mode: 'welcome', welcomeText,
    });
    expect(prompt).toContain(`Start this session by greeting the user with exactly this message:\n${welcomeText}\n\nThen, wait`);
    expect(prompt).not.toContain('Start this session with a short friendly greeting');
  });
  it('uses the admitted welcome policy literal without a conflicting default greeting', () => {
    const prompt = buildVoiceAgentBootstrapPrompt({ verbosity: 'short', initialContext: '', mode: 'welcome',
      voicePolicy: { assistantLanguage: null, welcome: { enabled: true, mode: 'immediate', text: '  ADMITTED_DOC\n' } },
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
