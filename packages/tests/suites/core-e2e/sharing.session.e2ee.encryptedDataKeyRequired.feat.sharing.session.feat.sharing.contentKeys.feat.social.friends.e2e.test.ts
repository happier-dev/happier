import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { addFriend, fetchAccountId, setUsername } from '../../src/testkit/socialFriends';

const run = createRunDirs({ runLabel: 'core' });

function makeEncryptedDataKeyV0Base64(): string {
  const bytes = Buffer.alloc(1 + 32 + 24 + 16, 1);
  bytes[0] = 0;
  return bytes.toString('base64');
}

describe('core e2e: e2ee direct share requires encryptedDataKey', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('rejects missing/invalid encryptedDataKey for e2ee sessions and accepts a valid v0 envelope', async () => {
    const testDir = run.testDir('sharing-session-e2ee-encrypted-datakey-required');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '1',
      },
    });

    const owner = await createTestAuth(server.baseUrl);
    const recipient = await createTestAuth(server.baseUrl);

    const ownerId = await fetchAccountId(server.baseUrl, owner.token);
    const recipientId = await fetchAccountId(server.baseUrl, recipient.token);

    await setUsername(server.baseUrl, owner.token, 'owner_e2ee_share');
    await setUsername(server.baseUrl, recipient.token, 'recipient_e2ee_share');
    await addFriend(server.baseUrl, owner.token, recipientId);
    await addFriend(server.baseUrl, recipient.token, ownerId);

    const create = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-share-e2ee',
        encryptionMode: 'e2ee',
        metadata: Buffer.from('cipher-meta', 'utf8').toString('base64'),
        agentState: null,
        dataEncryptionKey: Buffer.from('test-data-key', 'utf8').toString('base64'),
      }),
      timeoutMs: 15_000,
    });
    expect(create.status).toBe(200);
    const sessionId = create.data?.session?.id;
    expect(typeof sessionId).toBe('string');
    expect(create.data?.session?.encryptionMode).toBe('e2ee');

    const missing = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/shares`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: recipientId, accessLevel: 'view' }),
      timeoutMs: 15_000,
    });
    expect(missing.status).toBe(400);
    expect(missing.data?.error).toBe('encryptedDataKey required');

    const invalid = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/shares`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: recipientId, accessLevel: 'view', encryptedDataKey: Buffer.from('x').toString('base64') }),
      timeoutMs: 15_000,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.data?.error).toBe('Invalid encryptedDataKey');

    const ok = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/shares`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: recipientId,
        accessLevel: 'view',
        encryptedDataKey: makeEncryptedDataKeyV0Base64(),
      }),
      timeoutMs: 15_000,
    });
    expect(ok.status).toBe(200);
    expect(typeof ok.data?.share?.id).toBe('string');
  }, 180_000);
});

