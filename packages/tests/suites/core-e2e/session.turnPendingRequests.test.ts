import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession, fetchSessionV2 } from '../../src/testkit/sessions';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import { createSessionScopedSocketCollector, createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: pending request settlement ownership', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it.each(['http-complete', 'publisher-close', 'released-ui-stop'] as const)('preserves pending requests through %s until their state settles', async (settlement) => {
    server = await startServerLight({ testDir: run.testDir(`terminal-turn-pending-requests-${settlement}`), dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);
    const turnId = randomUUID();
    const binding = await createMachineBoundSessionScopedSocketCollector({
      baseUrl: server.baseUrl, token: auth.token, sessionId,
    });
    const publisher = binding.socket;
    const sessionObserver = createSessionScopedSocketCollector(server.baseUrl, auth.token, sessionId);
    const observer = createUserScopedSocketCollector(server.baseUrl, auth.token);

    try {
      publisher.connect();
      observer.connect();
      sessionObserver.connect();
      await waitFor(() => publisher.isConnected() && observer.isConnected() && sessionObserver.isConnected(), { timeoutMs: 20_000 });
      await expect(publisher.emitWithAck('session-runtime-activity-snapshot', {
        sessionId, mutationId: randomUUID(), snapshot: { state: 'unknown', activeCount: 0 },
      })).resolves.toMatchObject({ status: 'unchanged' });
      await expect(publisher.emitWithAck('session-turn-mutation', {
        v: 1, sessionId, mutationId: randomUUID(), turnId, action: 'begin', observedAt: Date.now(),
      })).resolves.toMatchObject({ result: 'success', applied: true });
      const snapshot = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      await expect(publisher.emitWithAck('update-state', {
        sid: sessionId,
        expectedVersion: snapshot.agentStateVersion,
        agentState: 'ciphertext',
        activitySummaryV1: {
          pendingPermissionRequestCount: 1,
          pendingUserActionRequestCount: 1,
        },
      })).resolves.toMatchObject({ result: 'success' });
      expect(await fetchSessionV2(server.baseUrl, auth.token, sessionId)).toMatchObject({
        pendingPermissionRequestCount: 1,
        pendingUserActionRequestCount: 1,
      });

      // Lifecycle transitions publish turn facts without settling unrelated pending requests.
      const terminalMutation = {
        v: 1, sessionId, mutationId: randomUUID(), turnId, action: 'complete', observedAt: Date.now(),
      };
      if (settlement === 'http-complete') {
        const response = await fetchJson(`${server.baseUrl}/v1/sessions/${sessionId}/turns/mutations`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(terminalMutation),
        });
        expect(response.status).toBe(200);
        expect(response.data).toMatchObject({ success: true, applied: true });
      } else if (settlement === 'publisher-close') {
        await expect(publisher.emitWithAck('session-runtime-activity-close', { sessionId }))
          .resolves.toMatchObject({ status: 'closed' });
      } else {
        observer.emit('session-end', { sid: sessionId, time: Date.now() });
      }
      const terminalStatus = settlement === 'http-complete' ? 'completed' : 'cancelled';
      for (const client of [sessionObserver, observer]) {
        await waitFor(() => client.getEvents().some((event) => event.kind === 'update'
          && event.payload.body?.latestTurnStatus === terminalStatus), {
          timeoutMs: 20_000, context: `${settlement} terminal update for ${client === observer ? 'initiating UI' : 'session observer'}`,
        });
      }
      expect(await fetchSessionV2(server.baseUrl, auth.token, sessionId)).toMatchObject({
        latestTurnStatus: terminalStatus,
        pendingPermissionRequestCount: 1,
        pendingUserActionRequestCount: 1,
      });
      if (settlement === 'http-complete') {
        const duplicate = await fetchJson(`${server.baseUrl}/v1/sessions/${sessionId}/turns/mutations`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(terminalMutation),
        });
        expect(duplicate.data).toMatchObject({ success: true, applied: false });
      }
      // Only the actual request-state write clears the committed count projection.
      const beforeSettlement = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      await expect(observer.emitWithAck('update-state', {
        sid: sessionId,
        expectedVersion: beforeSettlement.agentStateVersion,
        agentState: 'settled-ciphertext',
        activitySummaryV1: { pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 },
      })).resolves.toMatchObject({ result: 'success' });
      await waitFor(() => sessionObserver.getEvents().some((event) => event.kind === 'update'
        && event.payload.body?.pendingPermissionRequestCount === 0
        && event.payload.body?.pendingUserActionRequestCount === 0
        && event.payload.body?.pendingRequestObservedAt === null), {
        timeoutMs: 20_000, context: `${settlement} committed request settlement`,
      });
      await expect(publisher.emitWithAck('session-turn-mutation', {
        v: 1, sessionId, mutationId: randomUUID(), turnId: randomUUID(), action: 'begin', observedAt: Date.now(),
      })).resolves.toMatchObject({ result: 'success', applied: true });
      expect(await fetchSessionV2(server.baseUrl, auth.token, sessionId)).toMatchObject({
        latestTurnStatus: 'in_progress', pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
      });
    } finally {
      publisher.close();
      sessionObserver.close();
      observer.close();
    }
  });
});
