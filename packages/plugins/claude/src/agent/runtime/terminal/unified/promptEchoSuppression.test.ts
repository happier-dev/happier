import { describe, expect, it } from 'vitest';

import { createClaudeUnifiedPromptEchoSuppressor } from './promptEchoSuppression.js';

describe('createClaudeUnifiedPromptEchoSuppressor', () => {
  it('suppresses accepted UI prompt echoes once within the accepted window', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      acceptedPromptEchoWindowMs: 5_000,
      nowMs: () => 1_000,
    });

    suppressor.recordAcceptedPrompt({ text: 'hello from UI', acceptedAtMs: 1_000 });

    expect(suppressor.consumeAcceptedPromptEcho({ text: 'hello from UI', observedAtMs: 2_000 })).toBe(true);
    expect(suppressor.consumeAcceptedPromptEcho({ text: 'hello from UI', observedAtMs: 2_100 })).toBe(false);
  });

  it('does not suppress matching terminal-origin prompts after the accepted window expires', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      acceptedPromptEchoWindowMs: 5_000,
      nowMs: () => 10_000,
    });

    suppressor.recordAcceptedPrompt({ text: 'repeat text', acceptedAtMs: 1_000 });

    expect(suppressor.consumeAcceptedPromptEcho({ text: 'repeat text', observedAtMs: 6_001 })).toBe(false);
  });

  it('keeps a durable Pending echo suppressible through a long provider-owned compaction', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      acceptedPromptEchoWindowMs: 5_000,
      nowMs: () => 150_000,
    });

    suppressor.recordAcceptedPrompt({
      text: 'continue after compaction',
      acceptedAtMs: 1_000,
      retainUntilObserved: true,
    });

    expect(suppressor.consumeAcceptedPromptEcho({
      text: 'continue after compaction',
      observedAtMs: 150_000,
      agentTurnId: 'provider-jsonl-row-after-compaction',
    })).toBe(true);
    expect(suppressor.consumeAcceptedPromptEcho({
      text: 'continue after compaction',
      observedAtMs: 150_001,
      agentTurnId: 'provider-jsonl-row-after-compaction',
    })).toBe(false);
  });

  it('suppresses a later durable Pending echo without consuming its durable control predecessor', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      acceptedPromptEchoWindowMs: 5_000,
      nowMs: () => 1_000,
    });

    suppressor.recordAcceptedPrompt({
      text: '/effort high',
      acceptedAtMs: 1_000,
      retainUntilObserved: true,
    });
    suppressor.recordAcceptedPrompt({ text: 'expired finite neighbor', acceptedAtMs: 1_000 });
    suppressor.recordAcceptedPrompt({
      text: 'ordinary Pending prompt',
      acceptedAtMs: 1_001,
      retainUntilObserved: true,
    });

    expect(suppressor.consumeAcceptedPromptEcho({
      text: 'ordinary Pending prompt',
      observedAtMs: 10_000,
    })).toBe(true);
    expect(suppressor.consumeAcceptedPromptEcho({
      text: 'ordinary Pending prompt',
      observedAtMs: 10_001,
    })).toBe(false);
    expect(suppressor.consumeAcceptedPromptEcho({
      text: 'expired finite neighbor',
      observedAtMs: 10_002,
    })).toBe(false);
    expect(suppressor.consumeAcceptedPromptEcho({
      text: '/effort high',
      observedAtMs: 10_003,
    })).toBe(true);
    expect(suppressor.consumeAcceptedPromptEcho({
      text: '/effort high',
      observedAtMs: 10_004,
    })).toBe(false);
  });

  it('suppresses duplicate transcript evidence for a just-materialized terminal-origin hook prompt only by provider row identity', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      terminalPromptDuplicateWindowMs: 5_000,
      nowMs: () => 2_000,
    });

    suppressor.recordMaterializedTerminalPrompt({
      text: 'typed directly',
      materializedAtMs: 2_000,
      agentTurnId: 'terminal-row-1',
    });

    expect(suppressor.consumeMaterializedTerminalPromptDuplicate({
      text: 'typed directly',
      observedAtMs: 2_100,
      agentTurnId: 'terminal-row-2',
    })).toBe(false);
    expect(suppressor.consumeMaterializedTerminalPromptDuplicate({
      text: 'typed directly',
      observedAtMs: 2_200,
      agentTurnId: 'terminal-row-1',
    })).toBe(true);
  });

  it('uses the same prompt identity normalization for accepted multiline attachment scaffolds', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      acceptedPromptEchoWindowMs: 5_000,
      nowMs: () => 1_000,
    });

    suppressor.recordAcceptedPrompt({
      text: [
        'please review the screenshots',
        'and continue',
        '',
        '[attachments]',
        '- screenshot.png (screenshot.png, image/png, 262290 bytes)',
        '[/attachments]',
      ].join('\r\n'),
      acceptedAtMs: 1_000,
    });

    expect(suppressor.consumeAcceptedPromptEcho({
      text: [
        'please review the screenshots   ',
        'and continue',
        '',
        '[attachments]',
        '- screenshot.png (screenshot.png, image/png, 262290 bytes)',
        '[/attachments]',
      ].join('\n'),
      observedAtMs: 2_000,
    })).toBe(true);
  });
});
