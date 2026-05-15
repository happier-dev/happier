import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: session message role query', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('advertises role query capability and filters transcript messages by messageRole', async () => {
    const testDir = run.testDir('messages-http-role-query');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const features = await fetchJson<any>(`${server.baseUrl}/v1/features`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(features.status).toBe(200);
    expect(features.data?.capabilities?.session?.messages?.role).toBe(true);

    const postMessage = async (localId: string, messageRole: 'user' | 'agent', value: string) => {
      return await fetchJson<any>(`${server!.baseUrl}/v2/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          localId,
          messageRole,
          ciphertext: Buffer.from(value, 'utf8').toString('base64'),
        }),
        timeoutMs: 15_000,
      });
    };

    const userWrite = await postMessage('role-user-1', 'user', 'user-cipher');
    expect(userWrite.status).toBe(200);
    expect(userWrite.data?.didWrite).toBe(true);

    const agentWrite = await postMessage('role-agent-1', 'agent', 'agent-cipher');
    expect(agentWrite.status).toBe(200);
    expect(agentWrite.data?.didWrite).toBe(true);

    const userMessages = await fetchJson<any>(
      `${server.baseUrl}/v1/sessions/${sessionId}/messages?scope=main&role=user&limit=25`,
      {
        headers: { Authorization: `Bearer ${auth.token}` },
        timeoutMs: 15_000,
      },
    );
    expect(userMessages.status).toBe(200);
    expect(userMessages.data?.messages).toHaveLength(1);
    expect(userMessages.data?.messages?.[0]?.localId).toBe('role-user-1');
    expect(userMessages.data?.messages?.[0]?.messageRole).toBe('user');

    const agentMessages = await fetchJson<any>(
      `${server.baseUrl}/v1/sessions/${sessionId}/messages?scope=main&role=agent&limit=25`,
      {
        headers: { Authorization: `Bearer ${auth.token}` },
        timeoutMs: 15_000,
      },
    );
    expect(agentMessages.status).toBe(200);
    expect(agentMessages.data?.messages).toHaveLength(1);
    expect(agentMessages.data?.messages?.[0]?.localId).toBe('role-agent-1');
    expect(agentMessages.data?.messages?.[0]?.messageRole).toBe('agent');
  }, 180_000);
});
