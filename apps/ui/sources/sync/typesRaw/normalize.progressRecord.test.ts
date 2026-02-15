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
});
