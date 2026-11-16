import { describe, expect, it } from 'vitest';

import type { RawJSONLines } from '../types';
import { createClaudeUnifiedPromptEchoSuppressor } from './promptEchoSuppression';

function userMessage(text: string, timestampMs: number): RawJSONLines {
  return {
    type: 'user',
    uuid: `user-${timestampMs}`,
    timestamp: new Date(timestampMs).toISOString(),
    message: { role: 'user', content: text },
  } as RawJSONLines;
}

describe('createClaudeUnifiedPromptEchoSuppressor', () => {
  it('suppresses a fresh accepted UI prompt echo once', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      nowMs: () => 1_000,
      acceptedPromptEchoWindowMs: 5_000,
    });

    suppressor.recordAcceptedPrompt({ message: 'hello from ui' });

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('hello from ui', 1_100))).toBe(true);
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('hello from ui', 1_200))).toBe(false);
  });

  it('suppresses an SDK text-block UI prompt echo without hiding a later native prompt', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({ nowMs: () => 1_000 });
    suppressor.recordAcceptedPrompt({ message: 'hello from ui' });

    const echo: RawJSONLines = {
      type: 'user',
      uuid: 'sdk-ui-prompt-echo',
      timestamp: new Date(1_100).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'hello from ui' }] },
    };

    expect(suppressor.shouldSuppressTranscriptMessage(echo)).toBe(true);
    expect(suppressor.shouldSuppressTranscriptMessage({ ...echo, uuid: 'later-native-prompt' })).toBe(false);
  });

  it('suppresses an accepted prompt echo that the provider wrapped in paste markers', () => {
    // Claude Code 2.1.259 records a bracketed-paste prompt wrapped in its own paste markers. If
    // the echo is not recognised it is forwarded as a second, visible transcript message showing
    // the raw markers to the user (live incident 2026-09-18, session cmtyf86rp1a1ttm237czmr4ts).
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      nowMs: () => 1_000,
      acceptedPromptEchoWindowMs: 5_000,
    });

    suppressor.recordAcceptedPrompt({ message: 'first line\n\nsecond line' });

    const wrappedEcho = '\n\n<pasted_content id="9b65">\nfirst line\n\nsecond line\n</pasted_content id="9b65">\n';
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage(wrappedEcho, 1_100))).toBe(true);
  });

  it('does not suppress matching terminal-origin prompts after an accepted UI prompt echo expires', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      nowMs: () => 10_000,
      acceptedPromptEchoWindowMs: 5_000,
    });

    suppressor.recordAcceptedPrompt({ message: 'same text' });

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('same text', 16_001))).toBe(false);
  });

  it('keeps a durable Pending echo suppressible through a long provider-owned resume compaction', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      nowMs: () => 10_000,
      acceptedPromptEchoWindowMs: 5_000,
    });

    suppressor.recordAcceptedPrompt({
      message: 'continue after the provider finishes compacting',
      retainUntilObserved: true,
    });

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage(
      'continue after the provider finishes compacting',
      150_000,
    ))).toBe(true);
  });

  it('suppresses the exact durable prompt echo behind an unmatched accepted control command', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({ nowMs: () => 10_000 });

    suppressor.recordAcceptedPrompt({ message: '/effort high', retainUntilObserved: true });
    suppressor.recordAcceptedPrompt({
      message: 'continue after the provider finishes compacting',
      retainUntilObserved: true,
    });

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage(
      'continue after the provider finishes compacting',
      150_000,
    ))).toBe(true);
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage(
      'continue after the provider finishes compacting',
      150_001,
    ))).toBe(false);
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('/effort high', 150_002))).toBe(true);
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('/effort high', 150_003))).toBe(false);
  });

  it('does not suppress an expired prompt echo behind an unmatched durable control command', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      nowMs: () => 10_000,
      acceptedPromptEchoWindowMs: 5_000,
    });

    suppressor.recordAcceptedPrompt({ message: '/effort high', retainUntilObserved: true });
    suppressor.recordAcceptedPrompt({ message: 'expired ordinary prompt' });

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('expired ordinary prompt', 15_001))).toBe(false);
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('/effort high', 15_002))).toBe(true);
  });

  it('suppresses normalized accepted prompt echoes, not only byte-identical text', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({
      nowMs: () => 1_000,
      acceptedPromptEchoWindowMs: 5_000,
    });

    suppressor.recordAcceptedPrompt({
      message: '  first line\r\nsecond line  ',
    });

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('first line\nsecond line', 1_100))).toBe(true);
  });

  it('bounds the persisted prompt-text registry by evicting the oldest entries', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({ nowMs: () => 1_000 });

    // Seed far past the bound; only the newest entries may survive.
    const total = 2_500;
    for (let i = 0; i < total; i += 1) {
      suppressor.recordPersistedUserPromptTexts([{ text: `persisted prompt ${i}`, suppressBeforeMs: 1_000_000 }]);
    }

    // The oldest entry was evicted: it no longer suppresses a matching transcript row.
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('persisted prompt 0', 2_000))).toBe(false);
    // The newest entry still suppresses.
    expect(suppressor.shouldSuppressTranscriptMessage(userMessage(`persisted prompt ${total - 1}`, 2_000))).toBe(true);
  });

  it('suppresses persisted prompt text using the normalized prompt identity', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({ nowMs: () => 1_000 });

    suppressor.recordPersistedUserPromptTexts([{
      text: '  persisted prompt\r\nwith trailing spaces   ',
      suppressBeforeMs: 5_000,
    }]);

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('persisted prompt\nwith trailing spaces', 2_000))).toBe(true);
  });

  it('removes consumed normalized persisted prompt buckets so stale empty entries cannot evict live prompts', () => {
    const suppressor = createClaudeUnifiedPromptEchoSuppressor({ nowMs: () => 1_000 });

    suppressor.recordPersistedUserPromptTexts([
      { text: 'oldest live prompt', suppressBeforeMs: 1_000_000 },
      { text: 'normalized persisted prompt', suppressBeforeMs: 1_000_000 },
    ]);

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('  normalized persisted prompt  ', 2_000))).toBe(true);

    for (let i = 0; i < 2_047; i += 1) {
      suppressor.recordPersistedUserPromptTexts([{ text: `new prompt ${i}`, suppressBeforeMs: 1_000_000 }]);
    }

    expect(suppressor.shouldSuppressTranscriptMessage(userMessage('oldest live prompt', 2_000))).toBe(true);
  });
});
