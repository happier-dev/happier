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
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

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

it.each(['owner', 'owner attachment', 'member use', 'member manage'] as const)(
  'processes the first public Session input through admitted daemon services only for %s', async actor => {
  retainBoundaryCleanup();
  const home = 'srv_first_conversation';
  const attachment = definePlugin({ id: 'acme.project-launch', version: '1.0.0',
    composer: { attachments: { entry: { title: 'Entry', icon: 'error', cardinality: 'many',
      value: defineProtocolObject({}, { policy: 'closed' }),
      runtime: { resolveForDispatch: async request => ({ attachments: request.attachments.map(item => ({
        instanceId: item.instanceId, status: 'ready' as const, context: 'Mounted entry context',
      })) }) },
    } } } });
  const mountedAgent = { manifest: { ...conversationAgent.manifest, contributes: {
    ...conversationAgent.manifest.contributes, composerAttachments: attachment.manifest.contributes?.composerAttachments,
  } }, files: { ...conversationAgent.files, 'daemon.mjs': `import { factory } from './agent.mjs';
    export function activate(api) {
      api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } });
      api.composerAttachments.register('entry', { async resolveForDispatch(request) {
        return { attachments: request.attachments.map(item => ({ instanceId: item.instanceId,
          status: 'ready', context: 'Mounted entry context' })) };
      } });
    }` } };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true,
    actor === 'owner attachment' ? mountedAgent : conversationAgent, undefined, {
    externalActionAccountId: 'requester', homeServerIdentityId: home, ordinaryAccountSession: true,
    machineRpcMethods: [RPC_METHODS.SESSION_SPAWN_NEW],
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    agentIsolation: { read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }) },
  });
  const owner = actor === 'owner' || actor === 'owner attachment';
  boundary.database = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester',
    installation: h.f.installation, members: [{ accountId: 'member', accessLevel: actor === 'member use' ? 'view' : 'admin' }] });
  await writeFile(join(h.cwd, workspaceRead.relativePath), workspaceRead.text);
  const manager = Reflect.get(h.machine, 'rpcHandlerManager') as RpcHandlerManager;
  let relay: Awaited<ReturnType<typeof createInstalledMachineRpcRelay>> | undefined;
  let pending: UserMessage | undefined;
  const created = await spawnPublicInstalledProjectAgentSession({ fixture: h, homeServerIdentityId: home,
    actor: owner ? 'owner' : 'member', memberRole: actor === 'member use' ? 'use' : 'manage',
    ...(actor === 'owner attachment' ? { initialInput: { text: 'UI_CODEX_FIRST_INPUT', structuredInput: {
      v: 1 as const, composerAttachments: [{ v: 1 as const, instanceId: 'mounted-entry',
        attachment: { pluginId: 'acme.project-launch', localId: 'entry' }, key: 'entry', value: {},
        presentation: { label: 'Selected entry', typeLabel: 'Entry' } }],
    } } } : {}),
    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.project-launch', localId: 'agent' } },
    publicIngress: { manager, async invoke(method, params) {
      relay = await createInstalledMachineRpcRelay({ manager, machineId: 'machine', transportOwnerAccountId: 'requester',
        methods: [RPC_METHODS.SESSION_SPAWN_NEW], ui: { installation: h.f.installation, ownerAccountId: 'requester' } });
      return await relay.invokeUi(method, params, { actorAccountId: owner ? 'requester' : 'member' });
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
  if (actor === 'owner attachment') {
    // Full daemon startup has already loaded this exact ordinary Account. This
    // startup-service fixture obtains the same snapshot through real Home HTTP.
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false });
    expect(initialMessage.meta).toMatchObject({ happierStructuredInputV1: { composerAttachments: [
      expect.objectContaining({ instanceId: 'mounted-entry' }),
    ] } });
    const response = await h.dispatch({ kind: 'turn_contributions.resolve', requestId: 'mounted-first-input',
      request: { kind: 'composerAttachment', attachment: { pluginId: 'acme.project-launch', localId: 'entry' },
        request: { sessionId: h.sessionId, localId: initialMessage.localId!,
          attachments: [{ instanceId: 'mounted-entry', key: 'entry', value: {} }] } } });
    expect(response, JSON.stringify(response)).toMatchObject({ ok: true, result: { kind: 'turn_contributions', status: 'resolved',
      contributions: { kind: 'composerAttachment', result: { attachments: [{
        instanceId: 'mounted-entry', status: 'ready', context: 'Mounted entry context',
      }] } } } });
    await relay?.close();
    return;
  }
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
