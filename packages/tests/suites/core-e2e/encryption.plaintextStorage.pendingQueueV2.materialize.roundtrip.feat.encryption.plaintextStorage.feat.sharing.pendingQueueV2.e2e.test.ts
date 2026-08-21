import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: plaintext pending queue v2 materialize-next', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('enqueues and materializes plaintext pending items into plaintext transcript messages', async () => {
    const testDir = run.testDir('encryption-plaintext-pending-queue-v2-materialize');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
      },
    });

    const auth = await createTestAuth(server.baseUrl);

    const patchMode = await fetchJson<any>(`${server.baseUrl}/v1/account/encryption`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'plain' }),
      timeoutMs: 15_000,
    });
    expect(patchMode.status).toBe(200);
    expect(patchMode.data?.mode).toBe('plain');

    const create = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-plaintext-pending',
        encryptionMode: 'plain',
        metadata: JSON.stringify({ v: 1, path: '/tmp', flavor: 'claude' }),
        agentState: null,
        dataEncryptionKey: null,
      }),
      timeoutMs: 15_000,
    });
    expect(create.status).toBe(200);
    const sessionId = create.data?.session?.id;
    expect(typeof sessionId).toBe('string');
    expect(create.data?.session?.encryptionMode).toBe('plain');

    const { socket } = await createMachineBoundSessionScopedSocketCollector({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
    });
    socket.connect();
    await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });
    socket.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: false });
    await waitFor(
      async () => (await fetchSessionV2(server!.baseUrl, auth.token, sessionId)).active === true,
      { timeoutMs: 20_000, context: 'machine-bound plaintext pending publisher registration' },
    );

    const localId = 'pending-local-plain-1';
    const enqueue = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/pending`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
        body: JSON.stringify({
          localId,
          messageRole: 'user',
          content: {
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text: 'hello pending plain' } },
          },
      }),
      timeoutMs: 15_000,
    });
    expect(enqueue.status).toBe(200);
    expect(enqueue.data?.didWrite).toBe(true);
    expect(enqueue.data?.pending?.localId).toBe(localId);
    expect(enqueue.data?.pending?.messageRole).toBe('user');
    expect(enqueue.data?.pending?.content?.t).toBe('plain');

    const list1 = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/pending`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(list1.status).toBe(200);
    expect(list1.data?.pending?.[0]?.localId).toBe(localId);
    expect(list1.data?.pending?.[0]?.content?.t).toBe('plain');
    expect(list1.data?.pending?.[0]?.content?.v?.content?.text).toBe('hello pending plain');

    const materialize = await socket.emitWithAck<any>('pending-materialize-next', {
      sid: sessionId,
      deliveryState: 'provider',
      deliveryTiming: 'after_foreground_ready',
      foregroundState: 'ready',
    }, 20_000);
    expect(materialize?.ok).toBe(true);
    expect(materialize?.didMaterialize).toBe(true);
    expect(materialize?.didWrite).toBe(false);
    expect(materialize?.message?.localId).toBe(localId);
    expect(materialize?.message?.messageRole).toBe('user');
    expect(materialize?.deliveryState).toEqual({ mode: 'provider', unresolved: true });

    const accepted = await socket.emitWithAck<any>('pending-delivery-accepted-v1', {
      v: 1,
      sessionId,
      localId,
    }, 20_000);
    expect(accepted).toMatchObject({ ok: true, didResolve: true });

    const list2 = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/pending`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(list2.status).toBe(200);
    expect(list2.data?.pending?.length ?? 0).toBe(0);

    const messages = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(messages.status).toBe(200);
    const first = messages.data?.messages?.[0];
    expect(first?.localId).toBe(localId);
    expect(first?.messageRole).toBe('user');
    expect(first?.content?.t).toBe('plain');
    expect(first?.content?.v?.content?.text).toBe('hello pending plain');

    const userMessages = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/messages?role=user&limit=10`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(userMessages.status).toBe(200);
    expect(userMessages.data?.messages?.[0]?.localId).toBe(localId);
    socket.close();
  }, 180_000);
});
