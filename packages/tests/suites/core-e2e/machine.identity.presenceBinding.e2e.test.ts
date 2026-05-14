import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSession } from '../../src/testkit/sessions';
import {
  createMachineScopedSocketCollector,
  createSessionScopedSocketCollector,
  createUserScopedSocketCollector,
  type SocketCollector,
} from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { fetchMachineIdentity, registerMachineIdentity } from '../../src/testkit/machineIdentity';

const run = createRunDirs({ runLabel: 'core' });

async function waitForSocket(socket: SocketCollector, context: string): Promise<void> {
  socket.connect();
  await waitFor(() => socket.isConnected(), { timeoutMs: 20_000, context });
}

async function assertMachinePresenceUnchanged(params: Readonly<{
  baseUrl: string;
  token: string;
  machineId: string;
  before: Readonly<{ active?: boolean; activeAt?: number | null }>;
}>): Promise<void> {
  const machine = await fetchMachineIdentity(params);
  expect(machine.active).toBe(params.before.active);
  expect(machine.activeAt ?? null).toBe(params.before.activeAt ?? null);
}

describe('core e2e: machine presence is bound to socket identity', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('rejects machine-alive payloads for a different machine id', async () => {
    server = await startServerLight({ testDir: run.testDir('machine-presence-cross-machine') });
    const auth = await createTestAuth(server.baseUrl);
    const machineAId = randomUUID();
    const machineBId = randomUUID();

    await registerMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: machineAId });
    await registerMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: machineBId });
    const machineBBefore = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: machineBId });

    const machineASocket = createMachineScopedSocketCollector(server.baseUrl, auth.token, machineAId);
    try {
      await waitForSocket(machineASocket, 'machine A socket connected');

      machineASocket.emit('machine-alive', {
        machineId: machineBId,
        time: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      await assertMachinePresenceUnchanged({
        baseUrl: server.baseUrl,
        token: auth.token,
        machineId: machineBId,
        before: machineBBefore,
      });
    } finally {
      machineASocket.close();
    }
  });

  it('rejects machine metadata updates for a different machine id', async () => {
    server = await startServerLight({ testDir: run.testDir('machine-update-metadata-cross-machine') });
    const auth = await createTestAuth(server.baseUrl);
    const machineAId = randomUUID();
    const machineBId = randomUUID();
    const originalMetadata = `metadata-b:${randomUUID()}`;

    await registerMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: machineAId });
    await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId: machineBId,
      metadata: originalMetadata,
    });

    const machineASocket = createMachineScopedSocketCollector(server.baseUrl, auth.token, machineAId);
    try {
      await waitForSocket(machineASocket, 'machine A socket connected for metadata update');
      const before = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: machineBId });

      const ack = await machineASocket.emitWithAck<{ result?: unknown }>('machine-update-metadata', {
        machineId: machineBId,
        expectedVersion: before.metadataVersion ?? 0,
        metadata: `cross-machine-metadata:${randomUUID()}`,
      });

      expect(ack.result).not.toBe('success');
      const after = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: machineBId });
      expect(after.metadata).toBe(originalMetadata);
      expect(after.metadataVersion ?? 0).toBe(before.metadataVersion ?? 0);
    } finally {
      machineASocket.close();
    }
  });

  it('rejects machine daemon-state updates for a different machine id', async () => {
    server = await startServerLight({ testDir: run.testDir('machine-update-state-cross-machine') });
    const auth = await createTestAuth(server.baseUrl);
    const machineAId = randomUUID();
    const machineBId = randomUUID();
    const originalDaemonState = `daemon-state-b:${randomUUID()}`;

    await registerMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: machineAId });
    await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId: machineBId,
      daemonState: originalDaemonState,
    });

    const machineASocket = createMachineScopedSocketCollector(server.baseUrl, auth.token, machineAId);
    try {
      await waitForSocket(machineASocket, 'machine A socket connected for daemon-state update');
      const before = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: machineBId });

      const ack = await machineASocket.emitWithAck<{ result?: unknown }>('machine-update-state', {
        machineId: machineBId,
        expectedVersion: before.daemonStateVersion ?? 0,
        daemonState: `cross-machine-daemon-state:${randomUUID()}`,
      });

      expect(ack.result).not.toBe('success');
      const after = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: machineBId });
      expect(after.daemonState).toBe(originalDaemonState);
      expect(after.daemonStateVersion ?? 0).toBe(before.daemonStateVersion ?? 0);
    } finally {
      machineASocket.close();
    }
  });

  it('ignores machine-alive payloads from user-scoped sockets', async () => {
    server = await startServerLight({ testDir: run.testDir('machine-presence-user-socket') });
    const auth = await createTestAuth(server.baseUrl);
    const machineId = randomUUID();

    await registerMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId });
    const machineBefore = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId });

    const userSocket = createUserScopedSocketCollector(server.baseUrl, auth.token);
    try {
      await waitForSocket(userSocket, 'user socket connected');

      userSocket.emit('machine-alive', {
        machineId,
        time: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      await assertMachinePresenceUnchanged({
        baseUrl: server.baseUrl,
        token: auth.token,
        machineId,
        before: machineBefore,
      });
    } finally {
      userSocket.close();
    }
  });

  it('ignores machine-alive payloads from session-scoped sockets', async () => {
    server = await startServerLight({ testDir: run.testDir('machine-presence-session-socket') });
    const auth = await createTestAuth(server.baseUrl);
    const { sessionId } = await createSession(server.baseUrl, auth.token);
    const machineId = randomUUID();

    await registerMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId });
    const machineBefore = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId });

    const sessionSocket = createSessionScopedSocketCollector(server.baseUrl, auth.token, sessionId);
    try {
      await waitForSocket(sessionSocket, 'session socket connected');

      sessionSocket.emit('machine-alive', {
        machineId,
        time: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      await assertMachinePresenceUnchanged({
        baseUrl: server.baseUrl,
        token: auth.token,
        machineId,
        before: machineBefore,
      });
    } finally {
      sessionSocket.close();
    }
  });
});
