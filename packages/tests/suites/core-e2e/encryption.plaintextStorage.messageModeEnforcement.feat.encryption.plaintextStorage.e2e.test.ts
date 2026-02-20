import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: message mode enforcement', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('rejects plaintext writes into e2ee sessions and rejects ciphertext writes into plaintext sessions', async () => {
    const testDir = run.testDir('encryption-message-mode-enforcement');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
      },
    });

    const auth = await createTestAuth(server.baseUrl);

    const e2eeCreate = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-enforced-e2ee',
        encryptionMode: 'e2ee',
        metadata: Buffer.from('cipher-meta', 'utf8').toString('base64'),
        agentState: null,
        dataEncryptionKey: Buffer.from('test-data-key', 'utf8').toString('base64'),
      }),
      timeoutMs: 15_000,
    });
    expect(e2eeCreate.status).toBe(200);
    const e2eeSessionId = e2eeCreate.data?.session?.id;
    expect(typeof e2eeSessionId).toBe('string');
    expect(e2eeCreate.data?.session?.encryptionMode).toBe('e2ee');

    const ciphertext = Buffer.from('e2ee-msg', 'utf8').toString('base64');
    const e2eeOk = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${e2eeSessionId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ciphertext, localId: 'm-enforce-e2ee-1' }),
      timeoutMs: 15_000,
    });
    expect(e2eeOk.status).toBe(200);
    expect(e2eeOk.data?.didWrite).toBe(true);

    const e2eeRejectPlain = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${e2eeSessionId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        localId: 'm-enforce-e2ee-plain-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'should-fail' } } },
      }),
      timeoutMs: 15_000,
    });
    expect(e2eeRejectPlain.status).toBe(400);
    expect(e2eeRejectPlain.data?.error).toBe('Invalid parameters');

    const e2eeMessages = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${e2eeSessionId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(e2eeMessages.status).toBe(200);
    expect(e2eeMessages.data?.messages?.[0]?.content?.t).toBe('encrypted');

    const plainCreate = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-enforced-plain',
        encryptionMode: 'plain',
        metadata: JSON.stringify({ v: 1, tag: 'e2e-enforced-plain' }),
        agentState: null,
        dataEncryptionKey: null,
      }),
      timeoutMs: 15_000,
    });
    expect(plainCreate.status).toBe(200);
    const plainSessionId = plainCreate.data?.session?.id;
    expect(typeof plainSessionId).toBe('string');
    expect(plainCreate.data?.session?.encryptionMode).toBe('plain');

    const plainOk = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${plainSessionId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        localId: 'm-enforce-plain-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'plain-ok' } } },
      }),
      timeoutMs: 15_000,
    });
    expect(plainOk.status).toBe(200);
    expect(plainOk.data?.didWrite).toBe(true);

    const plainRejectCiphertext = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${plainSessionId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ciphertext: Buffer.from('nope', 'utf8').toString('base64'), localId: 'm-enforce-plain-ct-1' }),
      timeoutMs: 15_000,
    });
    expect(plainRejectCiphertext.status).toBe(400);
    expect(plainRejectCiphertext.data?.error).toBe('Invalid parameters');

    const plainMessages = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${plainSessionId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(plainMessages.status).toBe(200);
    const first = plainMessages.data?.messages?.[0];
    expect(first?.content?.t).toBe('plain');
    expect(first?.content?.v?.content?.text).toBe('plain-ok');
  }, 180_000);
});

