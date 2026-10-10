import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

await loadSyncSingletonForTests();
const { sessionDeleteWithServerAccountAuthority } = await import('../sessions');

afterEach(() => vi.restoreAllMocks());

describe('Voice-history deletion through the bound Account authority', () => {
  it('deletes the exact encoded Session address', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await sessionDeleteWithServerAccountAuthority('session/one', { request })).toEqual({ success: true });
    expect(request).toHaveBeenCalledWith('/v1/sessions/session%2Fone', { method: 'DELETE' });
  });

  it.each([
    { status: 404, code: 'session_absent', error: 'Session not found or not owned by user' },
    { status: 409, code: 'session_delete_conflict', error: 'Session delete condition was lost' },
  ])('retains $code so cleanup cannot discard live rows on conflict', async ({ status, code, error }) => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error }), { status }));
    expect(await sessionDeleteWithServerAccountAuthority('session', { request }))
      .toEqual({ success: false, code, message: JSON.stringify({ error }) });
  });

  it('does not classify an unrecognized failure as absence', async () => {
    const request = vi.fn(async () => new Response('boom', { status: 500 }));
    expect(await sessionDeleteWithServerAccountAuthority('session', { request }))
      .toEqual({ success: false, message: 'boom' });
  });
});
