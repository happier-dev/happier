import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { fetchChanges } from './changes';
import { HttpStatusError } from './client/httpStatusError';

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

  it('rejects a widened pluginDomain change hint before it reaches recovery', async () => {
    (axios.get as any).mockResolvedValue({
      status: 200,
      data: {
        changes: [{
          cursor: 1,
          kind: 'pluginDomain',
          entityId: 'pluginDomain/example.tasks/availability',
          changedAt: Date.now(),
          hint: {
            pluginDomain: 'availability',
            pluginId: 'example.tasks',
            revision: 1,
          },
        }],
        nextCursor: 1,
      },
    });

    await expect(fetchChanges({ token: 't', after: 0 })).resolves.toMatchObject({ status: 'error' });
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

  it('requests and parses one exact Session access probe without changing the feed cursor', async () => {
    (axios.get as any).mockResolvedValue({
      status: 200,
      data: {
        changes: [],
        nextCursor: 37,
        sessionAccessProbe: {
          v: 1,
          sessionId: 'session-current',
          throughCursor: 37,
          status: 'available',
        },
      },
    });

    const result = await fetchChanges({
      token: 't',
      after: 0,
      sessionAccessSessionId: 'session-current',
    });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/v2/changes'),
      expect.objectContaining({
        params: { after: 0, limit: 200, sessionAccessSessionId: 'session-current' },
      }),
    );
    expect(result).toMatchObject({
      status: 'ok',
      response: {
        sessionAccessProbe: {
          sessionId: 'session-current',
          throughCursor: 37,
          status: 'available',
        },
      },
    });
  });

  it.each([401, 403] as const)('returns canonical not_authenticated error for auth status %i', async (status) => {
    (axios.get as any).mockResolvedValue({
      status,
      data: { error: 'not-authenticated' },
    });

    const result = await fetchChanges({ token: 't', after: 0 });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.error).toBeInstanceOf(HttpStatusError);
    expect(result.error).toMatchObject({
      code: 'not_authenticated',
      response: { status },
    });
  });

  it.each([401, 403] as const)('fetchChangesAccountId throws canonical not_authenticated for profile auth status %i', async (status) => {
    const changesModule = await import('./changes') as typeof import('./changes') & {
      fetchChangesAccountId?: (opts: { token: string }) => Promise<string>;
    };
    expect(typeof changesModule.fetchChangesAccountId).toBe('function');
    if (!changesModule.fetchChangesAccountId) return;

    (axios.get as any).mockResolvedValue({
      status,
      data: { error: 'not-authenticated' },
    });

    await expect(changesModule.fetchChangesAccountId({ token: 't' })).rejects.toMatchObject({
      code: 'not_authenticated',
      response: { status },
    });
  });
});
