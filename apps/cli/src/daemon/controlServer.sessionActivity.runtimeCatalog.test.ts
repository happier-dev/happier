import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createDaemonControlApp } from './controlServer';
import { createDaemonAdmissionDrain } from './lifecycle/admissionDrain';
import { SessionActivityChangedResponseSchema } from './sessions/sessionActivityChangedContract';
import { reloadConfiguration } from '@/configuration';
import { logger } from '@/ui/logger';
import axios from 'axios';
import { createSessionFollowOccurrenceDispatcher } from '@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher.testkit';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { daemonPost } from './controlHttp';
import { SessionFollowObserveSourceRoutesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ScmDiffSummaryResultRevisionHint } from '@happier-dev/protocol/scm/diffSummaryResult';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// Source-only composition: loopback HTTP and the actual Follow dispatcher do
// not launch the packaged CLI or require native-runtime build preparation.
describe('private Session activity invalidation', () => {
  it('carries the original requester admission through authenticated loopback result and detached Run hints', async () => {
    const executionAuthorizationToken = 'original-home-admission';
    const result = vi.fn();
    const run = vi.fn();
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      onScmDiffSummaryResultUpdated: result, onSessionActivityChanged: run });
    try {
      const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
      const target = { pid: process.pid, httpPort: Number(address.port), controlToken: 'token' };
      const change = { resultId: 'requester-result', revision: 3, executionAuthorizationToken };
      await daemonPost('/scm-diff-summary-result-updated', change, { target });
      await daemonPost('/session-activity-changed', { sessionId: null, executionRunId: 'requester-run', executionAuthorizationToken }, { target });
      expect(result.mock.calls).toEqual([[change]]);
      expect(run.mock.calls).toEqual([[null, undefined, 'requester-run', undefined, undefined, executionAuthorizationToken]]);
    } finally { await app.close(); }
  });

  it('forwards saved-result revisions from either process through authenticated content-free control ingress', async () => {
    const received: ScmDiffSummaryResultRevisionHint[] = [];
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      onScmDiffSummaryResultUpdated: change => { received.push(change); } });
    try {
      const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
      const target = { pid: process.pid, httpPort: Number(address.port), controlToken: 'token' };
      for (const revision of [2, 3]) await daemonPost('/scm-diff-summary-result-updated', { resultId: 'proposal', revision }, { target });
      expect(received).toEqual([2, 3].map(revision => ({ resultId: 'proposal', revision })));
      expect((await app.inject({ method: 'POST', url: '/scm-diff-summary-result-updated', payload: { resultId: 'proposal', revision: 4 } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/scm-diff-summary-result-updated',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { resultId: 'proposal', revision: 4, content: 'private' } })).statusCode).toBe(400);
      expect(received).toHaveLength(2);
    } finally { await app.close(); }
  });

  it.each([
    { failure: createHttpStatusError(403, 'PRIVATE_RESPONSE', 'not_authenticated'),
      errorClass: 'HttpStatusError', errorCode: 'not_authenticated', retryable: false },
    { failure: Object.assign(new Error('PRIVATE_TIMEOUT'), { name: 'AxiosError', code: 'ETIMEDOUT',
        config: { headers: { Authorization: 'PRIVATE_BEARER' } } }),
      errorClass: 'AxiosError', errorCode: 'ETIMEDOUT', retryable: true },
    { failure: new TypeError('PRIVATE_FAILURE\n    at /PRIVATE_PAYLOAD.js:1:2'),
      errorClass: 'TypeError', errorCode: 'protocol_error', retryable: false },
    { failure: new PluginError({ code: 'project_requester_home_unavailable', message: 'PRIVATE_HOME', retryable: true }),
      errorClass: 'Error', errorCode: 'project_requester_home_unavailable', retryable: true },
    { failure: new PluginError({ code: 'PRIVATE_PLUGIN_CODE', message: 'PRIVATE_PLUGIN_MESSAGE', retryable: true }),
      errorClass: 'Error', errorCode: 'network', retryable: true },
    { failure: createHttpStatusError(403, 'PRIVATE_TERMINAL_RESPONSE', 'not_authenticated'), terminal: true,
      errorClass: 'HttpStatusError', errorCode: 'not_authenticated', retryable: false },
  ])('records a content-free typed cause when source dispatch fails ($errorCode, terminal=$terminal)', async scenario => {
    const { failure, errorClass, errorCode, retryable } = scenario;
    const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    // HTTP is the failing system boundary; ingress and Follow dispatch remain real.
    const routes = vi.spyOn(axios, 'post').mockRejectedValue(failure);
    const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
      token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null,
    }, serverId: 'home', serverHttpBaseUrl: 'http://follow-failure.test', machineId: 'machine', installationId: 'installation',
      signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
      resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
    const app = createDaemonControlApp({
      getChildren: () => [{ trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'source' }], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'source' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      onSessionActivityChanged: async (_sessionId, occurrence) => {
        if (occurrence && !('original' in occurrence)) return await dispatcher.dispatch(occurrence);
      },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/session-activity-changed',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: 'source', followOccurrence: {
          sourceSessionId: 'source', sourcePublisher: { machineId: 'machine', committedFenceMs: 1, publisherGeneration: '1' },
          ...('terminal' in scenario ? { sourceTurn: { id: 'host-turn', status: 'completed' } }
            : { sourceMessage: { localId: 'PRIVATE_ORIGINAL', seq: 16 } }),
          evidence: { v: 1, ownerAccountId: 'account-1', event: { kind: 'terminal' in scenario ? 'finished' : 'message' },
            facts: { serverId: 'home', kind: 'session' } },
        } } });
      expect(response.statusCode).toBe(500);
      expect(routes).toHaveBeenCalledTimes(1);
      const failed = log.mock.calls.filter(([message, fields]) => message === '[Session Follow] Occurrence ingress'
        && fields && typeof fields === 'object' && 'status' in fields && fields.status === 'failed');
      expect(failed).toEqual([[expect.any(String), expect.objectContaining({ sourceSessionId: 'source',
        ...('terminal' in scenario ? { sourceTurnId: 'host-turn' } : { sourceMessageSeq: 16 }),
        status: 'failed', phase: 'dispatch', errorClass, errorCode, retryable })]]);
      expect(JSON.stringify(failed)).not.toContain('PRIVATE_');
    } finally { await app.close(); dispatcher.dispose(); routes.mockRestore(); log.mockRestore(); }
  });

  it('correlates a source occurrence before waiting for dispatch without logging its authored local id or evidence', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const env = createEnvKeyScope(['HAPPIER_DAEMON_HTTP_TIMEOUT']);
    env.patch({ HAPPIER_DAEMON_HTTP_TIMEOUT: '100' });
    const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v2/account/session-follow-preferences') return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (path === '/v2/account/session-follow-rules') { entered = true; await gate; return { status: 503, data: {} }; }
      throw new Error(`Unexpected GET ${path}`);
    });
    const routesHttp = vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(new URL(String(url)).pathname).toBe('/v2/sessions/source/follows/occurrence-routes');
      return { status: 200, data: SessionFollowObserveSourceRoutesResponseV1Schema.parse({
        ok: true, v: 1, sourceSessionId: 'source', routes: [],
      }) };
    });
    const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
      token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null,
    }, serverId: 'home', serverHttpBaseUrl: 'http://follow-ingress.test', machineId: 'machine', installationId: 'installation',
      signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
      resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
    const app = createDaemonControlApp({
      getChildren: () => [{ trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'source' }], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'source' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      onSessionActivityChanged: async (_sessionId, occurrence) => {
        if (occurrence && !('original' in occurrence)) return await dispatcher.dispatch(occurrence);
      },
    });
    const occurrence = { sourceSessionId: 'source', sourcePublisher: {
      machineId: 'machine', committedFenceMs: 1, publisherGeneration: '1',
    }, sourceMessage: { localId: 'private-authored-original', seq: 7 }, evidence: {
      v: 1, ownerAccountId: 'account-1', event: { kind: 'update_posted' }, facts: { serverId: 'private-home', kind: 'session' },
    } };
    try {
      // Use the actual HTTP client and control ingress: source reconciliation
      // may outlast generic control waits without retiring the Follow source.
      const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
      const pending = daemonPost('/session-activity-changed', { sessionId: 'source', followOccurrence: occurrence },
        { target: { pid: process.pid, httpPort: Number(address.port), controlToken: 'token' } });
      await vi.waitFor(() => expect(entered).toBe(true));
      const checkpoints = () => log.mock.calls.filter(([message]) => message === '[Session Follow] Occurrence ingress')
        .map(([, fields]) => fields);
      expect(checkpoints()).toEqual([expect.objectContaining({ requestId: expect.any(String), sourceSessionId: 'source',
        sourceMessageSeq: 7, status: 'started' })]);
      await new Promise<void>(resolve => setTimeout(resolve, 150));
      release();
      expect(await pending).toEqual({ ok: true });
      expect(checkpoints().at(-1)).toMatchObject({ sourceSessionId: 'source', sourceMessageSeq: 7, status: 'completed' });
      const ignored = await app.inject({ method: 'POST', url: '/session-activity-changed',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: 'source',
          followOccurrence: { ...occurrence, sourceSessionId: 'private-mismatched-source' } } });
      expect(ignored.statusCode).toBe(200);
      expect(checkpoints().at(-1)).toEqual({ requestId: expect.any(String), status: 'ignored' });
      expect(JSON.stringify(checkpoints())).not.toContain('private-');
    } finally { release(); await app.close(); dispatcher.dispose(); await channel.close(); routesHttp.mockRestore(); http.mockRestore(); log.mockRestore(); env.restore(); }
  });

  it('forwards canonical Run hints after the parent retires and rejects a mismatched source Session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'happier-run-follow-hint-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    const received: unknown[] = [];
    try {
      const app = createDaemonControlApp({
        getChildren: () => [], machineId: 'machine', stopSession: async () => ({ status: 'not_found' }),
        spawnSession: async () => ({ type: 'success', sessionId: 'parent' }), requestShutdown: () => {},
        onHappySessionWebhook: () => {}, controlToken: 'token',
        onSessionActivityChanged: (_sessionId, occurrence) => { received.push(occurrence); },
      });
      try {
        const notify = (sessionId: string, terminalEventId: string, sourceSessionId = sessionId) => app.inject({ method: 'POST', url: '/session-activity-changed',
          headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId,
            followOccurrence: { original: { source: { kind: 'execution_run', sessionId: sourceSessionId, runId: 'run-1' }, terminalEventId },
              event: { kind: 'failed_or_stopped' } } },
        });
        expect((await notify('parent', 'terminal-1')).statusCode).toBe(200);
        expect(received).toEqual([{ original: { source: { kind: 'execution_run', sessionId: 'parent', runId: 'run-1' }, terminalEventId: 'terminal-1' },
          event: { kind: 'failed_or_stopped' } }]);
        expect((await notify('parent', 'old-terminal')).statusCode).toBe(200);
        expect(received).toEqual(['terminal-1', 'old-terminal'].map(terminalEventId => ({
          original: { source: { kind: 'execution_run', sessionId: 'parent', runId: 'run-1' }, terminalEventId },
          event: { kind: 'failed_or_stopped' },
        })));
        expect((await notify('other', 'terminal-1', 'parent')).statusCode).toBe(200);
        expect(received).toHaveLength(2);
      } finally { await app.close(); }
    } finally {
      vi.unstubAllEnvs();
      reloadConfiguration();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('returns only the captured source contribution through the authenticated closed response', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [{ trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'session' }], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'session' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      onSessionActivityChanged: async () => ({ personalFollow: { sourceSessionId: 'session',
        requests: [{ requestId: 'question', policies: [{ preset: 'important' as const }] }] } }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/session-activity-changed',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: 'session' } });
      expect(response.statusCode).toBe(200);
      expect(SessionActivityChangedResponseSchema.parse(response.json())).toEqual({ ok: true, personalFollow: {
        sourceSessionId: 'session', requests: [{ requestId: 'question', policies: [{ preset: 'important' }] }],
      } });
      expect(SessionActivityChangedResponseSchema.safeParse({ ...SessionActivityChangedResponseSchema.parse(response.json()), privateRuleId: 'not-transportable' }).success).toBe(false);
    } finally { await app.close(); }
  });
  it('forwards an exact detached Run invalidation without fabricating a Session', async () => {
    const changed: unknown[] = [];
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      onSessionActivityChanged: (...args) => { changed.push(args); },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/session-activity-changed',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: null, executionRunId: 'detached-run' } });
      expect(response.statusCode).toBe(200);
      expect(changed).toEqual([[null, undefined, 'detached-run']]);
    } finally { await app.close(); }
  });
  it('accepts only authenticated content-free current Session edges and preserves publication during temporary drain', async () => {
    const changed: string[] = [];
    const drain = createDaemonAdmissionDrain();
    const app = createDaemonControlApp({
      getChildren: () => [{ trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'session' }], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'session' }), requestShutdown: () => {},
      onHappySessionWebhook: () => {}, controlToken: 'token', admissionDrain: drain,
      onSessionActivityChanged: sessionId => { if (sessionId) changed.push(sessionId); },
    });
    try {
      await app.ready();
      const notify = (payload: Record<string, unknown>, token = 'token') => app.inject({ method: 'POST', url: '/session-activity-changed',
        headers: { 'x-happier-daemon-token': token }, payload,
      });
      expect((await notify({ sessionId: 'session' }, 'wrong')).statusCode).toBe(401);
      expect((await notify({ sessionId: 'session', idle: true })).statusCode).toBe(400);
      expect((await notify({ sessionId: 'retired' })).statusCode).toBe(200);
      expect(changed).toEqual([]);
      drain.beginTemporaryDrain();
      expect((await notify({ sessionId: 'session' })).statusCode).toBe(200);
      expect(changed).toEqual(['session']);
      drain.beginShutdown();
      expect((await notify({ sessionId: 'session' })).statusCode).toBe(503);
    } finally { await app.close(); }
  });
});
