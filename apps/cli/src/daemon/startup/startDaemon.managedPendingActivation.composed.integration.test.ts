import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { SessionSpawnNewActionResultV1Schema, SessionSpawnNewInputV2Schema,
  projectSessionSpawnNewActionInputV2, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { MANAGED_FINITE_WAKE_RPC_METHOD, ManagedFiniteWakeRequestV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.composed.testkit';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { db } from '../../../../server/sources/storage/db';
import { forwardRpcCall } from '../../../../server/sources/app/api/socket/rpc/forwardRpcCall';

let captureDirectory: string;
let capturePath: string;
let fixture: Awaited<ReturnType<typeof startInstalledDaemonFixture>>;
let stopDaemon: (() => Promise<void>) | undefined;
let managedId = '';
let wakeCount = 0;
let resumeGuestNetwork: (() => Promise<void>) | undefined;

beforeAll(async () => {
  captureDirectory = await mkdtemp(join(tmpdir(), 'managed-pending-native-'));
  capturePath = join(captureDirectory, 'native-inputs.jsonl');
  // The SystemTool owner rejects runtime names. This copy is the fixture's
  // external native Agent, as in the managed accepted-input journey.
  const nativeAgent = join(captureDirectory, process.platform === 'win32' ? 'send-now-agent.exe' : 'send-now-agent');
  await cp(process.execPath, nativeAgent);
  const program = `const { appendFileSync } = require('node:fs');
    const open = JSON.parse(process.argv[1]);
    const inputIds = JSON.parse(process.argv[2]);
    const input = process.argv[3];
    appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ open, inputIds, input, pid: process.pid }) + '\\n');
    process.stdout.write('Native managed input completed.');`;
  // The external compute/socket boundary returns the resumed native guest.
  // Every ordinary Action reaches the actual installed daemon socket.
  fixture = await startInstalledDaemonFixture({
    registerCleanup: cleanup => { stopDaemon = cleanup; },
    plugins: [createFirstConversationAgentFixture('MANAGED_INPUT', {
      fixedDefaultPermission: true,
      nativeSession: { providerSessionId: 'managed-retained-native' },
      nativeReply: { executableNames: [nativeAgent], args: ['-e', program, '--'] },
    })],
    forwardRpc: async request => {
      if (!request.method.endsWith(`:${MANAGED_FINITE_WAKE_RPC_METHOD}`)) return await forwardRpcCall(request);
      const wake = ManagedFiniteWakeRequestV1Schema.parse(request.callParams);
      expect(wake.target.managedId).toBe(managedId);
      wakeCount += 1;
      await db.managedMachine.update({ where: { id: managedId }, data: {
        observation: { availability: 'present', power: 'running', storage: 'retained', observedAt: Date.now() },
      } });
      await resumeGuestNetwork?.();
      await fixture.home.waitForMachineRpc(wake.target.enrolledMachineId, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
        request.cancellation?.signal);
      return { ok: true, result: { ok: true, result: { kind: 'accepted', managedId,
        intentRevision: wake.target.expectedIntentRevision + 1 } } };
    },
  });
}, 120_000);

afterAll(async () => {
  try { await stopDaemon?.(); }
  finally { if (captureDirectory) await rm(captureDirectory, { recursive: true, force: true }); }
}, 120_000);

it('takes a stored-credential CLI Send-now through managed wake, real Pending and an installed retained Session conversation', async () => {
  const context = { surface: 'ui' as const, externalActionTarget: { kind: 'machine' as const, machineId: fixture.machineId,
    project: { machineId: fixture.machineId, directory: fixture.directory } } };
  const owner = fixture.createActionExecutor();
  const birth = await owner.execute('session.spawn_new', projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
    creationKey: randomUUID(), executionTarget: { serverId: fixture.serverId, machineId: fixture.machineId },
    directory: { kind: 'path', path: fixture.directory }, organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.project-launch', localId: 'agent' } },
    connectedServices: { v: 2, bindingsByServiceId: {} }, initialInput: { text: 'MANAGED_INPUT_FIRST' },
  })), context);
  expect(birth, JSON.stringify(birth)).toMatchObject({ ok: true });
  if (!birth.ok) throw new Error('Retained Session birth refused');
  const created = SessionSpawnNewActionResultV1Schema.parse(birth.result);
  if (created.type !== 'success') throw new Error('Retained Session did not start');
  const sessionId = created.sessionId;
  await vi.waitFor(async () => {
    expect((await fixture.home.readWorkflowSessionEffects()).turns.filter(turn => turn.sessionId === sessionId))
      .toMatchObject([{ status: 'completed' }]);
    expect(await readFile(capturePath, 'utf8')).toContain('MANAGED_INPUT_FIRST');
  }, { timeout: 30_000 });
  expect(await owner.execute('session.stop', { sessionId, stopIntent: 'lifecycle_control' }, context))
    .toMatchObject({ ok: true, result: { stopped: true } });
  await vi.waitFor(async () => expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } }))
    .toMatchObject({ active: false }));
  const controllerKeys = tweetnacl.sign.keyPair();
  const controller = await db.machine.create({ data: { id: randomUUID(), accountId: fixture.home.accountId,
    installationId: randomUUID(), installationPublicKey: controllerKeys.publicKey, active: true,
    dataEncryptionKey: Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
    metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
      homeDir: '/controller', happyHomeDir: '/controller/.happier' }) } });
  const managed = await db.managedMachine.create({ data: { homeId: fixture.home.homeId,
    custodianAccountId: fixture.home.accountId, controllerMachineId: controller.id,
    controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(), admittedInput: {},
    enrolledMachineId: fixture.machineId, allocation: 'bound', creationState: 'active', desired: 'stop', intentRevision: 1,
    launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Retained guest', choices: {} },
    resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'retained' } },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
    observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: Date.now() },
  } });
  managedId = managed.id;
  resumeGuestNetwork = await fixture.home.pauseInstalledMachineNetwork();
  onTestFinished(resumeGuestNetwork);
  await vi.waitFor(async () => expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } }))
    .toMatchObject({ active: false }));
  // The requester has its own local profile for the same Home, with no guest
  // control socket published on that profile.
  const cli = createCliActionExecutorFromCredentials({ credentials: {
    ...fixture.ownerCredentials, credentialProvenance: 'stored_session',
  }, externalActionClient: true, serverId: 'requester-profile',
    serverIdentityId: fixture.home.homeId, serverApiUrl: fixture.home.baseUrl,
    actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
  const localId = randomUUID();
  const sent = await runWithServerHttpBaseUrl(fixture.home.baseUrl, () => cli.execute('session.message.send', {
    sessionId, localId, message: 'MANAGED_INPUT_RESUMED', requestedAction: { v: 1, kind: 'send_now' }, reply: 'none',
  }, { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: fixture.machineId } }));
  expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, result: { status: 'accepted', localId } });
  expect(wakeCount).toBe(1);
  await vi.waitFor(async () => expect((await fixture.home.readWorkflowSessionEffects()).turns
    .filter(turn => turn.sessionId === sessionId)).toMatchObject([{ status: 'completed' }, { status: 'completed' }]),
  { timeout: 30_000 });
  const native = (await readFile(capturePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
    open: { kind: string; providerSessionId: string }; inputIds: string[]; input: string; pid: number;
  }).map(row => ({ ...row, input: row.input.split('\n').at(-1) }));
  expect(native).toMatchObject([
    { open: { kind: 'create', providerSessionId: 'managed-retained-native' }, input: 'MANAGED_INPUT_FIRST' },
    { open: { kind: 'resume', providerSessionId: 'managed-retained-native' }, input: 'MANAGED_INPUT_RESUMED', inputIds: [localId] },
  ]);
  expect(native.every(row => row.pid !== process.pid)).toBe(true);
  const effects = await fixture.home.readWorkflowSessionEffects();
  expect(effects.sessions).toMatchObject([{ id: sessionId, pendingCount: 0, pendingBlockedCount: 0 }]);
  expect(effects.pending).toEqual([]);
  expect(effects.turns.filter(turn => turn.sessionId === sessionId)).toHaveLength(2);
}, 120_000);
