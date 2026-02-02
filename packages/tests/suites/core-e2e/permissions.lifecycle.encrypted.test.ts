import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession, fetchSessionV2 } from '../../src/testkit/sessions';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifest } from '../../src/testkit/manifest';
import { waitFor } from '../../src/testkit/timing';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { decryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';
import { createDataKeyRpcClient } from '../../src/testkit/syntheticAgent/rpcClient';
import { SyntheticAgent } from '../../src/testkit/syntheticAgent/syntheticAgent';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: permission lifecycle (encrypted rpc + agentState) + reconnect', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('agent publishes requests; UI approves via encrypted RPC; offline device sees completedRequests after reconnect', async () => {
    const testDir = run.testDir('permission-lifecycle-encrypted');
    const saveArtifactsOnSuccess = envFlag('HAPPY_E2E_SAVE_ARTIFACTS', false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const dataKey = Uint8Array.from(randomBytes(32));
    const dataKeyBase64 = Buffer.from(dataKey).toString('base64');

    const { sessionId } = await createSession(server.baseUrl, auth.token, { dataEncryptionKeyBase64: dataKeyBase64 });

    const deviceA = createUserScopedSocketCollector(server.baseUrl, auth.token);
    const deviceB = createUserScopedSocketCollector(server.baseUrl, auth.token);

    const agent = new SyntheticAgent({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      dataKey,
    });

    writeTestManifest(testDir, {
      startedAt,
      runId: run.runId,
      testName: 'permission-lifecycle-encrypted',
      baseUrl: server.baseUrl,
      ports: { server: server.port },
      sessionIds: [sessionId],
      env: {
        CI: process.env.CI,
        HAPPY_E2E_SAVE_ARTIFACTS: process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();
    artifacts.json('deviceA.events.json', () => deviceA.getEvents());
    artifacts.json('deviceB.events.json', () => deviceB.getEvents());
    artifacts.json('agent.events.json', () => agent.getEvents());
    artifacts.json('session.v2.json', async () => await fetchSessionV2(server!.baseUrl, auth.token, sessionId));

    let passed = false;
    try {
      deviceA.connect();
      deviceB.connect();
      await agent.start();
      await waitFor(() => deviceA.isConnected() && deviceB.isConnected(), { timeoutMs: 20_000 });

      // Device B goes offline (simulates backgrounded app / network loss).
      deviceB.disconnect();
      await waitFor(() => !deviceB.isConnected(), { timeoutMs: 10_000 });

      // Agent publishes a permission request in encrypted agentState.
      const permissionId = 'perm-1';
      await agent.publishPermissionRequest({
        id: permissionId,
        tool: 'Bash',
        args: { command: 'echo hello' },
      });

      // UI approves via encrypted session RPC routed over user-scoped socket.
      const uiRpc = createDataKeyRpcClient(deviceA, dataKey);
      const rpcRes = await uiRpc.call(`${sessionId}:permission`, { id: permissionId, approved: true });
      expect(rpcRes.ok).toBe(true);

      // Agent should move request -> completedRequests.
      await agent.waitForCompletedPermission(permissionId, { timeoutMs: 15_000 });

      // Device B reconnects and observes completedRequests via snapshot fetch.
      deviceB.connect();
      await waitFor(() => deviceB.isConnected(), { timeoutMs: 20_000 });

      const session = await fetchSessionV2(server.baseUrl, auth.token, sessionId);
      const agentState = session.agentState ? decryptDataKeyBase64(session.agentState, dataKey) : null;
      expect(agentState).not.toBeNull();

      const requests = (agentState as any).requests ?? {};
      const completed = (agentState as any).completedRequests ?? {};
      expect(requests[permissionId]).toBeUndefined();
      expect(completed[permissionId]?.status).toBe('approved');

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
      deviceA.close();
      deviceB.close();
      await agent.stop();
    }
  });
});

