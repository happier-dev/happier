import { describe, expect, it, vi } from 'vitest';

import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';

import {
  createSessionListResponseFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';

import {
  createPendingSessionActivationRecovery,
  recoverPendingSessionActivations,
  type PendingSessionActivationInput,
} from './pendingSessionActivationRecovery';

describe('pending session activation recovery', () => {
  it('reconstructs reset demand for owned Pending rows through the same reconnect scan before activation', async () => {
    const visited: string[] = [];
    const activated: string[] = [];
    const recovery = createPendingSessionActivationRecovery({
      token: 'token',
      activate: async input => { activated.push(input.sessionId); },
      visitOwnedSession: async sessionId => { visited.push(sessionId); },
      warn: vi.fn(),
      fetchSessionsPage: async () => ({
        sessions: createSessionListResponseFixture([
          createSessionRecordFixture({ id: 'held-reset', pendingCount: 1 }),
          createSessionRecordFixture({ id: 'shared', pendingCount: 1, share: { accessLevel: 'view', canApprovePermissions: false } }),
        ]).sessions,
        hasNext: false, nextCursor: null,
      }),
    });
    await recovery.recoverAfterConnect();
    expect(visited).toEqual(['held-reset']);
    expect(activated).toEqual([]);
  });
  it('routes live hints and the reconnect scan through one canonical activator', async () => {
    const activate = vi.fn(async (_input: PendingSessionActivationInput) => undefined);
    const fetchSessionsPage = vi.fn(async () => {
      const fixture = createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'scan-session',
          pendingVersion: 5,
          pendingActivationAuthorization: { requestId: 'scan-request', requestedAt: 12, status: 'waiting' },
        }),
      ]);
      return {
        sessions: fixture.sessions,
        nextCursor: fixture.nextCursor ?? null,
        hasNext: fixture.hasNext ?? false,
      };
    });
    const recovery = createPendingSessionActivationRecovery({
      token: 'token',
      activate,
      warn: vi.fn(),
      fetchSessionsPage,
    });

    await recovery.activateHint({
      sessionId: 'live-session',
      requestId: 'live-request',
      pendingVersion: 4,
      source: 'live',
    });
    await recovery.recoverAfterConnect();

    expect(activate.mock.calls.map(([hint]) => hint)).toEqual([
      { sessionId: 'live-session', requestId: 'live-request', pendingVersion: 4, source: 'live' },
      { sessionId: 'scan-session', requestId: 'scan-request', pendingVersion: 5, source: 'scan' },
    ]);
    expect(fetchSessionsPage).toHaveBeenCalledOnce();
  });

  it('performs one finite paginated scan and activates every owned waiting authorization', async () => {
    const activate = vi.fn(async (_input: PendingSessionActivationInput) => undefined);
    const fetchSessionsPage = vi.fn()
      .mockResolvedValueOnce({
        sessions: [
          { id: 'waiting-1', pendingVersion: 3, pendingActivationAuthorization: { requestId: 'p1', requestedAt: 10, status: 'waiting' } },
          { id: 'waiting-unknown-target', pendingVersion: 4, pendingActivationAuthorization: { requestId: 'po', requestedAt: 11, status: 'waiting' } },
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

    await recoverPendingSessionActivations({ token: 'token', activate, warn: vi.fn(), fetchSessionsPage });

    expect(fetchSessionsPage).toHaveBeenCalledTimes(2);
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(1, { token: 'token', limit: 200 });
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, { token: 'token', limit: 200, cursor: 'next' });
    expect(activate.mock.calls.map(([hint]) => hint)).toEqual([
      { sessionId: 'waiting-1', requestId: 'p1', pendingVersion: 3, source: 'scan' },
      { sessionId: 'waiting-unknown-target', requestId: 'po', pendingVersion: 4, source: 'scan' },
      { sessionId: 'waiting-2', requestId: 'p2', pendingVersion: 5, source: 'scan' },
    ]);
  });

  it('uses current access before legacy fallback and fails malformed current or layout-one legacy rows closed', async () => {
    const recipientCapabilities = projectSessionAccessCapabilitiesV1({
      owner: false,
      grants: [{ accessLevel: 'view', canApprovePermissions: false }],
    });
    const ownerCapabilities = projectSessionAccessCapabilitiesV1({ owner: true, grants: [] });
    const activate = vi.fn(async (_input: PendingSessionActivationInput) => undefined);
    const nullCurrentSession = createSessionRecordFixture({
      id: 'null-current-is-malformed',
      share: null,
      pendingVersion: 4,
      pendingActivationAuthorization: { requestId: 'pn', requestedAt: 11, status: 'waiting' },
    });
    Reflect.set(nullCurrentSession, 'effectiveAccess', null);
    const malformedCurrentSession = createSessionRecordFixture({
      id: 'malformed-current',
      share: null,
      pendingVersion: 4,
      pendingActivationAuthorization: { requestId: 'pm', requestedAt: 11, status: 'waiting' },
    });
    Reflect.set(malformedCurrentSession, 'effectiveAccess', { v: 1, level: 'owner' });
    const fetchSessionsPage = vi.fn(async () => {
      const fixture = createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'direct-current',
          share: null,
          pendingVersion: 4,
          pendingActivationAuthorization: { requestId: 'pd', requestedAt: 11, status: 'waiting' },
          effectiveAccess: {
            v: 1,
            level: 'edit',
            sources: [{ kind: 'direct', shareId: 'share-1' }],
            capabilities: recipientCapabilities,
          },
        }),
        createSessionRecordFixture({
          id: 'team-only',
          pendingVersion: 4,
          pendingActivationAuthorization: { requestId: 'pt', requestedAt: 11, status: 'waiting' },
          effectiveAccess: {
            v: 1,
            level: 'view',
            sources: [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }],
            capabilities: recipientCapabilities,
          },
        }),
        createSessionRecordFixture({
          id: 'group-only',
          pendingVersion: 4,
          pendingActivationAuthorization: { requestId: 'pg', requestedAt: 11, status: 'waiting' },
          effectiveAccess: {
            v: 1,
            level: 'view',
            sources: [{ kind: 'group', teamId: 'team-1', groupId: 'group-1' }],
            capabilities: recipientCapabilities,
          },
        }),
        nullCurrentSession,
        malformedCurrentSession,
        createSessionRecordFixture({
          id: 'layout-one-missing-share',
          metadataLayoutVersion: 1,
          pendingVersion: 4,
          pendingActivationAuthorization: { requestId: 'pl', requestedAt: 11, status: 'waiting' },
        }),
        createSessionRecordFixture({
          id: 'legacy-direct',
          share: { accessLevel: 'admin', canApprovePermissions: true },
          pendingVersion: 4,
          pendingActivationAuthorization: { requestId: 'pr', requestedAt: 11, status: 'waiting' },
        }),
        createSessionRecordFixture({
          id: 'legacy-layout-zero-owner',
          metadataLayoutVersion: 0,
          pendingVersion: 4,
          pendingActivationAuthorization: { requestId: 'pz', requestedAt: 11, status: 'waiting' },
        }),
        createSessionRecordFixture({
          id: 'home:https://example.test:opaque/session',
          share: null,
          metadataLayoutVersion: 1,
          pendingVersion: 4,
          pendingActivationAuthorization: { requestId: 'px', requestedAt: 11, status: 'waiting' },
        }),
        createSessionRecordFixture({
          id: 'owned-current',
          share: null,
          pendingVersion: 4,
          pendingActivationAuthorization: { requestId: 'po', requestedAt: 11, status: 'waiting' },
          effectiveAccess: {
            v: 1,
            level: 'owner',
            sources: [{ kind: 'owner' }],
            capabilities: ownerCapabilities,
          },
        }),
      ]);
      return {
        sessions: fixture.sessions,
        nextCursor: fixture.nextCursor ?? null,
        hasNext: fixture.hasNext ?? false,
      };
    });

    await recoverPendingSessionActivations({ token: 'token', activate, warn: vi.fn(), fetchSessionsPage });

    expect(activate.mock.calls.map(([hint]) => hint.sessionId)).toEqual([
      'legacy-layout-zero-owner',
      'home:https://example.test:opaque/session',
      'owned-current',
    ]);
  });

  it('observes one activation failure and continues the finite scan', async () => {
    const warn = vi.fn();
    const activate = vi.fn(async (input: PendingSessionActivationInput) => {
      if (input.sessionId === 'waiting-1') throw new Error('temporary failure');
    });
    const fetchSessionsPage = vi.fn()
      .mockResolvedValueOnce({
        sessions: [
          { id: 'waiting-1', pendingActivationAuthorization: { requestId: 'p1', requestedAt: 10, status: 'waiting' } },
          { id: 'waiting-2', pendingActivationAuthorization: { requestId: 'p2', requestedAt: 11, status: 'waiting' } },
        ],
        hasNext: true,
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        sessions: [
          { id: 'waiting-3', pendingActivationAuthorization: { requestId: 'p3', requestedAt: 12, status: 'waiting' } },
        ],
        hasNext: false,
        nextCursor: null,
      });

    await recoverPendingSessionActivations({ token: 'token', activate, fetchSessionsPage, warn });

    expect(activate.mock.calls.map(([input]) => input.sessionId)).toEqual(['waiting-1', 'waiting-2', 'waiting-3']);
    expect(warn).toHaveBeenCalledOnce();
  });
});
