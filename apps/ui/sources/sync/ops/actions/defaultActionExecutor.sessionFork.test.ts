import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { AgentNativeResumeIdentityV1Schema} from '@happier-dev/protocol/agents/nativeResumeIdentityV1';
import { buildQualifiedPluginContributionKey} from '@happier-dev/protocol/plugins/contribution-key';
import { computeWorkspaceSyncPolicyDigest} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { deriveSessionCreationTagV1} from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import {
  PluginManifestV2Schema} from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { SessionCreationCorrespondenceV1Schema} from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionForkRpcParamsSchema} from '@happier-dev/protocol/sessions/fork';
import {
  normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import { type ActionExecutorContext} from '@happier-dev/protocol/actions/executor/types';
import { type SessionRollbackTarget } from '@happier-dev/protocol/sessions/rollback';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SESSION_WORKSPACE_RETURN_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/sessionWorkspaceReturnActionIdsV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { parseSocketRpcAuthorizationContext, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { SettingsWriteDelta } from '@/sync/domains/settings/settings';
import type { CurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary, installSessionActionFixture } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getAgentCore, publishRuntimeCapabilities } from '@happier-dev/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { MINIMUM_CLI_SESSION_FORK_REQUEST_ID_VERSION } from '@/utils/system/versionUtils';
import { readMachineDaemonCliVersionForServerScope } from '@/sync/domains/machines/readMachineDaemonCliVersionForServerScope';

// Only native modal presentation is replaced; custom content and Action admission stay real.
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true, confirmResult: true }).module;
});

let daemonAnswer: (request: SocketRpcRequestPayload) => unknown = () => { throw new Error('Unexpected daemon request'); };
const outgoing = installSessionActionRpcBoundary(request => daemonAnswer(request));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(restoreExecutorModuleLoader);
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const projectFilesReturnData = await import('../sessionProjectFilesReturn');
const { prepareSessionProjectFilesReturn, applySessionProjectFilesReturn, readSessionProjectFilesReturnComparison,
  replaceSessionProjectFilesReturnConflict } = projectFilesReturnData;
const { createScmDiffSummaryOperations } = await import('../scmDiffSummary/generate');
const { resolveSessionComposerSend } = await import('@/sync/domains/input/slashCommands/resolveSessionComposerSend');
const { executeSessionComposerResolution } = await import('@/sync/domains/input/slashCommands/executeSessionComposerResolution');
const { useSessionForkStrategyFlow } = await import('@/sync/domains/sessionFork/useSessionForkStrategyFlow');
const { getExistingSessionDraftProjection, resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { startSessionHandoff } = await import('@/sync/ops/sessionHandoffs');
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
let machineCensus: Machine[] = [];
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;
const context = () => ({ surface: 'ui' as const, authority: 'present_user' as const, serverId });

function installSession(overrides: Partial<Session> = {}) {
  return installSessionActionFixture({ homes, storage, serverId, session: { id: 'sess_parent', ...overrides } });
}
async function installForkRequestIdentityMachine() {
  const machine = machineCensus.find(row => row.id === 'machine_1');
  if (!machine) throw new Error('Expected installed machine');
  const currentMachine = createMachineFixture({ ...machine, daemonState: MachinePublishedDaemonStateV1Schema.parse({ status: 'running', cliVersion: MINIMUM_CLI_SESSION_FORK_REQUEST_ID_VERSION }),
    daemonStateVersion: machine.daemonStateVersion + 1 });
  machineCensus = machineCensus.map(row => row.id === currentMachine.id ? currentMachine : row);
  await sync.refreshMachines({ serverId });
  await vi.waitFor(() => expect(readMachineDaemonCliVersionForServerScope({ state: storage.getState(), machineId: currentMachine.id,
    serverId, activeServerId: storage.getState().profileScope?.serverId })).toBe(MINIMUM_CLI_SESSION_FORK_REQUEST_ID_VERSION));
}
function setSettings(delta: SettingsWriteDelta) {
  storage.getState().applySettingsLocal(delta);
}
function installOwnerMetadataUnavailableSession() {
  const session = installSession();
  const metadata = parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'codex' } }, 1);
  if (!metadata) throw new Error('Expected recipient-safe Session metadata');
  storage.setState({ sessions: { [session.id]: { ...session, metadataLayoutVersion: 1,
    metadata, ownerMetadataView: null } } });
}
function answerFork() {
  installSession({ id: 'sess_child', metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1',
    flavor: 'codex', forkV1: { v: 1, parentSessionId: 'sess_parent', createdAtMs: 1, strategy: 'replay', parentCutoffSeqInclusive: 1 } } });
  daemonAnswer = () => ({ ok: true, childSessionId: 'sess_child' });
}
function rpcRequests(method: string) { return outgoing.filter((request) => request.method.endsWith(`:${method}`)); }
function executor(options: Parameters<typeof createDefaultActionExecutor>[0] = {}) {
  // The user accepts the native confirmation; Action admission and replay remain real.
  return createDefaultActionExecutor({ openSession: vi.fn(), presentUserActionConfirmation: async () => true, ...options });
}
async function mountForkFlow(navigate = vi.fn()) {
  const onNavigated = vi.fn();
  const harness = await renderHook(() => useSessionForkStrategyFlow({
    request: { parentSessionId: 'sess_parent', serverId, machineId: 'machine_1',
      forkPoint: { type: 'seq', upToSeqInclusive: 12 }, restoredDraftText: 'restored draft', replayMaxSeedChars: 12_345 },
    navigate, onNavigated,
  }));
  await vi.waitFor(() => expect(harness.getCurrent().ready).toBe(true));
  return { harness, navigate, onNavigated };
}

