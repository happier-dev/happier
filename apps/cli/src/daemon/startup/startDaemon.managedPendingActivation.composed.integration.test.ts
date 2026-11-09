import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import { SessionSpawnNewActionResultV1Schema, SessionSpawnNewInputV2Schema,
  projectSessionSpawnNewActionInputV2, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { MANAGED_FINITE_WAKE_RPC_METHOD, ManagedFiniteWakeRequestV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.testkit';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { stopDaemonSession } from '@/daemon/controlClient';
import { db } from '../../../../server/sources/storage/db';
import { forwardRpcCall } from '../../../../server/sources/app/api/socket/rpc/forwardRpcCall';

it('takes a stored-credential CLI Send-now through managed wake, real Pending and an installed retained Session conversation', async () => {
  const captureDirectory = await mkdtemp(join(tmpdir(), 'managed-pending-native-'));
  onTestFinished(() => rm(captureDirectory, { recursive: true, force: true }));
  const capturePath = join(captureDirectory, 'native-inputs.jsonl');
  const program = `const { appendFileSync } = require('node:fs');
    const open = JSON.parse(process.argv[1]);
    const inputIds = JSON.parse(process.argv[2]);
    const input = process.argv[3];
    appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ open, inputIds, input, pid: process.pid }) + '\\n');
    process.stdout.write('Native managed input completed.');`;
  let managedId = '';
  let wakeCount = 0;
  // The external compute/socket boundary returns the resumed native guest.
  // Every ordinary Action reaches the actual installed daemon socket.
  const fixture = await startInstalledDaemonFixture({
    plugins: [createFirstConversationAgentFixture('MANAGED_INPUT', {
    nativeSession: { providerSessionId: 'managed-retained-native' },
    nativeReply: { executableNames: ['node'], args: ['-e', program, '--'] },
  })], forwardRpc: async request => {
    if (!request.method.endsWith(`:${MANAGED_FINITE_WAKE_RPC_METHOD}`)) return await forwardRpcCall(request);
    const wake = ManagedFiniteWakeRequestV1Schema.parse(request.callParams);
    expect(wake.target.managedId).toBe(managedId);
    wakeCount += 1;
    await db.managedMachine.update({ where: { id: managedId }, data: {
      observation: { availability: 'present', power: 'running', storage: 'retained', observedAt: Date.now() },
    } });
    await db.machine.update({ where: { id: wake.target.enrolledMachineId }, data: { active: true, lastActiveAt: new Date() } });
    return { ok: true, result: { ok: true, result: { kind: 'accepted', managedId,
      intentRevision: wake.target.expectedIntentRevision + 1 } } };
  } });
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
  expect(await owner.execute('session.wait.idle', { sessionId }, context)).toMatchObject({ ok: true });
  expect(await stopDaemonSession(sessionId)).toMatchObject({ status: 'stopped' });
  await vi.waitFor(async () => expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } }))
    .toMatchObject({ active: false }));
  const controllerKeys = tweetnacl.sign.keyPair();
  const controller = await db.machine.create({ data: { id: randomUUID(), accountId: fixture.home.accountId,
    installationId: randomUUID(), installationPublicKey: controllerKeys.publicKey, active: true,
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
  await db.machine.update({ where: { id: fixture.machineId }, data: { active: false } });
  const cli = createCliActionExecutorFromCredentials({ credentials: {
    ...fixture.ownerCredentials, credentialProvenance: 'stored_session',
  }, externalActionClient: true, serverId: fixture.serverId,
    serverIdentityId: fixture.home.homeId, serverApiUrl: fixture.home.baseUrl,
    actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
  const localId = randomUUID();
  const sent = await runWithServerHttpBaseUrl(fixture.home.baseUrl, () => cli.execute('session.message.send', {
    sessionId, localId, message: 'MANAGED_INPUT_RESUMED', requestedAction: { v: 1, kind: 'send_now' }, reply: 'none',
  }, { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: fixture.machineId } }));
  expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, result: { status: 'accepted', localId } });
  expect(wakeCount).toBe(1);
  expect(await owner.execute('session.wait.idle', { sessionId }, context)).toMatchObject({ ok: true,
    result: { ok: true, idle: true, sessionId } });
  const native = (await readFile(capturePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
    open: { kind: string; providerSessionId: string }; inputIds: string[]; input: string; pid: number;
  });
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
