import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, SessionWorkStateGetResponseV1Schema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { decryptLegacy } from '../../../../apps/cli/src/api/encryption';
import { createCliActionExecutorFromCredentials } from '../../../../apps/cli/src/session/actions/createCliActionExecutorFromCredentials';
import { startCodexAppServerRemoteHarness, type StartedCodexAppServerRemoteHarness } from '../../src/testkit/codexAppServerRemoteHarness';
import { fetchJson } from '../../src/testkit/http';
import { decodeBase64, encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { repoRootDir } from '../../src/testkit/paths';
import { createRunDirs } from '../../src/testkit/runDir';
import { callLegacyEncryptedSessionRpc } from '../../src/testkit/sessionRpc';
import { fetchMessagesSince, fetchSessionV2 } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'fin-goal' });

describe('FIN J9: native Goal handoff preserves an ordinary ready Session', () => {
  let harness: StartedCodexAppServerRemoteHarness | undefined;
  let socket: SocketCollector | undefined;
  let refuseCleanup = false;
  afterAll(async () => {
    try {
      socket?.close();
      await harness?.stop();
    } finally {
      socket = undefined;
      harness = undefined;
      vi.unstubAllEnvs();
    }
  });

  beforeAll(async () => {
    const sourceOptions = [process.env.NODE_OPTIONS, '--import',
      pathToFileURL(resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    vi.stubEnv('NODE_OPTIONS', sourceOptions);
    vi.stubEnv('HAPPIER_FEATURE_WORKFLOWS__ENABLED', '1');
    vi.stubEnv('HAPPIER_FEATURE_AUTOMATIONS__ENABLED', '1');
    harness = await startCodexAppServerRemoteHarness({
      testDir: run.testDir('J9-native-goal-cleanup-refused'), runId: run.runId,
      testName: 'J9-native-goal-cleanup-refused',
      cliEnvOverrides: { ...process.env, NODE_OPTIONS: sourceOptions,
        HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
      serverRequestProxy: { rewriteResponseBody: {
        when: request => refuseCleanup && request.method === 'POST' && request.path === '/v3/automations/query',
        statusCode: 409,
        rewrite: () => JSON.stringify({ code: 'target_unavailable' }),
      } },
    });
  });

  it('refuses only the Goal transition when Keep-going cleanup is refused, then accepts another prompt and explicit retry', async () => {
    if (!harness) throw new Error('J9 native Goal harness did not start');
    const { auth, secret, serverBaseUrl, sessionId } = harness;
    const features = FeaturesResponseSchema.parse((await fetchJson<unknown>(`${serverBaseUrl}/v1/features`)).data);
    const serverId = features.capabilities.serverIdentity.serverIdentityId;
    expect(serverId).toBeTruthy();
    if (!serverId) throw new Error('J9 server did not publish its identity');
    const credentials = { token: auth.token, encryption: { type: 'legacy' as const, secret },
      credentialProvenance: 'stored_session' as const };
    const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
      serverId, serverIdentityId: serverId, serverApiUrl: serverBaseUrl });
    const actionContext = { surface: 'cli' as const, authority: 'present_user' as const,
      actionCaller: { kind: 'host' as const }, serverId, serverIdentityId: serverId };
    const setGoal = (objective: string) => executor.execute('session.goal.set', { sessionId, objective },
      { ...actionContext, actionRequestId: randomUUID() });

    async function ordinaryPrompt(text: string, starting = false) {
      const localId = `fin-j9-${randomUUID()}`;
      const queued = await enqueuePendingQueueV2({ baseUrl: serverBaseUrl, token: auth.token, sessionId, localId,
        ciphertext: encryptLegacyBase64({ role: 'user', content: { type: 'text', text }, localId,
          meta: { source: 'ui', sentFrom: 'e2e' } }, secret) });
      expect(queued.status).toBe(200);
      if (starting) await harness!.waitForProviderStartup();
      await waitFor(async () => {
        const replies = (await fetchMessagesSince({ baseUrl: serverBaseUrl, token: auth.token,
          sessionId, afterSeq: 0 })).map(row => decryptLegacy(decodeBase64(row.content.c), secret));
        expect(replies.some(content => JSON.stringify(content)?.includes(`${text}:done`) === true),
          `Persisted native transcript: ${JSON.stringify(replies)}`).toBe(true);
        return true;
      }, { timeoutMs: 45_000, context: 'J9 ordinary prompt reaches a persisted native reply' });
    }

    // The first prompt includes source CLI startup; later prompts measure an
    // already running Session.
    await ordinaryPrompt(`J9 seed native thread ${randomUUID()}`, true);
    socket = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    socket.connect();
    await waitFor(() => socket!.isConnected(), { context: 'J9 observer connects to the ready Session' });
    const readGoal = () => callLegacyEncryptedSessionRpc({ ui: socket!, sessionId,
      method: SESSION_RPC_METHODS.SESSION_GOAL_GET, req: {}, secret, schema: SessionWorkStateGetResponseV1Schema });
    const beforeGoal = 'J9 existing native Goal';
    expect(await setGoal(beforeGoal)).toMatchObject({ ok: true });

    refuseCleanup = true;
    const rejectedGoal = 'J9 replacement must not apply';
    const refused = await setGoal(rejectedGoal);
    expect(refused).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    const refusedState = (await readGoal()).workState?.items;
    expect(refusedState).toEqual(expect.arrayContaining([expect.objectContaining({ title: beforeGoal })]));
    expect(refusedState).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: rejectedGoal })]));

    // Leave the HTTP refusal armed: ordinary readiness must not depend on a
    // successful Goal-owner handoff or a Session restart (5be37fb713b).
    await ordinaryPrompt(`J9 ordinary work after refused Goal ${randomUUID()}`);
    refuseCleanup = false;
    const retriedGoal = 'J9 explicit retry succeeds';
    expect(await setGoal(retriedGoal)).toMatchObject({ ok: true });
    const retriedState = (await readGoal()).workState?.items;
    expect(retriedState).toEqual(expect.arrayContaining([expect.objectContaining({ title: retriedGoal })]));
    expect(retriedState).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: beforeGoal })]));
    await harness.stopRuntime();
    expect((await fetchSessionV2(serverBaseUrl, auth.token, sessionId)).id).toBe(sessionId);
  }, 240_000);
});
