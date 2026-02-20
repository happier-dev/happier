import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { addFriend, fetchAccountId, setUsername } from '../../src/testkit/socialFriends';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: plaintext direct share roundtrip', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('shares plaintext sessions without encryptedDataKey and recipient can read plain messages', async () => {
    const testDir = run.testDir('encryption-plaintext-direct-share-roundtrip');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '1',
      },
    });

    const owner = await createTestAuth(server.baseUrl);
    const recipient = await createTestAuth(server.baseUrl);

    const ownerId = await fetchAccountId(server.baseUrl, owner.token);
    const recipientId = await fetchAccountId(server.baseUrl, recipient.token);

    await setUsername(server.baseUrl, owner.token, 'owner_plain_share');
    await setUsername(server.baseUrl, recipient.token, 'recipient_plain_share');

    // Establish friendship (request + accept).
    await addFriend(server.baseUrl, owner.token, recipientId);
    await addFriend(server.baseUrl, recipient.token, ownerId);

    const patchMode = await fetchJson<any>(`${server.baseUrl}/v1/account/encryption`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${owner.token}`,
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
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-plaintext-direct-share',
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

    const localId = 'm-local-share-plain-1';
    const commit = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': localId,
      },
      body: JSON.stringify({
        localId,
        content: {
          t: 'plain',
          v: { role: 'user', content: { type: 'text', text: 'hello direct share' } },
        },
      }),
      timeoutMs: 15_000,
    });
    expect(commit.status).toBe(200);
    expect(commit.data?.didWrite).toBe(true);

    const share = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/shares`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: recipientId,
        accessLevel: 'view',
      }),
      timeoutMs: 15_000,
    });
    expect(share.status).toBe(200);
    expect(typeof share.data?.share?.id).toBe('string');

    const messages = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${recipient.token}` },
      timeoutMs: 15_000,
    });
    expect(messages.status).toBe(200);
    expect(Array.isArray(messages.data?.messages)).toBe(true);
    const anyPlain = (messages.data?.messages ?? []).some((row: any) => row?.content?.t === 'plain' && row?.content?.v?.content?.text === 'hello direct share');
    expect(anyPlain).toBe(true);
  }, 180_000);
});
