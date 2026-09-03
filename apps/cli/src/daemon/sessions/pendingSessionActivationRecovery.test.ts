import { describe, expect, it, vi } from 'vitest';

import {
  recoverPendingSessionActivations,
  type PendingSessionActivationInput,
} from './pendingSessionActivationRecovery';

describe('pending session activation recovery', () => {
  it('performs one finite paginated scan and activates every waiting durable authorization', async () => {
    const activate = vi.fn(async (_input: PendingSessionActivationInput) => undefined);
    const fetchSessionsPage = vi.fn()
      .mockResolvedValueOnce({
        sessions: [
          { id: 'waiting-1', pendingVersion: 3, pendingActivationAuthorization: { requestId: 'p1', requestedAt: 10, status: 'waiting' } },
          { id: 'waiting-unknown-target', pendingVersion: 4, pendingActivationAuthorization: { requestId: 'po', requestedAt: 11, status: 'waiting' } },
          { id: 'unknown-machine', pendingVersion: 4, pendingActivationAuthorization: { requestId: 'pu', requestedAt: 11, status: 'waiting' } },
          { id: 'shared', share: { accessLevel: 'view', canApprovePermissions: false }, pendingVersion: 4, pendingActivationAuthorization: { requestId: 'ps', requestedAt: 11, status: 'waiting' } },
          { id: 'failed', pendingVersion: 4, pendingActivationAuthorization: { requestId: 'pf', requestedAt: 11, status: 'failed', failureCode: 'runtime_start_failed' } },
          { id: 'absent' },
        ],
        hasNext: true,
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        sessions: [
          { id: 'waiting-2', pendingVersion: 5, pendingActivationAuthorization: { requestId: 'p2', requestedAt: 12, status: 'waiting' } },
        ],
        hasNext: false,
        nextCursor: null,
      });

    await recoverPendingSessionActivations({ token: 'token', activate, fetchSessionsPage });

    expect(fetchSessionsPage).toHaveBeenCalledTimes(2);
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(1, { token: 'token', limit: 200 });
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, { token: 'token', limit: 200, cursor: 'next' });
    expect(activate.mock.calls.map(([hint]) => hint)).toEqual([
      { sessionId: 'waiting-1', requestId: 'p1', pendingVersion: 3, source: 'scan' },
      { sessionId: 'waiting-unknown-target', requestId: 'po', pendingVersion: 4, source: 'scan' },
      { sessionId: 'unknown-machine', requestId: 'pu', pendingVersion: 4, source: 'scan' },
      { sessionId: 'waiting-2', requestId: 'p2', pendingVersion: 5, source: 'scan' },
    ]);
  });
});
