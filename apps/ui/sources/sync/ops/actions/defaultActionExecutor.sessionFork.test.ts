import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNativeResumeIdentityV1Schema, buildQualifiedPluginContributionKey, computeWorkspaceSyncPolicyDigest, deriveSessionCreationTagV1, MACHINE_PLAIN_DATA_KEY_MARKER,
  PluginManifestV2Schema, PluginProjectionV2Schema, SessionCreationCorrespondenceV1Schema, SessionCurrentProjectionRecordV1Schema,
  type ActionExecutorContext, type SessionRollbackTarget } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SettingsWriteDelta } from '@/sync/domains/settings/settings';
import type { CurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getAgentCore, publishRuntimeCapabilities } from '@happier-dev/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';

const outgoing: SocketRpcRequestPayload[] = [];
let daemonAnswer: (request: SocketRpcRequestPayload) => unknown = () => { throw new Error('Unexpected daemon request'); };
installDisconnectedServerSocketBoundary((socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Malformed socket RPC request');
    }
    const request: SocketRpcRequestPayload = { method: payload.method, params: payload.params };
    outgoing.push(request);
    return { ok: true, result: daemonAnswer(request) };
  });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(restoreExecutorModuleLoader);
const { storage } = await import('@/sync/domains/state/storage');
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
// These declarations are authored by the actual Agent plugins. The fixture does
// not invent native fork or rollback capabilities independently of the producer.
const codexManifest = (await import('@happier-dev/plugins-codex/manifest')).PLUGIN_MANIFEST;
const grokPlugin = await import('@happier-dev/plugins-grok/manifest');
const grokManifest = grokPlugin.PLUGIN_MANIFEST;
function currentCapabilities(manifestInput: unknown, localId: string, agentId = localId): CurrentProjectedAgentCapabilities {
  const manifest = PluginManifestV2Schema.parse(manifestInput);
  const declaration = manifest.contributes?.agents?.find((agent) => agent.id === localId);
  if (!declaration) throw new Error(`Missing Agent declaration: ${agentId}`);
  const current = readCurrentProjectedAgentCapabilities({ agentId, projection: PluginProjectionV2Schema.parse({
    v: 2, generation: 1, familiesById: {}, agentsById: { [agentId]: {
      id: agentId, identity: { pluginId: manifest.id, localId }, capabilities: declaration.capabilities,
    } },
  }) });
  if (!current) throw new Error(`Agent declaration did not project: ${agentId}`);
  return current;
}
const codex = currentCapabilities(codexManifest, 'codex');
const grok = currentCapabilities(grokManifest, 'grok');
const originalState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
const context = () => ({ surface: 'ui' as const, authority: 'present_user' as const, serverId });

function installSession(overrides: Partial<Session> = {}) {
  const session = createSessionFixture({ id: 'sess_parent', serverId, active: true,
    metadata: { path: '/repo', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine_1', flavor: 'codex', codexBackendMode: 'appServer', codexSessionId: 'thread_1' },
    ...overrides });
  storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session },
    sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId,
      [serverId]: { ...storage.getState().sessionListRowsByServerId[serverId], [session.id]: session } } });
  const wire = SessionCurrentProjectionRecordV1Schema.parse({ ...session,
    metadata: JSON.stringify(session.metadata), metadataLayoutVersion: 0,
    effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
    responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
    agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0 });
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: { session: wire } });
  homes.answer(serverId, `/v2/sessions/${session.id}?accessProjectionVersion=1`, { body: { session: wire } });
  return session;
}
function setSettings(delta: SettingsWriteDelta) {
  storage.getState().applySettingsLocal(delta);
}
function answerFork() {
  installSession({ id: 'sess_child', metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1',
    flavor: 'codex', forkV1: { v: 1, parentSessionId: 'sess_parent', createdAtMs: 1, strategy: 'replay', parentCutoffSeqInclusive: 1 } } });
  daemonAnswer = () => ({ ok: true, childSessionId: 'sess_child' });
}
function rpcRequests(method: string) { return outgoing.filter((request) => request.method.endsWith(`:${method}`)); }
function executor(options: Parameters<typeof createDefaultActionExecutor>[0] = {}) {
  return createDefaultActionExecutor({ openSession: vi.fn(), ...options });
}

