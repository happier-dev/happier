import { describe, expect, it } from 'vitest';

import { TranscriptRawRecordV1Schema } from './transcriptRawRecordV1.js';

describe('TranscriptRawRecordV1Schema', () => {
  it('parses user text records with extra fields', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'user',
      content: { type: 'text', text: 'hello', extra: true },
      meta: { source: 'ui', model: null },
      unknownTopLevel: { ok: true },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses agent output records with unknown output data types', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'opaque_future_type',
          anything: { nested: true },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts hyphenated tool-call blocks (normalized later)', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                callId: 'call_1',
                name: 'Bash',
                input: { cmd: 'echo hi' },
              },
            ],
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses acp records with unknown data types (forward compatibility)', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'acp',
        provider: 'future-provider',
        data: {
          type: 'some_future_event',
          any: { payload: true },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses codex turn_aborted lifecycle records', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'turn_aborted',
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('parses assistant content blocks with unknown types (forward compatibility)', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'new_block_type', payload: { ok: true } },
            ],
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('does not drop messages when usage shape changes (invalid usage is ignored)', () => {
    const parsed = TranscriptRawRecordV1Schema.safeParse({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            usage: {
              // Missing required token counts for our structured usage parser.
              output_tokens: 5,
              something_new: true,
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect((parsed.success ? (parsed.data as any).content.data.message.usage : null)).toBeUndefined();
  });
});
