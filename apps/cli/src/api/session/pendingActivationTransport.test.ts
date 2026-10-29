import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { reportPendingSessionActivationFailure } from './pendingActivationTransport';

const post = vi.hoisted(() => vi.fn());

describe('pending activation transport', () => {
  beforeEach(() => {
    post.mockReset();
    vi.spyOn(axios, 'post').mockImplementation(post);
  });
  afterEach(() => vi.restoreAllMocks());
  it('keeps the predecessor failure body and sends optional diagnostic query facts', async () => {
    post.mockResolvedValueOnce({ data: { ok: true, didFail: true } });
    await reportPendingSessionActivationFailure({ token: 'token', sessionId: 'session', requestId: 'p1', requestedAt: 1,
      failureCode: 'runtime_start_failed', failureDetails: { reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED' } });
    expect(post.mock.calls[0]?.[1]).toEqual({ requestId: 'p1', requestedAt: 1, failureCode: 'runtime_start_failed' });
    expect(post.mock.calls[0]?.[2]?.params).toEqual({ failureDetails: JSON.stringify({ reason: 'spawn-rejected', spawnErrorCode: 'SPAWN_VALIDATION_FAILED' }) });
  });

  it('reports terminal runtime-start failure through the exact request CAS route', async () => {
    post.mockResolvedValueOnce({ data: { ok: true, didFail: true } });

    await expect(reportPendingSessionActivationFailure({
      token: 'token',
      sessionId: 'session/with spaces',
      requestId: 'pending-1',
      requestedAt: 10,
      failureCode: 'runtime_start_failed',
    })).resolves.toEqual({ didFail: true });

    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/session%2Fwith%20spaces\/pending\/activation\/fail$/),
      {
        requestId: 'pending-1',
        requestedAt: 10,
        failureCode: 'runtime_start_failed',
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });
});
