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

  it('suppresses duplicate transcript evidence for a just-materialized terminal-origin hook prompt', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      terminalPromptDuplicateWindowMs: 5_000,
      nowMs: () => 2_000,
    });

    suppressor.recordMaterializedTerminalPrompt({ text: 'typed directly', materializedAtMs: 2_000 });

    expect(suppressor.consumeMaterializedTerminalPromptDuplicate({ text: 'typed directly', observedAtMs: 2_100 })).toBe(true);
    expect(suppressor.consumeMaterializedTerminalPromptDuplicate({ text: 'typed directly', observedAtMs: 2_200 })).toBe(false);
  });
});
