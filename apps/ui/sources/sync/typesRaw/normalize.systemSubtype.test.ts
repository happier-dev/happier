import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './normalize';
import { RawRecordSchema } from './schemas';

describe('typesRaw system message handling', () => {
  it('drops Claude stop_hook_summary system messages during normalization', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'system',
          subtype: 'stop_hook_summary',
          uuid: 'system-stop-hook-1',
          hookCount: 5,
          hookInfos: [{ command: 'noop', durationMs: 10 }],
          hookErrors: [],
          preventedContinuation: false,
          stopReason: '',
        },
      },
    };

    const parsed = RawRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    const normalized = normalizeRawMessage('msg-system-1', null, 1000, raw);
    expect(normalized).toBeNull();
  });

  it('drops Claude away_summary system messages during normalization', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'system',
          subtype: 'away_summary',
          uuid: 'system-away-1',
          content: 'Summary of session activity so far.',
        },
      },
    };

    const parsed = RawRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    const normalized = normalizeRawMessage('msg-system-2', null, 1000, raw);
    expect(normalized).toBeNull();
  });

  it('drops unknown system subtypes (forward compatibility)', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'system',
          subtype: 'some_future_subtype',
          uuid: 'system-future-1',
        },
      },
    };

    const normalized = normalizeRawMessage('msg-system-3', null, 1000, raw);
    expect(normalized).toBeNull();
  });
});
