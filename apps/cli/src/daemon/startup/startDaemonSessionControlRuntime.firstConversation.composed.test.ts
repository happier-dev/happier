import { expect, it, vi, onTestFinished } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { spawnPublicInstalledProjectAgentSession } from '@/daemon/testkit/publicInstalledProjectAgentSpawn.testkit';
import { createInstalledMachineRpcDatabaseBoundary, createInstalledMachineRpcRelay } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { runInstalledFirstConversationRuntime } from '@/daemon/testkit/firstConversationRuntime.testkit';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { UserMessageSchema, type UserMessage } from '@/api/types';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const boundary = vi.hoisted(() => ({
  control: null as Parameters<typeof startDaemonControlServer>[0] | null,
  database: null as ReturnType<typeof createInstalledMachineRpcDatabaseBoundary> | null,
}));
// The listener and database are system boundaries. Session creation, Home
// admission, daemon registration, runner custody, parent startup and Exec are real.
vi.mock('@/daemon/controlServer', async importOriginal => ({ ...await importOriginal<typeof import('@/daemon/controlServer')>(), startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
vi.mock('../../../../server/sources/storage/db', () => ({
  getDbProviderFromEnv: () => 'postgres',
  db: new Proxy({}, { get: (_target, property) => {
    if (!boundary.database) throw new Error('First-conversation database boundary is not installed');
    return Reflect.get(boundary.database.db, property);
  } }),
}));
function retainBoundaryCleanup() {
  // Fixture resources retire before their HTTP/socket boundaries are restored.
  onTestFinished(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    resetActiveAccountSettingsSnapshotForTests();
    boundary.control = null; boundary.database = null;
  });
}

const workspaceRead = { relativePath: 'first-conversation.txt', text: 'Owned first-conversation workspace' };
const conversationAgent = createFirstConversationAgentFixture('UI_CODEX_FIRST_INPUT', { workspaceRead });

it.each(['owner', 'member use', 'member manage'] as const)(
  'answers the first public Session Send through the real parent and native Exec only for %s', async actor => {
  retainBoundaryCleanup();
  const home = 'srv_first_conversation';
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, conversationAgent, undefined, {
    externalActionAccountId: 'requester', homeServerIdentityId: home, ordinaryAccountSession: true,
    machineRpcMethods: [RPC_METHODS.SESSION_SPAWN_NEW],
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  boundary.database = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester',
    installation: h.f.installation, members: [{ accountId: 'member', accessLevel: actor === 'member use' ? 'view' : 'admin' }] });
  await writeFile(join(h.cwd, workspaceRead.relativePath), workspaceRead.text);
  const manager = Reflect.get(h.machine, 'rpcHandlerManager') as RpcHandlerManager;
  let relay: Awaited<ReturnType<typeof createInstalledMachineRpcRelay>> | undefined;
  let pending: UserMessage | undefined;
  const created = await spawnPublicInstalledProjectAgentSession({ fixture: h, homeServerIdentityId: home,
    actor: actor === 'owner' ? 'owner' : 'member', memberRole: actor === 'member use' ? 'use' : 'manage',
    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.project-launch', localId: 'agent' } },
    publicIngress: { manager, async invoke(method, params) {
      relay = await createInstalledMachineRpcRelay({ manager, machineId: 'machine', transportOwnerAccountId: 'requester',
        methods: [RPC_METHODS.SESSION_SPAWN_NEW], ui: { installation: h.f.installation, ownerAccountId: 'requester' } });
      return await relay.invokeUi(method, params, { actorAccountId: actor === 'owner' ? 'requester' : 'member' });
    } },
    onPending: input => { pending = UserMessageSchema.parse({ ...UserMessageSchema.parse(input.message), localId: input.localId }); },
  });
  if (!created) {
    expect(pending).toBeUndefined();
    expect(h.nativeEffects()).toBe(0);
    return;
  }
  expect(pending).toMatchObject({ content: { text: 'UI_CODEX_FIRST_INPUT' } });
  const credentials = h.installedCredentials;
  if (!credentials || !pending) throw new Error('Public creator omitted ordinary owner custody or initial Pending input');
  const initialMessage = pending;
  if (!boundary.control) throw new Error('Daemon did not install control callbacks');
  const { outcome, answered, completed, failed, turns, assistant, stop } = await runInstalledFirstConversationRuntime({
    fixture: h, homeServerIdentityId: home, initialMessage, control: boundary.control });
  const turnFailed = failed.promise.then(() => {
    const failure = turns.find(mutation => mutation.action === 'fail');
    throw new Error(`The first public conversation Turn failed: ${JSON.stringify(failure?.issue)}`);
  });
  try {
    await Promise.race([answered.promise, turnFailed, outcome.then(() => { throw new Error('Parent stopped before its first native reply'); })]);
    await Promise.race([completed.promise, turnFailed, outcome.then(() => { throw new Error('Parent stopped before its first completed Turn'); })]);
    expect(assistant.join('')).toMatch(/^git version /);
    expect(assistant.join('')).not.toContain('UI_CODEX_FIRST_INPUT');
    const begin = turns.find(mutation => mutation.action === 'begin');
    expect(begin).toMatchObject({ sessionId: h.sessionId, startingInputId: initialMessage.localId });
    expect(turns.filter(mutation => mutation.action === 'complete')).toEqual([
      expect.objectContaining({ sessionId: h.sessionId, turnId: begin && 'turnId' in begin ? begin.turnId : undefined,
        transcriptAnchors: expect.objectContaining({ startUserMessageSeq: 1, userMessageSeqs: [1] }) }),
    ]);
    expect(h.tracked.requesterWorkAttributionV1).toMatchObject({ accountId: 'requester', machineId: 'machine',
      installationId: h.f.installation.installationId });
  } finally {
    await stop?.();
    await outcome;
    await relay?.close();
  }
}, 120_000);
