import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import {
  createMachineScopedSocketCollector,
  type SocketCollector,
} from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import {
  createMachineInstallationIdentityFixture,
  fetchMachineIdentity,
  registerMachineIdentity,
  replaceMachineManually,
  undoMachineReplacement,
} from '../../src/testkit/machineIdentity';

const run = createRunDirs({ runLabel: 'core' });
const contentKeyspaceA = computeContentPublicKeyFingerprint(new Uint8Array([1, 2, 3, 4]));
const contentKeyspaceB = computeContentPublicKeyFingerprint(new Uint8Array([4, 3, 2, 1]));

async function connectMachineSocket(params: Readonly<{
  baseUrl: string;
  token: string;
  machineId: string;
}>): Promise<SocketCollector> {
  const socket = createMachineScopedSocketCollector(params.baseUrl, params.token, params.machineId);
  socket.connect();
  await waitFor(() => socket.isConnected(), {
    timeoutMs: 20_000,
    context: `machine ${params.machineId} socket connected for manual replacement`,
  });
  return socket;
}

async function expectReplacementState(params: Readonly<{
  baseUrl: string;
  token: string;
  oldMachineId: string;
  replacementMachineId: string;
  source: 'automatic' | 'manual';
}>): Promise<void> {
  const oldMachine = await fetchMachineIdentity({
    baseUrl: params.baseUrl,
    token: params.token,
    machineId: params.oldMachineId,
  });
  expect(oldMachine.replacedByMachineId).toBe(params.replacementMachineId);
  expect(oldMachine.replacementSource).toBe(params.source);
  expect(typeof oldMachine.replacedAt).toBe('number');
  expect(oldMachine.active).toBe(false);
}

describe('core e2e: machine installation identity replacement', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('records automatic replacement only when registration includes explicit replacement proof', async () => {
    server = await startServerLight({ testDir: run.testDir('machine-replacement-automatic') });
    const auth = await createTestAuth(server.baseUrl);
    const installation = createMachineInstallationIdentityFixture();
    const oldMachineId = randomUUID();
    const newMachineId = randomUUID();
    const keyspace = contentKeyspaceA;

    const oldRegistration = await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId: oldMachineId,
      installation,
      contentPublicKeyFingerprint: keyspace,
    });
    expect(oldRegistration.status).toBe(200);

    const replacementRegistration = await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId: newMachineId,
      installation,
      replacesMachineId: oldMachineId,
      replacementReason: 'reauth',
      contentPublicKeyFingerprint: keyspace,
    });
    expect(replacementRegistration.status).toBe(200);

    await expectReplacementState({
      baseUrl: server.baseUrl,
      token: auth.token,
      oldMachineId,
      replacementMachineId: newMachineId,
      source: 'automatic',
    });
    const newMachine = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: newMachineId });
    expect(newMachine.installationId).toBe(installation.installationId);
    expect(newMachine.contentPublicKeyFingerprint).toBe(keyspace);
  });

  it('does not replace machines from installation id alone', async () => {
    server = await startServerLight({ testDir: run.testDir('machine-replacement-no-implicit-installation') });
    const auth = await createTestAuth(server.baseUrl);
    const installation = createMachineInstallationIdentityFixture();
    const firstMachineId = randomUUID();
    const secondMachineId = randomUUID();

    const firstRegistration = await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId: firstMachineId,
      installation,
      contentPublicKeyFingerprint: contentKeyspaceA,
    });
    expect(firstRegistration.status).toBe(200);
    const secondRegistration = await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId: secondMachineId,
      installation,
      contentPublicKeyFingerprint: contentKeyspaceA,
    });
    expect(secondRegistration.status).toBe(200);

    const firstMachine = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: firstMachineId });
    const secondMachine = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: secondMachineId });
    expect(firstMachine.installationId).toBe(installation.installationId);
    expect(secondMachine.installationId).toBe(installation.installationId);
    expect(firstMachine.replacedByMachineId ?? null).toBeNull();
    expect(secondMachine.replacedByMachineId ?? null).toBeNull();
  });

  it('blocks automatic replacement when the content keyspace does not match', async () => {
    server = await startServerLight({ testDir: run.testDir('machine-replacement-keyspace-mismatch') });
    const auth = await createTestAuth(server.baseUrl);
    const installation = createMachineInstallationIdentityFixture();
    const oldMachineId = randomUUID();
    const newMachineId = randomUUID();

    const oldRegistration = await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId: oldMachineId,
      installation,
      contentPublicKeyFingerprint: contentKeyspaceA,
    });
    expect(oldRegistration.status).toBe(200);
    const replacementRegistration = await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId: newMachineId,
      installation,
      replacesMachineId: oldMachineId,
      replacementReason: 'reauth',
      contentPublicKeyFingerprint: contentKeyspaceB,
    });

    expect([200, 400, 409, 422]).toContain(replacementRegistration.status);
    const oldMachine = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: oldMachineId });
    expect(oldMachine.replacedByMachineId ?? null).toBeNull();
  });

  it('allows audited manual replacement and undo for legacy machines', async () => {
    server = await startServerLight({ testDir: run.testDir('machine-replacement-manual-undo') });
    const auth = await createTestAuth(server.baseUrl);
    const legacyMachineId = randomUUID();
    const currentMachineId = randomUUID();
    const installation = createMachineInstallationIdentityFixture();
    let currentMachineSocket: SocketCollector | null = null;

    try {
      const legacyRegistration = await registerMachineIdentity({
        baseUrl: server.baseUrl,
        token: auth.token,
        machineId: legacyMachineId,
      });
      expect(legacyRegistration.status).toBe(200);
      const currentRegistration = await registerMachineIdentity({
        baseUrl: server.baseUrl,
        token: auth.token,
        machineId: currentMachineId,
        installation,
        contentPublicKeyFingerprint: contentKeyspaceA,
      });
      expect(currentRegistration.status).toBe(200);
      currentMachineSocket = await connectMachineSocket({
        baseUrl: server.baseUrl,
        token: auth.token,
        machineId: currentMachineId,
      });

      const replacement = await replaceMachineManually({
        baseUrl: server.baseUrl,
        token: auth.token,
        oldMachineId: legacyMachineId,
        replacementMachineId: currentMachineId,
        reason: 'user-confirmed-same-installation',
      });
      expect(replacement.status).toBe(200);
      await expectReplacementState({
        baseUrl: server.baseUrl,
        token: auth.token,
        oldMachineId: legacyMachineId,
        replacementMachineId: currentMachineId,
        source: 'manual',
      });
      const replaced = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: legacyMachineId });
      expect(typeof replaced.replacementActorUserId).toBe('string');

      const undo = await undoMachineReplacement({
        baseUrl: server.baseUrl,
        token: auth.token,
        oldMachineId: legacyMachineId,
      });
      expect(undo.status).toBe(200);
      const restored = await fetchMachineIdentity({ baseUrl: server.baseUrl, token: auth.token, machineId: legacyMachineId });
      expect(restored.replacedByMachineId ?? null).toBeNull();
      expect(restored.replacementSource ?? null).toBeNull();
    } finally {
      currentMachineSocket?.close();
    }
  });
});