describe('default Action executor Session lifecycle contracts', () => {
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    clearDaemonMergedProjectionCacheForTests();
    storage.setState(originalState, true);
    await homes.reset();
    serverId = await homes.addHome({ name: 'Session Home', serverUrl: 'https://session-actions.test', accountId: 'alice' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://session-actions.test', accountId: 'alice',
      request: async (url, init) => {
        const endpoint = new URL(String(url));
        const token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '');
        return createServerFetchAtEndpoint({ endpointUrl: endpoint.origin, ...(token ? { credentials: { token } } : {}) })(`${endpoint.pathname}${endpoint.search}`, init);
      } });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    setSettings({ sessionReplayEnabled: true });
    const machines = [createMachineFixture({ id: 'machine_1' }), createMachineFixture({ id: 'machine_2', metadata: {
      host: 'target.local', platform: 'linux', happyCliVersion: '0.0.0-test', happyHomeDir: '/home/target/.happier', homeDir: '/home/target',
    } })];
    storage.setState({ machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])),
      machineListByServerId: { [serverId]: machines } });
    for (const machine of machines) homes.answer(serverId, `/v1/machines/${machine.id}`, {
      body: { machine: { id: machine.id, kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } },
    });
    outgoing.length = 0;
    daemonAnswer = () => { throw new Error('Unexpected daemon request'); };
  });
  afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    await homes.reset();
    storage.setState(originalState, true);
    webLocks?.restore();
    webLocks = undefined;
    vi.restoreAllMocks();
  });

  it('hydrates the expected child and opens it in the parent Home after a successful fork', async () => {
    installSession();
    answerFork();
    const openSession = vi.fn();
    const result = await executor({ openSession, resolveServerIdForSessionId: () => serverId }).execute(
      'session.fork', { sessionId: 'sess_parent' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'forked', childSessionId: 'sess_child' } });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)).toContainEqual(expect.objectContaining({ method: `machine_1:${RPC_METHODS.SESSION_FORK}`,
      params: expect.objectContaining({ v: 1, parentSessionId: 'sess_parent', forkPoint: { type: 'latest' } }) }));
    expect(homes.requestsFor('/v2/sessions/sess_child').length).toBeGreaterThan(0);
    expect(openSession).toHaveBeenCalledWith('sess_child', { serverId });
  });

  it.each([true, false])('includes the replay summary runner only while execution runs are enabled (%s)', async (enabled) => {
    installSession();
    answerFork();
    const runner = { v: 1 as const, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' }, modelId: 'default', permissionMode: 'no_tools' as const };
    setSettings({ sessionReplayStrategy: 'summary_plus_recent', sessionReplaySummaryRunnerV1: runner,
      sessionReplayMaxSeedChars: 54_321, experiments: true, featureToggles: { 'execution.runs': enabled } });
    expect(await executor().execute('session.fork', { sessionId: 'sess_parent' }, context())).toMatchObject({ ok: true });
    const request = rpcRequests(RPC_METHODS.SESSION_FORK)[0];
    expect(request?.params).toMatchObject({ parentSessionId: 'sess_parent', replayMaxSeedChars: 54_321 });
    if (enabled) expect(request?.params).toHaveProperty('replaySummaryRunner', runner);
    else expect(request?.params).not.toHaveProperty('replaySummaryRunner');
  });

  it('clamps the replay seed budget to the canonical fork wire maximum', async () => {
    installSession();
    answerFork();
    setSettings({ sessionReplayMaxSeedChars: 500_000 });
    expect(await executor().execute('session.fork', { sessionId: 'sess_parent' }, context())).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)[0]?.params).toHaveProperty('replayMaxSeedChars', 200_000);
  });

  it('requests native fork when Replay is off and the current Agent declares native fork', async () => {
    installSession();
    answerFork();
    setSettings({ sessionReplayEnabled: false });
    expect(await executor({ currentAgentCapabilities: codex }).execute('session.fork', { sessionId: 'sess_parent' }, context())).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)[0]?.params).toHaveProperty('strategy', 'native');
  });

  it('rejects a fork before dispatch when both Replay and the native route are unavailable', async () => {
    installSession({ metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1', flavor: 'claude' } });
    setSettings({ sessionReplayEnabled: false });
    expect(await executor().execute('session.fork', { sessionId: 'sess_parent' }, context()))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(outgoing).toEqual([]);
  });

  it('returns the canonical missing-machine error instead of manufacturing a successful fork', async () => {
    installSession({ metadata: { path: '/repo', host: 'unknown-host', flavor: 'claude' } });
    expect(await executor().execute('session.fork', { sessionId: 'sess_parent' }, context()))
      .toMatchObject({ ok: false, errorCode: 'machine_not_found' });
    expect(outgoing).toEqual([]);
  });

  it.each(['session.fork', 'session.handoff'] as const)('uses the reachable machine when metadata names a replaced one (%s)', async (actionId) => {
    const stale = createMachineFixture({ id: 'machine_stale', active: false, replacedByMachineId: 'machine_1' });
    storage.setState({ machines: { ...storage.getState().machines, [stale.id]: stale },
      machineListByServerId: { [serverId]: [...storage.getState().machineListByServerId[serverId]!, stale] } });
    installSession({ metadata: { path: '/repo', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine_stale', flavor: 'claude' } });
    if (actionId === 'session.fork') answerFork();
    else daemonAnswer = () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] }, workspace: { kind: 'none' } });
    const result = await executor().execute(actionId, { sessionId: 'sess_parent', ...(actionId === 'session.handoff' ? { targetMachineId: 'machine_2' } : {}) }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(outgoing[0]?.method).toMatch(/^machine_1:/u);
  });

  it('preserves source authority and direct-to-persisted workspace options on handoff', async () => {
    installSession({ metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1', flavor: 'claude',
      directSessionV1: { v: 1, providerId: 'claude', machineId: 'machine_1', remoteSessionId: 'claude_session_1', source: { kind: 'claudeConfig', configDir: '/Users/tester/.claude' } } } });
    const terminal = { handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] },
      workspace: { kind: 'relationship', relationshipId: 'relationship_1', created: false } };
    daemonAnswer = () => terminal;
    const input = { sessionId: 'sess_parent', targetMachineId: 'machine_2', targetPath: '/target/repo', targetSessionStorageMode: 'persisted',
      workspaceAction: { kind: 'relationship', relationshipId: 'relationship_1', flushBeforeCommit: true } } as const;
    expect(await executor().execute('session.handoff', input, context())).toEqual({ ok: true, result: terminal });
    const payload = rpcRequests(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)[0]?.params;
    expect(payload).toMatchObject({ ...input, accountServerId: serverId });
    for (const field of ['sessionStorageMode', 'preferredTransportStrategies', 'negotiatedTransportStrategy']) expect(payload).not.toHaveProperty(field);
  });

  it('keeps a committed handoff warning in the public Action result', async () => {
    installSession();
    const terminal = { handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] },
      workspace: { kind: 'none' }, warning: { code: 'target_direct_mode_unavailable', message: 'The target uses persisted storage.' } };
    daemonAnswer = () => terminal;
    expect(await executor().execute('session.handoff', { sessionId: 'sess_parent', targetMachineId: 'machine_2' }, context()))
      .toEqual({ ok: true, result: terminal });
  });

  it('does not dispatch a handoff whose caller already canceled', async () => {
    installSession();
    const caller = new AbortController();
    caller.abort();
    expect(await executor().execute('session.handoff', { sessionId: 'sess_parent', targetMachineId: 'machine_2' },
      { ...context(), signal: caller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(outgoing).toEqual([]);
  });

  it('addresses the parent Home when another Home is focused during handoff', async () => {
    installSession();
    const parentServerId = serverId;
    await connection?.dispose();
    await homes.addHome({ name: 'Other Home', serverUrl: 'https://other-session-actions.test', accountId: 'bob' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://other-session-actions.test', accountId: 'bob' });
    // The connection harness installs the focused Account's transport token.
    // Reclaim the canonical per-Home credential boundary for this scoped call.
    installHomeGovernanceBoundaries(homes);
    daemonAnswer = () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] }, workspace: { kind: 'none' } });
    const result = await executor({ resolveServerIdForSessionId: () => parentServerId }).execute('session.handoff',
      { sessionId: 'sess_parent', targetMachineId: 'machine_2' }, { ...context(), serverId: parentServerId });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)[0]?.params).toHaveProperty('accountServerId', parentServerId);
    expect(homes.requestsFor('/v1/machines/machine_1')).toContainEqual(expect.objectContaining({ serverId: parentServerId }));
  });

  it('reaches the source daemon when the owner metadata projection is unavailable on this device', async () => {
    const session = installSession();
    const metadata = parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'codex' } }, 1);
    if (!metadata) throw new Error('Expected recipient-safe Session metadata');
    storage.setState({ sessions: { [session.id]: { ...session, metadataLayoutVersion: 1,
      metadata, ownerMetadataView: null } } });
    daemonAnswer = () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] }, workspace: { kind: 'none' } });
    expect(await executor().execute('session.handoff', { sessionId: 'sess_parent', targetMachineId: 'machine_2' }, context())).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)[0]?.params).toMatchObject({ sessionId: 'sess_parent', targetMachineId: 'machine_2' });
    expect(rpcRequests(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)[0]?.params).not.toHaveProperty('sessionStorageMode');
  });

  it('sends the exact approved target receipt and Action input through the real handoff adapter', async () => {
    installSession();
    const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const input = { sessionId: 'sess_parent', targetMachineId: 'machine_2', targetPath: '/target/repo', workspaceAction: {
      kind: 'create_relationship', mode: 'mirror_exactly', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, flushBeforeCommit: true } } as const;
    const approval = { v: 1, consequences: ['replace_nonempty_workspace_target'], serverId,
      machineId: 'machine_2', canonicalRoot: '/target/repo', rootFingerprint: 'a'.repeat(64), operationId: 'handoff-action-1' } satisfies NonNullable<ActionExecutorContext['handoffTargetReplacementApproval']>;
    daemonAnswer = (request) => request.method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`)
      ? { type: 'approval_required', approval }
      : { handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] }, workspace: { kind: 'relationship', relationshipId: 'relationship_1', created: false } };
    const result = await executor().execute('session.handoff', input, { ...context(), actionRequestId: 'handoff-action-1',
      handoffTargetReplacementApproval: approval, handoffTargetReplacementApprovalReceiptId: 'approval-receipt-1', bypassApprovals: true });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)[0]?.params).toMatchObject({ operationId: 'handoff-action-1', activatesExactMirror: true });
    expect(rpcRequests(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)[0]?.params).toMatchObject({
      handoffTargetReplacementApproval: approval, handoffTargetReplacementApprovalReceiptId: 'approval-receipt-1', handoffTargetReplacementApprovalActionInput: input });
  });

  it.each(['codex', 'openai', 'gpt'])('rolls back an active Codex Session including legacy flavor %s', async (flavor) => {
    installSession({ metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1', flavor, codexBackendMode: 'appServer' } });
    daemonAnswer = () => ({ ok: true, rolledBack: true, target: { type: 'latest_turn' } });
    const result = await executor({ currentAgentCapabilities: codex }).execute('session.rollback', { sessionId: 'sess_parent' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { rolledBack: true } });
    expect(rpcRequests(SESSION_RPC_METHODS.SESSION_ROLLBACK)[0]?.params).toEqual({ v: 1, target: { type: 'latest_turn' } });
  });

  it.each([
    ['codex', codex, { flavor: 'codex', codexBackendMode: 'appServer', codexSessionId: 'thread_1' }],
    ['grok', grok, { flavor: 'grok', grokSessionId: 'grok_1' }],
  ] as const)('resumes inactive %s before rolling back a trusted completed turn', async (_name, capabilities, metadata) => {
    installSession({ active: false, rollbackEligibleTurnStarts: [3], metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1', ...metadata } });
    daemonAnswer = (request) => request.method.endsWith(`:${SESSION_RPC_METHODS.SESSION_ROLLBACK}`)
      ? { ok: true, rolledBack: true, target: { type: 'before_user_message', userMessageSeq: 3 } }
      : { type: 'success', sessionId: 'sess_parent' };
    const target = { type: 'before_user_message', userMessageSeq: 3 } as const;
    const result = await executor({ currentAgentCapabilities: capabilities }).execute('session.rollback', { sessionId: 'sess_parent', target }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { rolledBack: true, target } });
    expect(outgoing.findIndex((request) => request.method.endsWith(`:${SESSION_RPC_METHODS.SESSION_ROLLBACK}`))).toBeGreaterThan(0);
  });

  it.each([
    ['session.rollback', 'current'],
    ['session.open', 'current'],
    ['session.rollback', 'missing'],
    ['session.open', 'missing'],
    ['session.rollback', 'mismatched'],
    ['session.open', 'mismatched'],
  ] as const)('preserves the external declaration through %s resume admission (%s)', async (actionId, declarationState) => {
    // Repackage the real Grok adapter through the public plugin author/activation
    // seam. Its real declaration supplies lifecycle support, not a test-local bag.
    const native = await createPluginTestkit({ manifest: grokManifest, module: grokPlugin });
    const registered = native.registration('agents', 'grok');
    if (!registered?.factory || !registered.sessionRunnerFactory) throw new Error('Grok runtime did not register');
    const sessionCapabilities = grok.capabilities.sessions;
    if (!sessionCapabilities) throw new Error('Grok declaration has no Session capabilities');
    const externalPlugin = definePlugin({ id: 'acme.lifecycle', version: '1.0.0', agents: { lifecycle: {
      declaration: { title: 'External Grok adapter', runtime: { kind: 'custom' }, primary: 'sessions', capabilities: { ...grok.capabilities, sessions: sessionCapabilities } },
      factory: registered.factory, sessionRunnerFactory: registered.sessionRunnerFactory,
    } } });
    const contributed = await createPluginTestkit({ manifest: externalPlugin.manifest, module: externalPlugin });
    try {
      expect(contributed.registration('agents', 'lifecycle')?.factory).toBe(registered.factory);
      const identity = { pluginId: externalPlugin.manifest.id, localId: 'lifecycle' };
      const agentId = buildQualifiedPluginContributionKey(identity);
      const currentAgent = currentCapabilities(externalPlugin.manifest, identity.localId, agentId);
      const core = getAgentCore('grok');
      if (!core) throw new Error('Missing Grok runtime declaration');
      installSession({ active: false, rollbackEligibleTurnStarts: [3], metadata: {
        path: '/repo', host: 'tester.local', machineId: 'machine_1',
        runtimeDescriptorV1: { v: 1, agentId, agent: { providerSessionId: 'external_native_1' } },
        nativeResumeIdentityV1: AgentNativeResumeIdentityV1Schema.parse({ v: 1, vendorResumeId: 'external_native_1' }),
        agentRuntimeCapabilitiesV1: publishRuntimeCapabilities({ sessionCapabilities: core.sessionCapabilities }),
        sessionCreationCorrespondenceV1: SessionCreationCorrespondenceV1Schema.parse({ v: 1,
          sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'test:external-agent', creationKey: 'session-parent' }),
          recipe: { execution: { machineId: 'machine_1', directory: { kind: 'path', path: '/repo' } },
            organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity }, modelSelection: null,
            profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null, connectedServices: null,
            mcpSelection: null, transcriptStorage: 'persisted', terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null } }),
      } });
      daemonAnswer = (request) => request.method.endsWith(`:${SESSION_RPC_METHODS.SESSION_ROLLBACK}`)
        ? { ok: true, rolledBack: true, target: { type: 'before_user_message', userMessageSeq: 3 } }
        : request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)
          ? { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {},
            agentsById: { [agentId]: { id: agentId, identity, capabilities: currentAgent.capabilities } } }) }
          : { type: 'success', sessionId: 'sess_parent' };
      const currentDeclaration = declarationState === 'current' ? currentAgent : declarationState === 'mismatched' ? codex : null;
      const result = await executor({ currentAgentCapabilities: currentDeclaration }).execute(actionId,
        { sessionId: 'sess_parent', ...(actionId === 'session.rollback'
          ? { target: { type: 'before_user_message', userMessageSeq: 3 } }
          : { approvedNewDirectoryCreation: true }) }, context());
      const evidence = JSON.stringify({ result, sessionReadPaths: homes.requests
        .filter((request) => request.path.includes('/sessions'))
        .map((request) => request.path) });
      if (declarationState === 'current') {
        expect(result, evidence).toMatchObject({ ok: true,
          result: actionId === 'session.rollback' ? { rolledBack: true } : { status: 'opened', sessionId: 'sess_parent' } });
        // Exact-Account recovery deliberately treats stored metadata as unknown,
        // so its existing resume owner requires the Provider-safe daemon method.
        const resumeMethod = actionId === 'session.open'
          ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
          : RPC_METHODS.SPAWN_HAPPY_SESSION;
        expect(rpcRequests(resumeMethod)[0]?.params).toMatchObject({ agentTarget: { kind: 'agent', identity }, resume: 'external_native_1' });
      } else {
        expect(result, evidence).toMatchObject({ ok: false,
          errorCode: actionId === 'session.rollback' ? 'session_rollback_resume_unavailable' : 'unsupported_action' });
        expect(rpcRequests(RPC_METHODS.SPAWN_HAPPY_SESSION)).toEqual([]);
        expect(rpcRequests(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE)).toEqual([]);
        expect(rpcRequests(SESSION_RPC_METHODS.SESSION_ROLLBACK)).toEqual([]);
      }
    } finally {
      await contributed.dispose();
      await native.dispose();
    }
  });

  it.each([
    ['inactive latest turn', false, 'codex', codex, createSessionAccessFixture(), { type: 'latest_turn' }],
    ['untrusted pending turn', false, 'grok', grok, createSessionAccessFixture(), { type: 'before_user_message', userMessageSeq: 5 }],
    ['view-only grant', false, 'grok', grok, createSessionAccessFixture('view'), { type: 'before_user_message', userMessageSeq: 3 }],
    ['mismatched Agent declaration', false, 'claude', codex, createSessionAccessFixture(), { type: 'before_user_message', userMessageSeq: 3 }],
    ['external Agent without a current declaration', false, 'acme-lifecycle', null, createSessionAccessFixture(), { type: 'before_user_message', userMessageSeq: 3 }],
  ] as const)('rejects %s before dispatching rollback', async (_name, active, flavor, capabilities, access, target) => {
    installSession({ active, access, rollbackEligibleTurnStarts: [3], metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1', flavor } });
    expect(await executor({ currentAgentCapabilities: capabilities }).execute('session.rollback',
      { sessionId: 'sess_parent', target: target satisfies SessionRollbackTarget }, context()))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(outgoing).toEqual([]);
  });

  it('applies checkpoint code rollback through the real Session RPC', async () => {
    installSession();
    const request = { v: 1, sessionId: 'sess_parent', turnId: 'turn-1', cwd: '/repo', codeMode: 'code_only_without_stash',
      backupMode: 'happier_checkpoint_only', expectedStartRef: 'refs/happier/checkpoints/c2Vzc19wYXJlbnQ/turn-start/turn-1',
      expectedFinalRef: 'refs/happier/checkpoints/c2Vzc19wYXJlbnQ/turn-final/turn-1', codeOnlyTranscriptDivergenceConfirmed: true } as const;
    const terminal = { status: 'applied', changedPaths: ['tracked.txt'], skippedPaths: [], receipts: ['checkpoint.rollback_applied'], diagnostics: [] };
    daemonAnswer = () => terminal;
    expect(await executor().execute('session.checkpoint_code_rollback', request, context())).toEqual({ ok: true, result: terminal });
    expect(rpcRequests(SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK)[0]?.params).toEqual(request);
  });
});
