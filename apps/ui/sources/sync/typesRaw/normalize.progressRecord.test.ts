import { describe, expect, it } from 'vitest';

import { normalizeRawMessage } from './normalize';
import { RawRecordSchema } from './schemas';

describe('typesRaw progress record handling', () => {
  it('accepts output progress records and drops them during normalization', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'progress',
          uuid: 'progress-1',
          status: 'running',
        },
      },
      meta: { source: 'cli' },
    };

    const parsed = RawRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    const normalized = normalizeRawMessage('msg-progress', null, 1000, raw);
    expect(normalized).toBeNull();
  });

  it('accepts Claude tool_progress heartbeat records and drops them during normalization', () => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'tool_progress',
          uuid: 'tool-progress-1',
          tool_name: 'Bash',
          tool_use_id: 'tool-1',
          elapsed_time_seconds: 30,
          heartbeat: true,
        },
      },
      meta: { source: 'cli' },
    };

    const parsed = RawRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    const normalized = normalizeRawMessage('msg-tool-progress', null, 1000, raw);
    expect(normalized).toBeNull();
  });

  it.each(['turn_failed', 'turn_cancelled', 'turn_aborted'] as const)(
    'accepts codex %s records and drops them during normalization',
    (type) => {
    const raw: any = {
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type,
        },
      },
      meta: { source: 'cli' },
    };

    const parsed = RawRecordSchema.safeParse(raw);
    expect(parsed.success).toBe(true);

    const normalized = normalizeRawMessage(`msg-${type}`, null, 1000, raw);
    expect(normalized).toBeNull();
    },
  );
});
