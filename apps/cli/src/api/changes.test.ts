import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { fetchChanges } from './changes';

vi.mock('axios');

describe('fetchChanges', () => {
  it('parses ok response', async () => {
    (axios.get as any).mockResolvedValue({
      status: 200,
      data: {
        changes: [{ cursor: 1, kind: 'session', entityId: 's1', changedAt: Date.now(), hint: null }],
        nextCursor: 1,
      },
    });

    const result = await fetchChanges({ token: 't', after: 0 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.response.nextCursor).toBe(1);
    expect(result.response.changes).toHaveLength(1);
  });

  it('parses cursor-gone (410)', async () => {
    (axios.get as any).mockResolvedValue({
      status: 410,
      data: { error: 'cursor-gone', currentCursor: 42 },
    });

    const result = await fetchChanges({ token: 't', after: 999 });
    expect(result).toEqual({ status: 'cursor-gone', currentCursor: 42 });
  });

  it('returns error when /v2/changes is missing (e.g. old server 404)', async () => {
    (axios.get as any).mockResolvedValue({
      status: 404,
      data: { error: 'not-found' },
    });

    const result = await fetchChanges({ token: 't', after: 0 });
    expect(result.status).toBe('error');
  });
});
