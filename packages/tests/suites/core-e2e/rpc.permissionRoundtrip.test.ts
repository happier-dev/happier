import { afterAll, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';
import { createSessionScopedSocketCollector, createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: rpc permission round-trip + reconnect', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('routes rpc-call to a different socket; fails closed while agent disconnected; works again after reconnect', async () => {
    const testDir = run.testDir('rpc-permission-roundtrip');
    const saveArtifactsOnSuccess = envFlag('HAPPY_E2E_SAVE_ARTIFACTS', false);
    const startedAt = new Date().toISOString();
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);

    const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const agent = createSessionScopedSocketCollector(server.baseUrl, auth.token, sessionId);

    const artifacts = new FailureArtifacts();
    artifacts.json('ui.events.json', () => ui.getEvents());
    artifacts.json('agent.events.json', () => agent.getEvents());
    const payloads: Array<{ method: string; params: string }> = [];
    artifacts.json('agent.rpc.payloads.json', () => payloads);

    let passed = false;
    writeTestManifest(testDir, {
      startedAt,
      runId: run.runId,
      testName: 'rpc-permission-roundtrip',
      baseUrl: server.baseUrl,
      ports: { server: server.port },
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPY_E2E_SAVE_ARTIFACTS: process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    ui.connect();
    agent.connect();
    await waitFor(() => ui.isConnected() && agent.isConnected(), { timeoutMs: 20_000 });

    const method = `${sessionId}:permission`;
    agent.onRpcRequest(async (data) => {
      payloads.push(data);
      return JSON.stringify({ ok: true, echoed: data.params });
    });

    await agent.rpcRegister(method);

    const res1 = await ui.rpcCall<{ ok: boolean; result?: string }>(method, JSON.stringify({ id: 'p1', approved: true }));
    expect(res1.ok).toBe(true);
    expect(typeof res1.result).toBe('string');
    const parsed1 = JSON.parse(res1.result!);
    expect(parsed1.ok).toBe(true);

    // Disconnect agent: method should become unavailable.
    agent.disconnect();
    await waitFor(() => !agent.isConnected(), { timeoutMs: 10_000 });

    const res2 = await ui.rpcCall<{ ok: boolean; errorCode?: string }>(method, JSON.stringify({ id: 'p2', approved: true }));
    expect(res2.ok).toBe(false);

    // Reconnect + re-register: method works again.
    agent.connect();
    await waitFor(() => agent.isConnected(), { timeoutMs: 20_000 });
    await agent.rpcRegister(method);

    const res3 = await ui.rpcCall<{ ok: boolean; result?: string }>(method, JSON.stringify({ id: 'p3', approved: true }));
    expect(res3.ok).toBe(true);

    try {
      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      ui.close();
      agent.close();
    }
  });
});
