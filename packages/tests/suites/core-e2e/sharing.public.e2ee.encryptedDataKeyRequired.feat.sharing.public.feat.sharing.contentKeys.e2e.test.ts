import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

function makeEncryptedDataKeyV0Base64(): string {
  const bytes = Buffer.alloc(1 + 32 + 24 + 16, 1);
  bytes[0] = 0;
  return bytes.toString('base64');
}

describe('core e2e: e2ee public share requires encryptedDataKey', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('rejects missing encryptedDataKey for e2ee public shares and returns encryptedDataKey for valid shares', async () => {
    const testDir = run.testDir('sharing-public-e2ee-encrypted-datakey-required');
    server = await startServerLight({ testDir });

    const auth = await createTestAuth(server.baseUrl);

    const create = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-public-share-e2ee',
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

    const token = 'tok_e2ee_share_1';
    const missing = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/public-share`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, isConsentRequired: false }),
      timeoutMs: 15_000,
    });
    expect(missing.status).toBe(400);
    expect(typeof missing.data?.error).toBe('string');

    const createShare = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/public-share`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, encryptedDataKey: makeEncryptedDataKeyV0Base64(), isConsentRequired: false }),
      timeoutMs: 15_000,
    });
    expect(createShare.status).toBe(200);
    expect(createShare.data?.publicShare?.token).toBe(token);

    const access = await fetchJson<any>(`${server.baseUrl}/v1/public-share/${encodeURIComponent(token)}`, {
      timeoutMs: 15_000,
    });
    expect(access.status).toBe(200);
    expect(access.data?.session?.id).toBe(sessionId);
    expect(access.data?.session?.encryptionMode).toBe('e2ee');
    expect(typeof access.data?.encryptedDataKey).toBe('string');
  }, 180_000);
});

