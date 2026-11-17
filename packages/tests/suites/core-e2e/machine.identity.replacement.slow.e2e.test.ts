import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol';
import { connectUiActionClient } from '@happier-tests/ui-action-client';
import { resolveMachineIdForServerFromSettings } from '../../../../apps/cli/src/daemon/resolveMachineIdForServerFromSettings';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import type { Settings } from '../../../../apps/cli/src/persistence';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import {
  createMachineScopedSocketCollector,
  type SocketCollector,
} from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { startTeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startTestDaemon } from '../../src/testkit/daemon/daemon';
import { fetchJson } from '../../src/testkit/http';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
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

  // The composed fixture control uses lifecycle-owned phase budgets; this
  // journey likewise includes enrollment, daemon restart and an Agent turn.
  it('JOURNEYS-A.J7 keeps retained Session control working after real registration rotates a revoked Machine identity', async () => {
    const testDir = run.testDir('machine-replacement-retained-session-control');
    const postgres = await startDatabaseWorkbenchPostgres({ preloadStatistics: false });
    let fixture: Awaited<ReturnType<typeof startTeamSetupFFixture>> | undefined;
    let daemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
    let ui: Awaited<ReturnType<typeof connectUiActionClient>> | undefined;
    try {
      fixture = await startTeamSetupFFixture({ testDir, dbProvider: 'postgres',
        serverEnv: { DATABASE_URL: postgres.homeDatabaseUrl } });
      const account = await fixture.createAccount('rotation-owner');
      // Keep the actual Action client alive across registration, rather than
      // constructing an executor with the recovered identity afterwards.
      ui = await connectUiActionClient({ serverUrl: fixture.server.baseUrl, credentials: account.uiCredentials });
      await waitFor(() => ui!.isAccountReady(), { timeoutMs: 60_000, context: 'rotation Account ready' });
      const directory = join(testDir, account.name);
      const invocationId = randomUUID();
      const vendor = await createIsolatedFakeClaudeControlShim({ testDir: directory, invocationId,
        captureEnvironmentKeys: [], logFullStdin: true });
      const enrolled = await fixture.enrollDaemon(account, { env: { HAPPIER_CLAUDE_PATH: vendor.executablePath } });
      const { homeDir, workspaceDir } = enrolled;
      await writeFile(join(workspaceDir, 'rotation-sentinel.txt'), 'retained Session control');
      const assertSessionControl = async (machineId: string, phase: string) => {
        const control = await ui!.executeConfirmed('daemon.filesystem.listDirectory', { rootPath: workspaceDir, path: '.' }, {
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: ui!.serverId,
          externalActionTarget: { kind: 'machine', machineId },
        });
        expect(control, `${phase}: ${JSON.stringify(control)}`).toMatchObject({ ok: true, result: { success: true,
          entries: expect.arrayContaining([expect.objectContaining({ name: 'rotation-sentinel.txt' })]) } });
        const session = await fixture!.assertKnownGoodSessionControl(account, {
          target: { serverId: fixture!.serverId, machineId }, workspaceDir,
        });
        const message = `Machine rotation journey ${phase} ${invocationId}`;
        const sent = await account.execute('session.message.send', { sessionId: session.sessionId, message });
        expect(sent, `${phase}: ${JSON.stringify(sent)}`).toMatchObject({ ok: true });
        expect(await waitForFakeClaudeUserText(vendor.logPath, text => text.includes(message), { invocationId })).toContain(message);
      };
      await assertSessionControl(enrolled.target.machineId, 'before rotation');
      // Leave no incumbent before exercising revoked-identity startup recovery.
      await enrolled.daemon.stop();
      const paired = { serverId: enrolled.cliServerId, machineId: enrolled.target.machineId };
      const revoked = await fetchJson<unknown>(`${fixture.server.baseUrl}/v1/machines/${paired.machineId}/revoke`, {
        method: 'POST', headers: { Authorization: `Bearer ${account.auth.token}` },
      });
      expect(revoked.status).toBe(200);
      // With no incumbent, startDaemon creates Session control before its real
      // registration loop encounters machine_revoked and rotates the persisted id.
      daemon = await startTestDaemon({ testDir: directory, happyHomeDir: homeDir, requireMachineControlReady: true, env: {
        ...process.env, CI: '1', HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: fixture.server.baseUrl, HAPPIER_WEBAPP_URL: fixture.server.baseUrl,
        HAPPIER_CLAUDE_PATH: vendor.executablePath, HAPPIER_CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
        NODE_OPTIONS: fixture.sourceOptions,
      } });
      let machineId: string | null = null;
      await waitFor(async () => {
        const settings = JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf8')) as Settings;
        machineId = resolveMachineIdForServerFromSettings(settings, paired.serverId, readAccountIdFromToken(account.credentials.token));
        return machineId !== null && machineId !== paired.machineId && ui!.isMachineControlReady(machineId);
      }, { timeoutMs: 60_000, context: 'rotated Machine persisted and control published' });
      if (!machineId) throw new Error('Registration did not publish its recovered Machine identity');
      await assertSessionControl(machineId, 'after rotation');
    } finally {
      try { await ui?.close(); } finally {
        try { await daemon?.stop(); } finally {
          try { await fixture?.stop(); } finally { await postgres.stop(); }
        }
      }
    }
  }, 0);

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
