import { describe, expect, it, vi } from 'vitest';

import {
  GROK_PROMPT_COMPLETE_METHOD,
  GROK_PROMPT_COMPLETE_METHODS,
  handleGrokPromptComplete,
  translateGrokPromptCompletion,
} from './completion.js';

describe('Grok prompt completion', () => {
  it('publishes exact canonical completion evidence for both supported spellings', () => {
    const submitCompletionEvidence = vi.fn(() => true);
    expect(GROK_PROMPT_COMPLETE_METHOD).toBe('x.ai/session/prompt_complete');
    expect(GROK_PROMPT_COMPLETE_METHODS).toEqual([
      'x.ai/session/prompt_complete', '_x.ai/session/prompt_complete',
    ]);
    expect(handleGrokPromptComplete({ sessionId: 'provider-1', promptId: 'turn-1' }, {
      method: GROK_PROMPT_COMPLETE_METHOD,
      providerSessionId: 'provider-1',
      currentTurn: { turnId: 'turn-1', submitCompletionEvidence },
    })).toBe(true);
    expect(submitCompletionEvidence).toHaveBeenCalledWith({
      providerSessionId: 'provider-1', promptId: 'turn-1', outcome: { kind: 'completed' },
    });
    expect(handleGrokPromptComplete({ sessionId: 'provider-2', promptId: 'turn-1' }, {
      method: GROK_PROMPT_COMPLETE_METHOD,
      providerSessionId: 'provider-1',
      currentTurn: { turnId: 'turn-1', submitCompletionEvidence },
    })).toBe(false);
  });

  it('translates failure and cancellation without fabricating successful completion', () => {
    expect(translateGrokPromptCompletion({
      sessionId: 'provider-1', promptId: 'turn-1', stopReason: 'rate_limit', agentResult: { retry: true },
    })).toEqual({
      sessionId: 'provider-1', promptId: 'turn-1',
      outcome: { kind: 'failed', message: 'Grok prompt was rate limited: {"retry":true}' },
    });
    const submitCompletionEvidence = vi.fn(() => true);
    expect(handleGrokPromptComplete({
      sessionId: 'provider-1', promptId: 'turn-1', stopReason: 'error',
    }, {
      method: GROK_PROMPT_COMPLETE_METHOD,
      providerSessionId: 'provider-1',
      currentTurn: { turnId: 'turn-1', submitCompletionEvidence },
    })).toBe(true);
    expect(submitCompletionEvidence).toHaveBeenCalledWith({
      providerSessionId: 'provider-1', promptId: 'turn-1',
      outcome: { kind: 'failed', message: 'Grok prompt failed' },
    });
    expect(handleGrokPromptComplete({
      sessionId: 'provider-1', promptId: 'turn-1', stopReason: 'future_reason',
    }, {
      method: GROK_PROMPT_COMPLETE_METHOD,
      providerSessionId: 'provider-1',
      currentTurn: { turnId: 'turn-1', submitCompletionEvidence },
    })).toBe(false);
    expect(handleGrokPromptComplete({ sessionId: '', promptId: 'turn-1' }, {
      method: GROK_PROMPT_COMPLETE_METHOD,
      providerSessionId: 'provider-1',
      currentTurn: { turnId: 'turn-1', submitCompletionEvidence },
    })).toBe(false);
    expect(submitCompletionEvidence).toHaveBeenCalledTimes(1);
  });
});