describe('default Action executor Session lifecycle contracts', () => {
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    clearDaemonMergedProjectionCacheForTests();
    storage.setState(originalState, true);
    await homes.reset();
    serverId = await homes.addHome({ name: 'Session Home', serverUrl: 'https://session-actions.test',
      serverIdentityId: 'srv_session_actions', accountId: 'alice', currentAccount: true });
    homes.answer(serverId, '/v1/machines', { body: [
      createPlainMachineRowFixture({ id: 'machine_1', accountId: 'alice' }),
      createPlainMachineRowFixture({ id: 'machine_2', accountId: 'alice' }),
    ] });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://session-actions.test', accountId: 'alice',
      serverIdentityId: 'srv_session_actions', credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
      request: createSessionReadBatchFetchBoundary(homes.request) });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    setSettings({ sessionReplayEnabled: true });
    const machines = [createMachineFixture({ id: 'machine_1' }), createMachineFixture({ id: 'machine_2', metadata: {
      host: 'target.local', platform: 'linux', happyCliVersion: '0.0.0-test', happyHomeDir: '/home/target/.happier', homeDir: '/home/target',
    } })];
    machineCensus = machines;
    storage.setState({ machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])),
      machineListByServerId: { [serverId]: machines } });
    const publishedMachine = (machine: Machine) => ({
        ...createPlainMachineRowFixture({ id: machine.id, accountId: 'alice' }),
        metadata: encodePlainMachineStoredContent(machine.metadata),
        daemonState: machine.daemonState ? encodePlainMachineStoredContent(machine.daemonState) : null,
        daemonStateVersion: machine.daemonStateVersion,
        active: machine.active, replacedByMachineId: machine.replacedByMachineId ?? null,
    });
    homes.answer(serverId, '/v1/machines?includeRevoked=true', { select: () => ({
      body: machineCensus.map(publishedMachine),
    }) });
    for (const machine of machines) homes.answer(serverId, `/v1/machines/${machine.id}`, {
      select: () => ({ body: { machine: publishedMachine(machineCensus.find(row => row.id === machine.id) ?? machine) } }),
    });
    await sync.refreshMachines({ serverId });
    outgoing.length = 0;
    daemonAnswer = () => { throw new Error('Unexpected daemon request'); };
  });
  afterEach(async () => {
    await standardCleanup();
    resetSessionDraftRepositoryForTests();
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
    // The daemon has published the child, but this device has not hydrated it yet.
    storage.setState({ sessions: { sess_parent: storage.getState().sessions.sess_parent! },
      sessionListRowsByServerId: { [serverId]: { sess_parent: storage.getState().sessions.sess_parent! } } });
    const openSession = vi.fn();
    const result = await executor({ openSession, resolveServerIdForSessionId: () => serverId }).execute(
      'session.fork', { sessionId: 'sess_parent' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'forked', childSessionId: 'sess_child' } });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)).toContainEqual(expect.objectContaining({ method: `machine_1:${RPC_METHODS.SESSION_FORK}`,
      params: expect.objectContaining({ v: 1, parentSessionId: 'sess_parent', forkPoint: { type: 'latest' } }) }));
    expect(homes.requests.filter(({ path }) => path.split('?')[0] === '/v2/sessions/sess_child'))
      .toContainEqual(expect.objectContaining({ serverId }));
    expect(readSessionOwnerMetadataView(storage.getState().sessions.sess_child!)?.forkV1).toMatchObject({ parentSessionId: 'sess_parent' });
    expect(openSession).toHaveBeenCalledWith('sess_child', { serverId });
  });

  it('forks the current Session through /fork and opens the child without sending an agent message', async () => {
    await sync.refreshMachines({ serverId });
    installSession();
    answerFork();
    const openSession = vi.fn();
    let message = '/fork';
    const clearSemanticDraftValues = vi.fn();
    const modalAlert = vi.fn();
    const handled = await executeSessionComposerResolution({
      resolved: resolveSessionComposerSend({ input: message, executionRunsEnabled: false }),
      sessionId: 'sess_parent', accountScope: { serverId, accountId: 'alice' },
      agentId: 'codex', permissionMode: 'default',
      actionExecutor: executor({ openSession }), previousMessage: message,
      setMessage: (text) => { message = text; }, clearDraft: vi.fn(), clearSemanticDraftValues,
      trackMessageSent: () => { throw new Error('A local fork must not send an agent message'); },
      navigateToRuns: vi.fn(), modalAlert,
    });
    expect(handled).toBe(true);
    expect(modalAlert.mock.calls).toEqual([]);
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)[0]?.params).toMatchObject({
      parentSessionId: 'sess_parent', forkPoint: { type: 'latest' },
    });
    expect(openSession).toHaveBeenCalledWith('sess_child', { serverId });
    expect(message).toBe('');
    expect(clearSemanticDraftValues).toHaveBeenCalled();
    expect(modalAlert).not.toHaveBeenCalled();
  });

  it('restores /fork and its semantic draft when the fork Action refuses the request', async () => {
    installSession();
    setSettings({ sessionReplayEnabled: false });
    const openSession = vi.fn();
    let message = '/fork';
    const clearSemanticDraftValues = vi.fn();
    const modalAlert = vi.fn();
    const handled = await executeSessionComposerResolution({
      resolved: resolveSessionComposerSend({ input: message, executionRunsEnabled: false }),
      sessionId: 'sess_parent', accountScope: { serverId, accountId: 'alice' },
      agentId: 'codex', permissionMode: 'default',
      actionExecutor: executor({ openSession }), previousMessage: message,
      setMessage: (text) => { message = text; }, clearDraft: vi.fn(), clearSemanticDraftValues,
      trackMessageSent: vi.fn(), navigateToRuns: vi.fn(), modalAlert,
    });
    expect(handled).toBe(true);
    expect(message).toBe('/fork');
    expect(clearSemanticDraftValues).not.toHaveBeenCalled();
    expect(modalAlert).toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)).toEqual([]);
  });

  it('honors an explicit Replay cutoff and leaves child navigation to the initiating presentation', async () => {
    installSession();
    answerFork();
    const openSession = vi.fn();
    const result = await executor({ openSession }).execute('session.fork', {
      sessionId: 'sess_parent', strategy: 'replay', forkPoint: { type: 'seq', upToSeqInclusive: 12 },
      replayMaxSeedChars: 12_345,
    }, context());
    expect(result).toMatchObject({ ok: true, result: { childSessionId: 'sess_child' } });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)[0]?.params).toMatchObject({
      parentSessionId: 'sess_parent', strategy: 'replay', forkPoint: { type: 'seq', upToSeqInclusive: 12 }, replayMaxSeedChars: 12_345,
    });
    expect(openSession).not.toHaveBeenCalled();
  });

  it('refuses explicit Replay when the Account disables it even if Native is available', async () => {
    installSession();
    setSettings({ sessionReplayEnabled: false });
    expect(await executor({ currentAgentCapabilities: codex }).execute('session.fork', {
      sessionId: 'sess_parent', strategy: 'replay',
    }, context())).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(outgoing).toEqual([]);
  });

  it('keeps explicit Native failure distinct from a successful Replay fallback', async () => {
    installSession();
    daemonAnswer = request => {
      const params = request.params as Readonly<{ strategy?: string }>;
      return params.strategy === 'native'
        ? { ok: false, errorCode: 'FORK_UNSUPPORTED', errorMessage: 'Native unavailable' }
        : { ok: true, childSessionId: 'replay_child' };
    };
    expect(await executor().execute('session.fork', { sessionId: 'sess_parent', strategy: 'native' }, context()))
      .toMatchObject({ ok: false, errorCode: 'FORK_UNSUPPORTED' });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)[0]?.params).toHaveProperty('strategy', 'native');
  });

  it('admits the chooser through Action policy before emitting a fork', async () => {
    installSession();
    setSettings({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'session.fork': { disabledSurfaces: ['ui'] } } }) });
    const { harness, navigate } = await mountForkFlow();
    await act(async () => { await harness.getCurrent().submit('replay'); });
    expect(harness.getCurrent().phase).toEqual({ type: 'choosing' });
    expect(harness.getCurrent().failure).toMatchObject({ route: 'replay', kind: 'error' });
    expect(outgoing).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('waits for real approval without claiming an issued fork or allowing another mutation', async () => {
    installSession();
    await homes.requireUiApproval(serverId, 'session.fork');
    const { harness, navigate } = await mountForkFlow();
    let submission: Promise<void> | undefined;
    await act(async () => { submission = harness.getCurrent().submit('replay'); });
    await vi.waitFor(() => expect(harness.getCurrent().phase).toMatchObject({ type: 'awaiting_approval', route: 'replay', artifactId: expect.any(String) }));
    const phase = harness.getCurrent().phase;
    if (phase.type !== 'awaiting_approval') throw new Error('Expected approval custody');
    expect(harness.getCurrent().isBusy).toBe(true);
    expect(outgoing).toEqual([]);
    await act(async () => { await harness.getCurrent().submit('native'); });
    expect(outgoing).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(await decideApprovalAsInbox(serverId, phase.artifactId, 'reject')).toMatchObject({ ok: true });
    await submission;
    await vi.waitFor(() => expect(harness.getCurrent().phase).toEqual({ type: 'choosing' }));
    expect(harness.getCurrent().failure).toMatchObject({ route: 'replay', kind: 'error' });
    expect(outgoing).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('forks through the chooser with the selected cutoff and restores the draft before navigating once', async () => {
    installSession();
    answerFork();
    const { harness, navigate, onNavigated } = await mountForkFlow();
    expect(harness.getCurrent().phase).toEqual({ type: 'choosing' });
    expect(outgoing).toEqual([]);
    await act(async () => { await harness.getCurrent().submit('replay'); });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)[0]?.params).toMatchObject({ strategy: 'replay',
      forkPoint: { type: 'seq', upToSeqInclusive: 12 }, replayMaxSeedChars: 12_345 });
    const forkRequest = rpcRequests(RPC_METHODS.SESSION_FORK)[0];
    const forkParams = SessionForkRpcParamsSchema.parse(forkRequest?.params);
    expect(parseSocketRpcAuthorizationContext(forkRequest?.authorization)).toEqual({
      kind: 'session.write', sessionId: forkParams.parentSessionId,
    });
    expect(getExistingSessionDraftProjection({ serverId, accountId: 'alice' }, 'sess_child'))
      .toMatchObject({ text: 'restored draft' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('sess_child', { serverId });
    expect(onNavigated).toHaveBeenCalledTimes(1);
    expect(harness.getCurrent().phase).toEqual({ type: 'navigated' });
  });

  it('shows a typed daemon update requirement without treating it as an ambiguous fork', async () => {
    installSession();
    daemonAnswer = () => ({ ok: false, errorCode: 'DAEMON_RPC_UNAVAILABLE', errorMessage: 'Update daemon' });
    const { harness, navigate } = await mountForkFlow();
    await act(async () => { await harness.getCurrent().submit('native'); });
    expect(harness.getCurrent().phase).toEqual({ type: 'choosing' });
    expect(harness.getCurrent().failure).toEqual({ route: 'native', kind: 'update_required', message: 'Update daemon' });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the daemon attempt identity stable for a safe retry and distinct for another route', async () => {
    installSession();
    await installForkRequestIdentityMachine();
    daemonAnswer = () => ({ ok: false, errorCode: 'SPAWN_FAILED', errorMessage: 'not created' });
    const { harness } = await mountForkFlow();
    await act(async () => { await harness.getCurrent().submit('native'); });
    await act(async () => { await harness.getCurrent().submit('native'); });
    await act(async () => { await harness.getCurrent().submit('replay'); });
    const attempts = rpcRequests(RPC_METHODS.SESSION_FORK).map(request => SessionForkRpcParamsSchema.parse(request.params));
    expect(attempts).toHaveLength(3);
    expect(attempts[0], JSON.stringify({ storedVersion: storage.getState().machines.machine_1?.daemonState?.cliVersion,
      scopedVersion: storage.getState().machineListByServerId[serverId]?.find(machine => machine.id === 'machine_1')?.daemonState?.cliVersion,
      profileScope: storage.getState().profileScope, serverId,
    })).toHaveProperty('requestId', expect.any(String));
    expect(attempts[1]).toHaveProperty('requestId', attempts[0]?.requestId);
    expect(attempts[2]?.requestId).not.toBe(attempts[0]?.requestId);
  });

  it('keeps an ambiguous fork pending and adopts a subsequently visible child without reissuing the mutation', async () => {
    installSession();
    await installForkRequestIdentityMachine();
    daemonAnswer = () => ({ ok: false, errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'pending' });
    const { harness, navigate } = await mountForkFlow();
    await act(async () => { await harness.getCurrent().submit('replay'); });
    expect(harness.getCurrent().phase).toMatchObject({ type: 'unknown' });
    await act(async () => { await harness.getCurrent().submit('replay'); });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)).toHaveLength(1);
    const attempt = SessionForkRpcParamsSchema.parse(rpcRequests(RPC_METHODS.SESSION_FORK)[0]?.params);
    if (!attempt.requestId) throw new Error('Expected exact emitted fork attempt identity');
    installSession({ id: 'sess_child', metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1',
      forkV1: { v: 1, parentSessionId: 'sess_parent', createdAtMs: 1, strategy: 'replay',
        parentCutoffSeqInclusive: 11, requestId: attempt.requestId } } });
    await act(async () => { await harness.getCurrent().checkForFork(); });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('sess_child', { serverId });
    expect(harness.getCurrent().phase).toEqual({ type: 'navigated' });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)).toHaveLength(1);
  });

  it('does not adopt a preexisting layout-1 child as the result of an unknown attempt', async () => {
    installSession();
    const existing = installSession({ id: 'existing_child', metadata: { path: '/repo', host: 'tester.local', machineId: 'machine_1',
      forkV1: { v: 1, parentSessionId: 'sess_parent', createdAtMs: 1, strategy: 'replay', parentCutoffSeqInclusive: 12 } } });
    const shared = parseDecryptedSessionMetadata({ v: 1, agentPresentation: { agentId: 'codex' } }, 1);
    if (!shared) throw new Error('Expected recipient-safe Session metadata');
    storage.setState({ sessions: { ...storage.getState().sessions,
      [existing.id]: { ...existing, metadataLayoutVersion: 1, metadata: shared, ownerMetadataView: existing.metadata } } });
    daemonAnswer = () => ({ ok: false, errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'pending' });
    const { harness, navigate } = await mountForkFlow();
    await act(async () => { await harness.getCurrent().submit('replay'); });
    await act(async () => { await harness.getCurrent().checkForFork(); });
    expect(harness.getCurrent().phase).toMatchObject({ type: 'unknown', lastCheck: 'none' });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)).toHaveLength(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('allows child navigation to be retried without another fork mutation', async () => {
    installSession();
    daemonAnswer = () => ({ ok: true, childSessionId: 'sess_child' });
    homes.answer(serverId, '/v2/sessions/sess_child?accessProjectionVersion=1', { status: 404, body: { error: 'not_found' } });
    const { harness, navigate, onNavigated } = await mountForkFlow();
    await act(async () => { await harness.getCurrent().submit('replay'); });
    expect(harness.getCurrent().phase).toMatchObject({ type: 'opening', childSessionId: 'sess_child', stalled: true });
    expect(onNavigated).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    answerFork();
    await act(async () => { await harness.getCurrent().retryOpen(); });
    expect(harness.getCurrent().phase).toEqual({ type: 'navigated' });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)).toHaveLength(1);
  });

  it('does not duplicate an in-flight request or navigate after its initiating surface unmounts', async () => {
    installSession();
    let settle: ((value: unknown) => void) | undefined;
    daemonAnswer = () => new Promise(resolve => { settle = resolve; });
    const { harness, navigate, onNavigated } = await mountForkFlow();
    let submission: Promise<void> | undefined;
    await act(async () => { submission = harness.getCurrent().submit('replay'); });
    await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
    await act(async () => { await harness.getCurrent().submit('replay'); });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)).toHaveLength(1);
    await harness.unmount();
    settle?.({ ok: true, childSessionId: 'sess_child' });
    await submission;
    expect(navigate).not.toHaveBeenCalled();
    expect(onNavigated).not.toHaveBeenCalled();
  });

  it.each([true, false])('includes the replay summary runner only while execution runs are enabled (%s)', async (enabled) => {
    installSession();
    answerFork();
    const runner = { v: 1 as const, modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'default' }, permissionMode: 'no_tools' as const };
    setSettings({ sessionReplayStrategy: 'summary_plus_recent', sessionReplaySummaryRunnerV1: runner,
      sessionReplayMaxSeedChars: 54_321, experiments: true, featureToggles: { 'execution.runs': enabled } });
    expect(await executor().execute('session.fork', { sessionId: 'sess_parent' }, context())).toMatchObject({ ok: true });
    const request = rpcRequests(RPC_METHODS.SESSION_FORK)[0];
    expect(request?.params).toMatchObject({ parentSessionId: 'sess_parent', replayMaxSeedChars: 54_321 });
    if (enabled) expect(request?.params).toHaveProperty('replaySummaryRunner', runner);
    else expect(request?.params).not.toHaveProperty('replaySummaryRunner');
  });

  it('preserves the canonical maximum replay seed budget in the fork wire request', async () => {
    installSession();
    answerFork();
    setSettings({ sessionReplayMaxSeedChars: 200_000 });
    expect(await executor().execute('session.fork', { sessionId: 'sess_parent' }, context())).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)[0]?.params).toHaveProperty('replayMaxSeedChars', 200_000);
  });

  it('reads an undersized retained preference as the default before the real fork Action dispatch', async () => {
    installSession();
    answerFork();
    // Retained data may predate the writable floor; exercise the real config
    // reader beneath Action composition without changing a live Account.
    storage.setState({ settings: { ...storage.getState().settings, sessionReplayMaxSeedChars: 1024 } });
    expect(await executor().execute('session.fork', { sessionId: 'sess_parent' }, context())).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.SESSION_FORK)[0]?.params).toHaveProperty('replayMaxSeedChars', 120_000);
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
    machineCensus = [...machineCensus, stale];
    storage.setState({ machines: { ...storage.getState().machines, [stale.id]: stale },
      machineListByServerId: { [serverId]: [...storage.getState().machineListByServerId[serverId]!, stale] } });
    installSession({ metadata: { path: '/repo', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine_stale', flavor: 'claude' } });
    if (actionId === 'session.fork') answerFork();
    else daemonAnswer = () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] }, workspace: { kind: 'none' } });
    const result = await executor().execute(actionId, { sessionId: 'sess_parent', ...(actionId === 'session.handoff' ? { targetMachineId: 'machine_2' } : {}) }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(outgoing[0]?.method).toMatch(/^machine_1:/u);
  });

  it('reviews copied project changes with no-change, conflict and failed data states', () => {
    const projectReview = projectFilesReturnData.projectSessionProjectFilesReturnReviewState;
    const projectApply = projectFilesReturnData.projectSessionProjectFilesReturnApplyState;
    const review = { returnId: 'a'.repeat(64), sessionId: 'sess_parent', repositoryRootPath: '/repo', paths: [] };
    expect(projectReview?.({ ok: true, result: review })).toEqual({ kind: 'no_changes', review });
    const changed = { ...review, paths: [{ path: 'src', files: [], conflicts: [{ path: 'src/file.ts', code: 'both_changed' as const }] }] };
    expect(projectReview?.({ ok: true, result: changed })).toEqual({ kind: 'conflicts', review: changed });
    const ready = { ...changed, paths: [{ ...changed.paths[0], conflicts: [] }], applyUnavailableReason: 'baseline_unavailable' as const };
    expect(projectReview?.({ ok: true, result: ready })).toEqual({ kind: 'ready', review: ready });
    const failure = { ok: false as const, errorCode: 'conflict_changed' as const, error: 'conflict_changed', details: { appliedPaths: ['done.ts'], path: 'src/file.ts' } };
    expect(projectReview?.(failure)).toEqual({ kind: 'failed', failure });
    expect(projectApply?.(failure)).toEqual({ kind: 'failed', failure });
    const applied = { appliedPaths: ['done.ts'], conflicts: [{ path: 'src/file.ts', code: 'both_changed' as const }] };
    expect(projectApply?.({ ok: true, result: applied })).toEqual({ kind: 'conflicts', result: applied });
    expect(projectApply?.({ ok: true, result: { ...applied, conflicts: [] } }))
      .toEqual({ kind: 'applied', result: { ...applied, conflicts: [] } });
  });

  it('reviews copied project changes through pinned Machine evidence and hydrates exact Session files', async () => {
    installSession();
    const originalMachine = storage.getState().machines.machine_2;
    storage.setState({ machines: { ...storage.getState().machines, machine_2: {
      ...originalMachine, operationProtocolCapabilities: { scmComparisonIndexPaging: { protocolVersions: [1] } },
    } }, machineListByServerId: { [serverId]: storage.getState().machineListByServerId[serverId]!.map(machine =>
      machine.id === 'machine_2' ? { ...machine, operationProtocolCapabilities: { scmComparisonIndexPaging: { protocolVersions: [1] } } } : machine) } });
    const file = { path: 'file.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
      evidence: { state: 'available' as const, unifiedDiff: '--- host\n+++ sandbox\n@@ -1 +1 @@\n-old\n+new\n' }, occurrences: [] };
    const comparison = { id: 'a'.repeat(64), source: { kind: 'workingTree' as const },
      repository: { rootPath: '/original' }, endpoints: { before: 'host', after: 'sandbox' },
      inventory: { state: 'complete' as const, files: [{ ...file, evidence: { state: 'deferred', reason: 'index_projection' } }], reasons: [] } };
    daemonAnswer = () => ({ success: true, comparison,
      metadata: { source: comparison.source, sourceKey: comparison.id }, page: { totalFiles: 2, nextCursor: 1 } });
    const operations = createScmDiffSummaryOperations();
    expect(await operations.captureComparison({ machineId: 'machine_2', comparisonSessionId: 'sess_parent', serverId,
      input: { cwd: '/original', source: comparison.source, comparisonId: comparison.id,
        projection: { kind: 'index', limit: 7 } } })).toMatchObject({ success: true, comparison });
    expect(rpcRequests(RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE).at(-1)).toMatchObject({
      method: `machine_2:${RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE}`,
      params: { sessionId: 'sess_parent', comparisonId: comparison.id, cwd: '/original', projection: { kind: 'index', limit: 7 } },
    });
    const nextComparison = { ...comparison, inventory: { ...comparison.inventory,
      files: [{ ...comparison.inventory.files[0], path: 'second.ts' }] } };
    daemonAnswer = () => ({ success: true, comparison: nextComparison,
      metadata: { source: comparison.source, sourceKey: comparison.id }, page: { totalFiles: 2, nextCursor: null } });
    expect(await operations.captureComparison({ machineId: 'machine_2', comparisonSessionId: 'sess_parent', serverId,
      input: { cwd: '/original', source: comparison.source, comparisonId: comparison.id,
        projection: { kind: 'index', cursor: 1, limit: 7 } } })).toMatchObject({ success: true, comparison: nextComparison });
    expect(rpcRequests(RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE).at(-1)).toMatchObject({
      method: `machine_2:${RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE}`, params: { sessionId: 'sess_parent',
        comparisonId: comparison.id, projection: { kind: 'index', cursor: 1, limit: 7 } },
    });
    daemonAnswer = () => ({ success: true, diff: file.evidence.unifiedDiff, capturedFile: file });
    expect(await operations.readCapturedFile({ machineId: 'machine_2', comparisonSessionId: 'sess_parent', serverId,
      input: { cwd: '/original', source: comparison.source, comparisonId: comparison.id, path: 'file.ts' } }))
      .toMatchObject({ success: true, capturedFile: file });
    expect(rpcRequests(RPC_METHODS.SCM_DIFF_FILE).at(-1)).toMatchObject({
      method: `machine_2:${RPC_METHODS.SCM_DIFF_FILE}`, params: { cwd: '/original',
        captured: { sessionId: 'sess_parent', comparisonId: comparison.id, path: 'file.ts' } },
    });
  });

  it('reviews copied project changes through the original controller and retains partial return effects', async () => {
    installSession();
    const review = { returnId: 'a'.repeat(64), sessionId: 'sess_parent', repositoryRootPath: '/repo', paths: [],
      applyUnavailableReason: 'baseline_unavailable' as const };
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine_1', installationId: 'return-installation',
      tokenEpoch: 0, actionId: SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[0], requesterInvocation: 'credentials',
      execute: () => review });
    daemonAnswer = () => review;
    expect(await prepareSessionProjectFilesReturn({
      sessionId: 'sess_parent', machineId: 'machine_1',
    }, context())).toEqual({ ok: true, result: review });
    expect(homes.requests).toContainEqual(expect.objectContaining({ path: `/v1/actions/${SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[0]}` }));
    const comparison = { success: true, comparison: { id: review.returnId, source: { kind: 'workingTree' },
      repository: { rootPath: '/repo' }, endpoints: { before: 'host', after: 'sandbox' },
      inventory: { state: 'complete', files: [], reasons: [] } },
      metadata: { source: { kind: 'workingTree' }, sourceKey: review.returnId } };
    daemonAnswer = () => comparison;
    expect(await readSessionProjectFilesReturnComparison({ machineId: 'machine_1', review }, { ...context(), bypassApprovals: true }))
      .toEqual({ ok: true, result: comparison });
    expect(rpcRequests(RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE).at(-1))
      .toMatchObject({ method: `machine_1:${RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE}`,
        params: { cwd: '/repo', sessionId: 'sess_parent', comparisonId: review.returnId, source: { kind: 'workingTree' } } });
    let appliedInput: unknown;
    let applyAnswer: unknown = { ok: false, errorCode: 'conflict_changed', error: 'conflict_changed', details: { appliedPaths: ['README.md'], path: 'src' } };
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine_1', installationId: 'return-installation',
      tokenEpoch: 0, actionId: SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[1], requesterInvocation: 'optional',
      execute: input => { appliedInput = input; return applyAnswer; },
      failure: value => { const parsed = ActionExecuteFailureSchema.safeParse(value); return parsed.success ? parsed.data : null; } });
    daemonAnswer = () => applyAnswer;
    expect(await applySessionProjectFilesReturn({
      sessionId: 'sess_parent', machineId: 'machine_1', returnId: 'return-1', paths: ['src'],
    }, { ...context(), bypassApprovals: true })).toMatchObject({ ok: false, errorCode: 'conflict_changed',
      details: { appliedPaths: ['README.md'], path: 'src' } });
    applyAnswer = { appliedPaths: ['src/file.ts'], conflicts: [] };
    expect(await replaceSessionProjectFilesReturnConflict({ sessionId: 'sess_parent', machineId: 'machine_1',
      returnId: 'return-1', path: 'src/file.ts' }, { ...context(), bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { appliedPaths: ['src/file.ts'], conflicts: [] } });
    expect(appliedInput)
      .toMatchObject({ paths: ['src/file.ts'], replaceConflictPaths: ['src/file.ts'] });
  });

  it.each([
    { outcome: 'failed', appliedPaths: ['tree/first.txt', 'tree/nested/also.txt'] },
    { outcome: 'failed', appliedPaths: [] },
    { outcome: 'conflicts', appliedPaths: ['tree/first.txt', 'tree/nested/also.txt'] },
  ])('shows honest copied-file $outcome effects for $appliedPaths', async ({ outcome, appliedPaths }) => {
    installSession();
    const conflicts = [{ path: 'tree/both.txt', code: 'both_changed' as const }];
    const review = { returnId: 'b'.repeat(64), sessionId: 'sess_parent', repositoryRootPath: '/repo',
      paths: [{ path: 'tree', conflicts, files: ['tree/first.txt', 'tree/nested/also.txt', 'tree/both.txt'].map(path => ({
        path, changeKind: 'modified', binary: false, generated: false, lockfile: false,
        evidence: { state: 'available' as const, unifiedDiff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n` }, occurrences: [],
      })) }] };
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine_1', installationId: 'return-installation',
      tokenEpoch: 0, actionId: SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[0], requesterInvocation: 'credentials', execute: () => review });
    let answer: unknown = outcome === 'failed'
      ? { ok: false as const, errorCode: 'conflict_changed', error: 'conflict_changed', details: { appliedPaths, path: 'tree/both.txt' } }
      : { appliedPaths, conflicts };
    let applyReached = false;
    await answerExternalActionAccountForHome(homes, serverId, { machineId: 'machine_1', installationId: 'return-installation',
      tokenEpoch: 0, actionId: SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[1], requesterInvocation: 'optional',
      execute: () => { applyReached = true; return answer; },
      failure: value => { const parsed = ActionExecuteFailureSchema.safeParse(value); return parsed.success ? parsed.data : null; } });
    daemonAnswer = request => request.method.endsWith(`:${SESSION_WORKSPACE_RETURN_ACTION_IDS_V1[0]}`) ? review : answer;
    const { Modal, ModalProvider } = await import('@/modal');
    const { openProjectFilesReturn } = await import('@/components/sessions/files/turnChanges/projectFilesReturn/ProjectFilesReturnModal');
    const { t } = await import('@/text');
    Modal.hideAll();
    const screen = await renderScreen(React.createElement(ModalProvider));
    await act(async () => { openProjectFilesReturn({ sessionId: 'sess_parent', machineName: 'Original machine',
      source: { serverId, machineId: 'machine_1', rootPath: '/repo' } }); });
    await vi.waitFor(() => expect(screen.findByTestId('project-files-return.apply')).not.toBeNull());
    await act(async () => { await screen.pressByTestIdAsync('project-files-return.apply'); });
    await vi.waitFor(() => expect(applyReached, screen.getTextContent()).toBe(true));
    await vi.waitFor(() => expect(screen.findByTestId('project-files-return.applied')
      ?? screen.findAll(node => node.props.testID === 'project-files-return.apply' && node.props.loading === false)[0]).toBeDefined());
    if (outcome === 'failed') {
      await vi.waitFor(() => expect(screen.findByTestId('project-files-return.apply-failed')).not.toBeNull());
      expect(screen.getTextContent()).toContain(t('common.requestFailed'));
      expect(screen.getTextContent()).not.toContain(t('machineDetailPage.projectFiles.applyFailed'));
      for (const path of appliedPaths) expect(screen.getTextContent()).toContain(path);
      if (appliedPaths.length > 0) expect(screen.getTextContent()).toContain(t('machineDetailPage.projectFiles.changedCount', { count: appliedPaths.length }));
    } else {
      await vi.waitFor(() => expect(screen.findByTestId('project-files-return.use-sandbox.tree/both.txt')).not.toBeNull());
    }
    expect(screen.findByTestId('project-files-return.applied')).toBeNull();
    // The person explicitly replaces the remaining conflict, then finishes the same captured return.
    answer = { appliedPaths: ['tree/both.txt'], conflicts: [] };
    await act(async () => { await screen.pressByTestIdAsync('project-files-return.use-sandbox.tree/both.txt'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-files-return.use-sandbox.tree/both.txt')).toBeNull());
    answer = { appliedPaths: appliedPaths.length === 0 ? ['tree/first.txt', 'tree/nested/also.txt'] : [], conflicts: [] };
    await act(async () => { await screen.pressByTestIdAsync('project-files-return.apply'); });
    await vi.waitFor(() => expect(screen.findByTestId('project-files-return.applied')).not.toBeNull());
    expect(screen.getTextContent()).toContain(t('machineDetailPage.projectFiles.changedCount', { count: 3 }));
    await act(async () => { Modal.hideAll(); });
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
    await expect(executor().execute('session.handoff', { sessionId: 'sess_parent', targetMachineId: 'machine_2' },
      { ...context(), signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' });
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
    installHomeGovernanceBoundaries({ ...homes, request: createSessionReadBatchFetchBoundary(homes.request) });
    // Disconnect retires the source Home's local projection. Rehydrate it from
    // its real Home response rather than restoring the retired row by hand.
    const hydration = await sync.ensureSessionVisibleForMessageRoute('sess_parent', {
      serverId: parentServerId, forceRefresh: true, hydrateMessages: false,
    });
    expect(hydration, JSON.stringify(hydration)).toMatchObject({ kind: 'available', serverId: parentServerId });
    expect(homes.requestsFor('/v2/sessions/sess_parent?accessProjectionVersion=1'))
      .toContainEqual(expect.objectContaining({ serverId: parentServerId }));
    daemonAnswer = () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] }, workspace: { kind: 'none' } });
    const result = await executor({ resolveServerIdForSessionId: () => parentServerId }).execute('session.handoff',
      { sessionId: 'sess_parent', targetMachineId: 'machine_2' }, { ...context(), serverId: parentServerId });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)[0]?.params).toHaveProperty('accountServerId', parentServerId);
    // The handoff reads its Machines by id on the parent Home, not the include-revoked census (01f84d17e3).
    expect(homes.requestsFor('/v1/machines/read-batch')).toContainEqual(expect.objectContaining({
      serverId: parentServerId, input: expect.objectContaining({ machineIds: expect.arrayContaining(['machine_1']) }),
    }));
  });

  it('reaches the source daemon when the owner metadata projection is unavailable on this device', async () => {
    installOwnerMetadataUnavailableSession();
    daemonAnswer = () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] }, workspace: { kind: 'none' } });
    const result = await executor().execute('session.handoff', { sessionId: 'sess_parent', targetMachineId: 'machine_2' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)[0]?.params).toMatchObject({ sessionId: 'sess_parent', targetMachineId: 'machine_2' });
    expect(rpcRequests(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)[0]?.params).not.toHaveProperty('sessionStorageMode');
  });

  it('reaches the source daemon through the direct handoff entry point when the owner metadata projection is unavailable', async () => {
    installOwnerMetadataUnavailableSession();
    daemonAnswer = () => ({ handoffId: 'handoff_1', status: { handoffId: 'handoff_1', status: 'completed', phase: 'finalizing', recoveryActions: [] }, workspace: { kind: 'none' } });
    const result = await startSessionHandoff({ sessionId: 'sess_parent', targetMachineId: 'machine_2', serverId });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(rpcRequests(RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3)[0]?.params)
      .toMatchObject({ sessionId: 'sess_parent', targetMachineId: 'machine_2', accountServerId: serverId });
    expect(homes.requestsFor('/v1/machines/read-batch'))
      .toContainEqual(expect.objectContaining({ serverId, input: expect.objectContaining({ machineIds: expect.arrayContaining(['machine_1']) }) }));
  });

  it('reaches exact-mirror confirmation for a live replacement through the real preflight adapter', async () => {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const operationId = 'replace-live-link';
    const replaceRelationshipId = 'incumbent-link';
    // The target daemon is the network boundary. Its incumbent-custody lookup
    // needs the selected link identity before it can inspect this occupied root.
    daemonAnswer = request => {
      if (!request.method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`)) {
        throw new Error('Replacement must await destination confirmation before creation');
      }
      const payload = request.params;
      if (!payload || typeof payload !== 'object' || !('replaceRelationshipId' in payload)
        || payload.replaceRelationshipId !== replaceRelationshipId) {
        return { errorCode: 'workspace_root_in_use', error: 'Handoff target root overlaps an active operation' };
      }
      return { type: 'approval_required', approval: { v: 1,
        consequences: ['delete_target_only_files_during_exact_mirror'], serverId,
        machineId: 'machine_2', canonicalRoot: '/target/repo', rootFingerprint: 'a'.repeat(64), operationId } };
    };
    const result = await executor().execute('workspace.sync.relationship.replace', {
      v: 1, replaceRelationshipId, sourceWorkspaceRefId: 'workspace-source', targetMachineId: 'machine_2',
      targetPath: '/target/repo', mode: 'mirror_exactly', destinationIntent: 'use_existing',
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
    }, { ...context(), actionRequestId: operationId, bypassApprovals: true });
    // A new consequence cannot execute with bypassApprovals and no matching
    // receipt; importantly, the occupied incumbent root was inspected first.
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'approval_stale' });
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
      declaration: { title: 'External Grok adapter', runtime: { kind: 'custom' }, primary: 'sessions', capabilities: { ...grok.capabilities, sessions: sessionCapabilities,
        // Lifecycle support is the subject; the External Sessions surface would require its own source descriptor and contribution.
        surfaces: grok.capabilities.surfaces?.filter(surface => surface !== 'externalSessions') } },
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
            capabilitySelection: null, transcriptStorage: 'persisted', terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null } }),
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
