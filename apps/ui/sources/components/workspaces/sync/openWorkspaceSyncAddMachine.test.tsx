import { createWorkspaceSyncRelationshipsListFixture } from '@/dev/testkit/harness/workspaceSyncHarness';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandoffTargetReplacementPreflightV1Schema, WorkspaceSyncRelationshipCreateRpcRequestV1Schema,
    WorkspaceSyncRelationshipCreateResultV1Schema, computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema, ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionApi';

import { createMachineFixture, invokeTestInstanceHandler, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createWorkspaceSyncHarness, type WorkspaceSyncRpcRequest } from '@/dev/testkit/harness/workspaceSyncHarness';
import { projectWorkspaceSyncRelationshipSummaries, projectWorkspaceSyncRelationships } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';

const shownModal = vi.hoisted(() => vi.fn());
const confirmModal = vi.hoisted(() => vi.fn(async () => false));
const daemonRpc = vi.hoisted(() => vi.fn<(request: WorkspaceSyncRpcRequest) => unknown>());

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, vars) => vars ? key + ':' + JSON.stringify(vars) : key,
}));
vi.mock('@/modal', async () => {
    const boundary = (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        confirmResult: true, spies: { confirm: confirmModal },
    });
    shownModal.mockImplementation(boundary.spies.show);
    return { ...boundary.module, Modal: { ...boundary.module.Modal, show: shownModal } };
});

const workspace = createWorkspaceSyncHarness(request => daemonRpc(request));
await workspace.ready;
const { storage } = await import('@/sync/domains/state/storage');
const { MachineSelector } = await import('@/components/sessions/new/components/MachineSelector');
const { PathSelectionList } = await import('@/components/ui/pathPicker/PathSelectionList');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const owner = await import('./openWorkspaceSyncAddMachine');
const { WorkspaceSyncRelationshipRow } = await import('./WorkspaceSyncRelationshipList');

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

let pendingCreate = deferred<unknown>();
let pendingPreflight = deferred<unknown>();
let requireApproval = false;
let holdPreflight = false;
let targetFolder: 'nonempty' | 'empty' | 'missing' = 'nonempty';

const source = () => ({ id: 'source-ref', serverId: workspace.serverId, machineId: 'machine-a', rootPath: '/source' });
const callsFor = (method: string) => daemonRpc.mock.calls.map(([request]) => request).filter(request => request.method === method);

function targetApproval(request: WorkspaceSyncRpcRequest) {
    const input = HandoffTargetReplacementPreflightV1Schema.parse(request.payload);
    return { type: 'approval_required', approval: { v: 1,
        consequences: input.activatesExactMirror
            ? ['replace_nonempty_workspace_target', 'delete_target_only_files_during_exact_mirror']
            : ['replace_nonempty_workspace_target'],
        serverId: input.serverId, machineId: input.machineId, canonicalRoot: input.targetPath,
        rootFingerprint: 'a'.repeat(64), operationId: input.operationId,
    } };
}

function committedLink() {
    const request = callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)[0];
    if (!request) throw new Error('Expected a dispatched relationship creation');
    const { actionInput } = WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(request.payload);
    return WorkspaceSyncRelationshipCreateResultV1Schema.parse({ v: 1, relationshipId: 'created-relationship', created: true,
        controllerMachineId: 'machine-a', sourceWorkspaceRefId: actionInput.sourceWorkspaceRefId,
        targetWorkspaceRefId: 'target-ref', status: { relationshipId: 'created-relationship', controllerMachineId: 'machine-a',
            state: 'watching', alphaPath: '/source', betaPath: actionInput.targetPath, mode: actionInput.mode,
            endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: null },
    });
}

/**
 * The destination review the source Machine carried back and this UI presented. The receiving
 * daemon refuses the person's own press with that review instead of creating a self-approval
 * Artifact (docs/actions.md, `confirmOwnUiRefusal`), so no approval is ever persisted for it.
 */
function reviewedLink() {
    const reviews = shownModal.mock.calls.map(([config]) => config)
        .filter(config => config?.chrome?.testID === 'actions.confirmation-review.modal');
    expect(reviews).toHaveLength(1);
    expect(workspace.home.artifacts(workspace.serverId).list()).toEqual([]);
    const props = reviews[0]!.props as { actionId: string; actionArgs: unknown;
        preview: { handoffTargetReplacementApproval?: { consequences: readonly string[] } } };
    expect(props.actionId).toBe('workspace.sync.relationship.create');
    return props;
}

/**
 * Relationship writes and the destination folder probe are Home-dispatched to their Machine
 * (defaultActionExecutor `executeMachineOwnedAction`, filesystemActionDeps). The source
 * Machine's receiving Protocol executor owns destination admission: it runs the target
 * preflight and carries a required review back to the person's own press before the create
 * RPC. Home HTTP and Machine RPC stay the boundaries; UI sealing, Account admission and
 * Protocol review run for real on both sides.
 */
async function installSourceMachineActionReceiver() {
    const [{ createActionExecutor }, { createActionExecutorBoundaryFixture }, { readActionFailureEnvelope },
        { createExternalActionAccountHttpBoundary }, { captureLazyActionAccountContext },
        { preflightWorkspaceDestinationReplacement }, { createWorkspaceSyncRelationshipOnController }] = await Promise.all([
        import('@happier-dev/protocol/actions/actionExecutor'), import('@/dev/testkit/fixtures/actionExecutorBoundary'),
        import('@happier-dev/protocol/actions/executor/actionFailureEnvelope'),
        import('@/dev/testkit/harness/externalActionAccountHttpBoundary'), import('@/sync/ops/actions/actionAccountContext'),
        import('@/sync/ops/sessionHandoffs'), import('@/sync/ops/workspaceSyncRelationshipCreateRpc'),
    ]);
    const account = await captureLazyActionAccountContext(workspace.serverId);
    const serverIdentityId = account.serverIdentityId;
    if (!serverIdentityId) throw new Error('Expected the source Home identity');
    const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
        // The receiving Account allows linking; only a destination consequence requires review.
        isActionApprovalRequired: () => false,
        sessionHandoffTargetReplacementApprovalPreflight: ({ targetMachineId, targetPath, workspaceAction, activatesExactMirror,
            destinationIntent, replaceRelationshipId, serverId, operationId, signal }) => preflightWorkspaceDestinationReplacement({
            targetMachineId, targetPath: targetPath ?? '', serverId: serverId ?? '', operationId,
            workspaceAction: workspaceAction ?? { kind: 'none' },
            ...(activatesExactMirror === undefined ? {} : { activatesExactMirror }),
            ...(destinationIntent ? { destinationIntent } : {}),
            ...(replaceRelationshipId ? { replaceRelationshipId } : {}),
            ...(signal ? { signal } : {}),
        }),
        workspaceSyncRelationshipCreate: ({ input, operationId, serverId, targetReplacementApproval, targetReplacementApprovalReceiptId, signal }) =>
            createWorkspaceSyncRelationshipOnController({ input, operationId, serverId: serverId ?? null,
                ...(targetReplacementApproval && targetReplacementApprovalReceiptId
                    ? { targetReplacementApproval, targetReplacementApprovalReceiptId } : {}),
                ...(signal ? { signal } : {}) }),
    }));
    const settle = (execution: Awaited<ReturnType<typeof receiver.execute>>) => execution.ok ? execution.result : execution;
    const base = { serverUrl: account.endpointUrl, serverIdentityId, accountId: account.accountId, tokenEpoch: 0 };
    // One installed identity per Machine (every boundary derives it from the same key seed);
    // each Action path routes to the boundary its sealed envelope targets.
    const answerMachineAction = async (actionId: string, machineIds: readonly string[],
        create: (machineId: string) => ReturnType<typeof createExternalActionAccountHttpBoundary>) => {
        const boundaries = new Map<string, Awaited<ReturnType<typeof create>>>();
        for (const machineId of machineIds) {
            const boundary = await create(machineId);
            boundaries.set(machineId, boundary);
            workspace.home.answer(workspace.serverId, `GET /v1/machines/${machineId}`, { body: { machine: boundary.machine } });
        }
        for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
            workspace.home.answer(workspace.serverId, `POST ${path}`, { select: async (body, request) => {
                const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
                const target = ExternalActionRequestEnvelopeSchema.parse(authorized.success ? authorized.data.envelope : body).target;
                const boundary = target?.kind === 'machine' ? boundaries.get(target.machineId) : undefined;
                const response = await boundary?.handle(new URL(request.url), request.init);
                if (!response) throw new Error(`Unexpected Machine Action ${path} for ${JSON.stringify(target)}`);
                return { status: response.status, body: await response.json() };
            } });
        }
    };
    for (const actionId of ['workspace.sync.relationship.create', 'workspace.sync.relationship.replace'] as const) {
        await answerMachineAction(actionId, ['machine-a'], machineId => createExternalActionAccountHttpBoundary({ ...base, machineId, actionId,
            failure: readActionFailureEnvelope,
            execute: async (input, { target, invocation, authorization, requestId, signal }) => settle(await receiver.execute(actionId, input, {
                surface: invocation.surface, authority: invocation.authority, serverId: workspace.serverId, serverIdentityId,
                runtimeAccountId: account.accountId, actionCaller: invocation.caller, externalActionTarget: target,
                externalActionExecutionAuthorization: authorization,
                ...(invocation.presentUserConfirmation ? { presentUserConfirmation: invocation.presentUserConfirmation } : {}),
                ...(requestId ? { actionRequestId: requestId } : {}), ...(signal ? { signal } : {}) })) }));
    }
    // The destination folder probe is the destination daemon's own listing; its reply is the Action output.
    await answerMachineAction('daemon.filesystem.browseDirectory', ['machine-a', 'machine-b'], machineId => createExternalActionAccountHttpBoundary({
        ...base, machineId, actionId: 'daemon.filesystem.browseDirectory',
        execute: (input, { target, signal }) => daemonRpc({ machineId: target.machineId, method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
            payload: input, signal: signal ?? new AbortController().signal }) }));
    return account;
}

let sourceReceiverAccount: Awaited<ReturnType<typeof installSourceMachineActionReceiver>> | null = null;

beforeEach(async () => {
    await workspace.reset();
    const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    await adoptHomeProfile({ descriptor: { serverUrl: 'https://workspace-sync.test',
        homeServerIdentityId: 'srv_workspace_sync' }, source: 'manual' });
    shownModal.mockClear();
    confirmModal.mockReset().mockResolvedValue(false);
    daemonRpc.mockReset();
    pendingCreate = deferred();
    pendingPreflight = deferred();
    requireApproval = false;
    holdPreflight = false;
    targetFolder = 'nonempty';
    const machines = [['machine-a', 'Source', '/home/source'], ['machine-b', 'Target', '/home/target']].map(([id, displayName, homeDir]) => {
        // Both Machines are the person's own (Manage) unless a case says otherwise.
        const machine = createMachineFixture({ id, activeAt: Date.now(), isShared: false });
        return { ...machine, metadata: { ...machine.metadata!, displayName, homeDir } };
    });
    storage.getState().applyMachines(machines, true, { sourceServerId: workspace.serverId, sourceAccountId: workspace.accountId });
    storage.getState().markMachineListSettled(workspace.serverId);
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ ...source(), createdAtMs: 1 }], relationships: [] });
    workspace.home.answer(workspace.serverId, 'POST /v1/account/project-rows/list', { body:
        createPlainProjectAccountRowListFixture({ workspaceRefs: [{ ...source(), createdAtMs: 1 }] }) });
    sourceReceiverAccount = await installSourceMachineActionReceiver();
    daemonRpc.mockImplementation(request => {
        if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT) {
            return holdPreflight ? pendingPreflight.promise : requireApproval ? targetApproval(request) : { type: 'not_required' };
        }
        if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE) return pendingCreate.promise;
        if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
            const input = request.payload as { path: string };
            if (targetFolder === 'missing') return { ok: false, error: `ENOENT: no such file or directory, scandir '${input.path}'` };
            const entries = targetFolder === 'nonempty' ? [{ name: '.git', path: `${input.path}/.git`, type: 'directory' }] : [];
            return { ok: true, path: input.path, entries, truncated: false };
        }
        if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST) return {
            ...createWorkspaceSyncRelationshipsListFixture([], request.machineId),
            ...((request.payload as { requesterAvailability?: true }).requesterAvailability ? {
                requesterAvailability: { kind: 'available', homeDir: request.machineId === 'machine-a' ? '/home/source' : '/home/target', workspaceRoot: null },
            } : {}),
        };
        throw new Error('Unexpected workspace sync RPC ' + request.method);
    });
});

afterEach(async () => {
    standardCleanup();
    sourceReceiverAccount?.dispose();
    sourceReceiverAccount = null;
    await workspace.dispose();
});

async function renderOpenedModal() {
    const config = shownModal.mock.calls[0]?.[0];
    expect(config).toBeTruthy();
    const onClose = vi.fn();
    const setChrome = vi.fn();
    const screen = await renderScreen(React.createElement(config.component, { ...config.props, onClose, setChrome }));
    const submit = () => {
        const footer = setChrome.mock.lastCall?.[0]?.footer as React.ReactElement<{ children?: React.ReactNode }>;
        const button = React.Children.toArray(footer.props.children).find(child => React.isValidElement(child)
            && (child.props as { testID?: string }).testID === 'workspace-sync-add-machine-submit');
        if (!React.isValidElement<{ onPress: () => void; disabled: boolean }>(button)) throw new Error('Expected the Add machine submit control');
        return button;
    };
    return { config, onClose, screen, submit };
}

const statusLine = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(SurfaceStateCard)
    .find(node => node.props.testID === 'workspace-sync-add-machine-status');

async function chooseTarget(screen: Awaited<ReturnType<typeof renderScreen>>, path = '/target', machineId = 'machine-b') {
    const target = storage.getState().machines[machineId];
    await act(async () => { invokeTestInstanceHandler(screen.findByType(MachineSelector), 'onSelect', target); });
    await act(async () => { invokeTestInstanceHandler(screen.findByType(PathSelectionList), 'onCommit', path); });
}

async function startAddMachineLink(options: Readonly<{
    configure?: (screen: Awaited<ReturnType<typeof renderScreen>>) => Promise<void>;
    waitFor?: string;
}> = {}) {
    owner.openWorkspaceSyncAddMachine(source(), vi.fn());
    const modal = await renderOpenedModal();
    await chooseTarget(modal.screen);
    await options.configure?.(modal.screen);
    await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
    await act(async () => { modal.submit().props.onPress(); });
    await vi.waitFor(() => expect(callsFor(options.waitFor ?? RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE), modal.screen.getTextContent()).toHaveLength(1));
    return modal;
}

describe('Project Add machine modal', () => {
    it.each(['machine-a', 'machine-b'])('withdraws the previous requester root while %s changes isolation policy', async changedMachineId => {
        const incumbent = daemonRpc.getMockImplementation()!;
        let policyReply: ReturnType<typeof deferred<unknown>> | null = null;
        daemonRpc.mockImplementation(request => request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST
            && (request.payload as { requesterAvailability?: true }).requesterAvailability && request.machineId === changedMachineId && policyReply
            ? policyReply.promise : incumbent(request));
        owner.openWorkspaceSyncAddMachine(source(), vi.fn());
        const modal = await renderOpenedModal();
        await chooseTarget(modal.screen, '~/copy');
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        policyReply = deferred<unknown>();
        await act(async () => {
            const machines = Object.values(storage.getState().machines).map(machine => machine.id === changedMachineId
                ? { ...machine, metadata: { ...machine.metadata!, agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' as const } } } : machine);
            storage.getState().applyMachines(machines, true, { sourceServerId: workspace.serverId, sourceAccountId: workspace.accountId });
        });
        expect(modal.submit().props.disabled).toBe(true);
        if (changedMachineId === 'machine-b') expect(modal.screen.findByType(PathSelectionList).props.machineId).toBeNull();
        await act(async () => policyReply!.resolve({ ...createWorkspaceSyncRelationshipsListFixture([], changedMachineId),
            requesterAvailability: { kind: 'available', homeDir: '/new-policy/home', workspaceRoot: '/new-policy/workspace' } }));
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        if (changedMachineId === 'machine-b') expect(modal.screen.findByType(PathSelectionList).props.machineHomeDir).toBe('/new-policy/home');
    });

    it.each(['machine-a', 'machine-b'])('keeps creation unavailable when %s has no requester authority', async unavailableMachineId => {
        const incumbent = daemonRpc.getMockImplementation()!;
        daemonRpc.mockImplementation(request => request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST
            && (request.payload as { requesterAvailability?: true }).requesterAvailability && request.machineId === unavailableMachineId
            ? { ...createWorkspaceSyncRelationshipsListFixture([], request.machineId), requesterAvailability: { kind: 'unavailable', reason: 'requester_authority_unavailable' } }
            : incumbent(request));
        owner.openWorkspaceSyncAddMachine(source(), vi.fn());
        const modal = await renderOpenedModal();
        await chooseTarget(modal.screen);
        await vi.waitFor(() => expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST)
            .filter(request => (request.payload as { requesterAvailability?: true }).requesterAvailability)).toHaveLength(2));
        expect(modal.submit().props.disabled).toBe(true);
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toHaveLength(0);
    });

    it('offers Add Machine for a cold destination using the native owner directories', async () => {
        const incumbent = daemonRpc.getMockImplementation()!;
        daemonRpc.mockImplementation(request => request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST
            && (request.payload as { requesterAvailability?: true }).requesterAvailability ? {
                ...createWorkspaceSyncRelationshipsListFixture([], request.machineId),
                requesterAvailability: { kind: 'available', homeDir: `/members/${request.machineId}`,
                    workspaceRoot: `/members/${request.machineId}/workspace`, preparation: 'member_not_prepared' },
            } : incumbent(request));
        owner.openWorkspaceSyncAddMachine({ ...source(), rootPath: '/members/machine-a/project' }, vi.fn());
        const modal = await renderOpenedModal();
        await chooseTarget(modal.screen, '~/copy');
        await vi.waitFor(() => expect(modal.screen.findByType(PathSelectionList).props.machineHomeDir).toBe('/members/machine-b'));
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toHaveLength(0);
    });

    it('uses requester roots for both endpoints and reads each presented target once despite resource publications', async () => {
        const incumbent = daemonRpc.getMockImplementation()!;
        daemonRpc.mockImplementation(request => {
            if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST
                && (request.payload as { requesterAvailability?: true }).requesterAvailability) return {
                ...createWorkspaceSyncRelationshipsListFixture([], request.machineId),
                requesterAvailability: { kind: 'available', homeDir: `/members/${request.machineId}`, workspaceRoot: `/members/${request.machineId}/workspace` },
            };
            return incumbent(request);
        });
        const availabilityCalls = () => callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST)
            .filter(request => (request.payload as { requesterAvailability?: true }).requesterAvailability);
        expect(availabilityCalls()).toHaveLength(0);
        owner.openWorkspaceSyncAddMachine({ ...source(), rootPath: '/members/machine-a/project' }, vi.fn());
        const modal = await renderOpenedModal();
        await chooseTarget(modal.screen, '');
        await vi.waitFor(() => expect(modal.screen.findByType(PathSelectionList).props.machineHomeDir).toBe('/members/machine-b'));
        await act(async () => { invokeTestInstanceHandler(modal.screen.findByTestId('path-selection-list:open-tree-browser')!, 'onPress'); });
        await vi.waitFor(() => expect(shownModal).toHaveBeenCalledTimes(2));
        const browser = shownModal.mock.calls[1]![0];
        expect(browser.props).toMatchObject({ machineId: 'machine-b', initialPath: '/members/machine-b/workspace' });
        await act(async () => browser.props.onResolve(null));
        await act(async () => invokeTestInstanceHandler(modal.screen.findByType(PathSelectionList), 'onCommit', '~/copy'));
        expect(modal.screen.getTextContent()).toContain('workspaceSync.endpoint.source:{"label":"~/project"}');
        expect(availabilityCalls().map(request => request.machineId).sort()).toEqual(['machine-a', 'machine-b']);
        for (let index = 0; index < 3; index++) await act(async () => {
            const machines = Object.values(storage.getState().machines).map(machine => ({ ...machine, activeAt: Date.now() + index }));
            storage.getState().applyMachines(machines, true, { sourceServerId: workspace.serverId, sourceAccountId: workspace.accountId });
        });
        expect(availabilityCalls()).toHaveLength(2);
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        await act(async () => modal.submit().props.onPress());
        await vi.waitFor(() => expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toHaveLength(1));
        expect(WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)[0]!.payload).actionInput.targetPath)
            .toBe('/members/machine-b/copy');
        await act(async () => pendingCreate.resolve(committedLink()));
    });

    it('replaces a selected link only after confirmation, keeping its folders and content exclusions', async () => {
        const base = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: ['private/**'], extraIncludePatterns: [] };
        const contentPolicy = { ...base, policyDigest: computeWorkspaceSyncPolicyDigest(base) };
        const refs = [{ ...source(), createdAtMs: 1 },
            { id: 'target-ref', serverId: workspace.serverId, machineId: 'machine-b', rootPath: '/target', createdAtMs: 1 }];
        const relationship = { v: 1 as const, relationshipId: 'old-link', controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: source().id, betaWorkspaceRefId: 'target-ref', mode: 'keep_synced' as const,
            contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: refs, relationships: [relationship] });
        const [summary] = projectWorkspaceSyncRelationshipSummaries({ relationships: projectWorkspaceSyncRelationships([relationship]),
            workspaceRefs: refs, statuses: [], serverId: workspace.serverId });
        expect(summary).toBeTruthy();
        const row = await renderScreen(React.createElement(WorkspaceSyncRelationshipRow, { summary: summary! }));
        const menu = row.findByType(DropdownMenu);
        expect(menu.props.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'replace' })]));
        await act(async () => invokeTestInstanceHandler(menu, 'onSelect', 'replace'));
        await vi.waitFor(() => expect(shownModal).toHaveBeenCalledOnce());
        const modal = await renderOpenedModal();
        expect(modal.screen.findAllByType(PathSelectionList)).toHaveLength(0);
        expect(modal.screen.findAllByType(MachineSelector)).toHaveLength(0);
        const mode = modal.screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.title === 'sessionHandoff.targetApproval.modeLabel');
        await act(async () => invokeTestInstanceHandler(mode!, 'onSelect', 'keep_both_in_sync'));
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        await act(async () => { modal.submit().props.onPress(); });
        await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
        confirmModal.mockResolvedValue(true);
        await act(async () => { modal.submit().props.onPress(); });
        await vi.waitFor(() => expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toHaveLength(1));
        const request = WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)[0]!.payload);
        expect(request.actionInput).toMatchObject({ replaceRelationshipId: 'old-link', sourceWorkspaceRefId: source().id,
            targetMachineId: 'machine-b', targetPath: '/target', mode: 'keep_both_in_sync', destinationIntent: 'use_existing', contentPolicy });
        await act(async () => pendingCreate.resolve(committedLink()));
    });
    it.each(['/source', '/home/source/project', undefined])('opens a missing-worker-copy refusal from accepted checkout %s, leaving the target path for the user to choose', async rootPath => {
        requireApproval = true;
        expect(owner.openWorkspaceSyncWorkerCopySetup({ serverId: source().serverId, machineId: source().machineId,
            workspaceId: source().id, ...(rootPath === undefined ? {} : { rootPath }) }, {
            kind: 'no_worker_can_accept', reason: 'worker_copy_missing', unavailable: 'ask',
            workerCopy: { serverId: workspace.serverId, sourceWorkspaceRefId: source().id,
                sourceMachineId: 'machine-a', targetMachineId: 'machine-b' },
        }, vi.fn())).toBe(true);
        const modal = await renderOpenedModal();
        expect(modal.screen.findByType(MachineSelector).props.selectedMachine?.id).toBe('machine-b');
        expect(modal.screen.findByType(PathSelectionList).props.initialValue).toBe('');
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
        await act(async () => invokeTestInstanceHandler(modal.screen.findByType(PathSelectionList), 'onCommit', '/chosen-worker'));
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        await act(async () => { modal.submit().props.onPress(); });
        await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
        expect(reviewedLink().actionArgs).toMatchObject({ sourceWorkspaceRefId: source().id, targetMachineId: 'machine-b',
            targetPath: '/chosen-worker', purpose: 'worker_clean_copy', mode: 'keep_synced', destinationIntent: 'materialize_from_source_workspace' });
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
    });

    it('does not open setup for stale source facts or an unrelated refusal', () => {
        const address = { ...source(), workspaceId: source().id };
        expect(owner.openWorkspaceSyncWorkerCopySetup(address, { kind: 'no_worker_can_accept', reason: 'not_accepting', unavailable: 'ask' }, vi.fn())).toBe(false);
        expect(owner.openWorkspaceSyncWorkerCopySetup(address, { kind: 'no_worker_can_accept', reason: 'worker_copy_missing', unavailable: 'ask',
            workerCopy: { serverId: 'another-home', sourceWorkspaceRefId: source().id, sourceMachineId: 'machine-a', targetMachineId: 'machine-b' } }, vi.fn())).toBe(false);
        expect(shownModal).not.toHaveBeenCalled();
    });

    it('names the source folder relative to its machine home', async () => {
        owner.openWorkspaceSyncAddMachine({ ...source(), rootPath: '/home/source/project' }, vi.fn());
        const { screen } = await renderOpenedModal();
        expect(screen.getTextContent()).toContain('workspaceSync.endpoint.source:{"label":"~/project"}');
        expect(screen.getTextContent()).toContain('Source');
        expect(screen.getTextContent()).not.toContain('/home/source/project');
    });

    it('preserves the shared raw policy draft and submits exact-replica destination intent', async () => {
        requireApproval = true;
        await startAddMachineLink({ waitFor: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, configure: async screen => {
            const selectMenu = async (title: string, value: string) => {
                const menu = screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.title === title);
                expect(menu).toBeTruthy();
                await act(async () => invokeTestInstanceHandler(menu!, 'onSelect', value));
            };
            await selectMenu('sessionHandoff.targetApproval.modeLabel', 'mirror_exactly');
            await selectMenu('workspaceSync.addMachine.folderSetup', 'materialize_from_source_workspace');
            const advanced = screen.findAll(node => node.props.title === 'settingsSession.handoff.advanced.title'
                && typeof node.props.onPress === 'function')[0];
            expect(advanced).toBeTruthy();
            await pressTestInstanceAsync(advanced!, 'show advanced workspace policy');
            await selectMenu('settingsSession.handoff.contentSelection.title', 'all_files');
            await selectMenu('settingsSession.handoff.includeIgnoredMode.title', 'include_selected');
            const field = () => screen.find(node => typeof node.type === 'string'
                && node.props.accessibilityLabel === 'settingsSession.handoff.includeIgnoredMode.globsTitle');
            for (const draft of ['dist/**,', 'dist/**, ', 'dist/**, .env.local']) {
                await act(async () => invokeTestInstanceHandler(field(), 'onChangeText', draft));
                expect(field().props.value).toBe(draft);
            }
        } });
        await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
        expect(reviewedLink().actionArgs).toMatchObject({ mode: 'mirror_exactly', destinationIntent: 'materialize_from_source_workspace',
            contentPolicy: { selection: 'all_files', extraIncludePatterns: ['dist/**', '.env.local'] } });
        // The exact-mirror deletion consequence travels in the reviewed preview the consequences card presents.
        expect(reviewedLink().preview.handoffTargetReplacementApproval?.consequences)
            .toEqual(['replace_nonempty_workspace_target', 'delete_target_only_files_during_exact_mirror']);
    });

    describe('Use existing folder for a Git source', () => {
        const unavailable = 'settingsSession.handoff.targetBootstrap.useExistingUnavailable';
        const destinationMenu = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllByType(DropdownMenu)
            .find(node => node.props.itemTrigger?.title === 'workspaceSync.addMachine.folderSetup')!;
        const useExisting = (screen: Awaited<ReturnType<typeof renderScreen>>) => (destinationMenu(screen).props.items as ReadonlyArray<{ id: string; disabled?: boolean; subtitle?: string }>)
            .find(item => item.id === 'use_existing')!;

        it.each(['missing', 'empty'] as const)('disables it for a %s folder with its reason and prepares the folder instead', async (state) => {
            targetFolder = state;
            requireApproval = true;
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen);
            await vi.waitFor(() => expect(useExisting(modal.screen)).toMatchObject({ disabled: true, subtitle: unavailable }));
            expect(destinationMenu(modal.screen).props.selectedId).toBe('materialize_from_source_workspace');
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            await act(async () => { modal.submit().props.onPress(); });
            await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
            expect(reviewedLink().actionArgs).toMatchObject({ targetPath: '/target', destinationIntent: 'materialize_from_source_workspace' });
        });

        it('keeps Use existing folder for a non-empty folder', async () => {
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen);
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            expect(useExisting(modal.screen).disabled).toBeFalsy();
            expect(destinationMenu(modal.screen).props.selectedId).toBe('use_existing');
        });

        it('keeps Use existing folder for an empty folder when the link is not a Git selection', async () => {
            targetFolder = 'empty';
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen);
            await vi.waitFor(() => expect(useExisting(modal.screen).disabled).toBe(true));
            const advanced = modal.screen.findAll(node => node.props.title === 'settingsSession.handoff.advanced.title'
                && typeof node.props.onPress === 'function')[0]!;
            await pressTestInstanceAsync(advanced, 'show advanced workspace policy');
            const content = modal.screen.findAllByType(DropdownMenu).find(node => node.props.itemTrigger?.title === 'settingsSession.handoff.contentSelection.title')!;
            await act(async () => invokeTestInstanceHandler(content, 'onSelect', 'all_files'));
            await vi.waitFor(() => expect(useExisting(modal.screen).disabled).toBeFalsy());
            expect(destinationMenu(modal.screen).props.selectedId).toBe('use_existing');
        });
    });

    it('says a typed daemon refusal of the link in product words, not the daemon message', async () => {
        confirmModal.mockResolvedValueOnce(true);
        const modal = await startAddMachineLink();
        await act(async () => {
            pendingCreate.resolve({ error: 'Workspace sync relationship is not ready', errorCode: 'relationship_not_ready' });
        });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.error.needsAttention'));
        expect(modal.screen.getTextContent()).not.toContain('Workspace sync relationship is not ready');
        // One status line, in the failure tone and announced as an alert.
        expect(statusLine(modal.screen)?.props).toMatchObject({ kind: 'error', accessibilitySemantics: 'alert' });
    });

    it('retains a recorded approval execution failure through the actual Sync adapter', async () => {
        const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const { buildApprovalRequestArtifactHeaderV1 } = await import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1');
        const { createPlainArtifactHttpFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const { approveWorkspaceSyncRelationshipCreate } = await import('@/sync/ops/workspaceSyncRelationshipCreate');
        const { presentWorkspaceSyncFailure } = await import('@/sync/domains/sessionHandoff/workspaceSyncPresentation');
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'failed', createdAtMs: 1, updatedAtMs: 3,
            createdBy: { surface: 'agent' }, requestedSurface: 'agent', actionId: 'workspace.sync.relationship.create',
            actionArgs: { sourceWorkspaceRefId: 'source-ref', targetMachineId: 'machine-b', targetPath: '/target' },
            summary: 'Link Workspace', executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                caller: { kind: 'host' }, serverId: workspace.serverId, serverIdentityId: 'srv_workspace_sync',
                accountId: workspace.accountId, actionId: 'workspace.sync.relationship.create', requestId: 'recorded-sync' },
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: { executedAtMs: 3, ok: false, errorCode: 'credential_scope_denied', error: 'private /secret/workspace',
                details: { reason: 'target_not_authorized', privatePath: '/secret/workspace' },
                failureCause: { phase: 'target.preflight', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: null } } });
        workspace.home.artifacts(workspace.serverId).replaceStoredRow(createPlainArtifactHttpFixture({
            id: 'failed-sync', isDecrypted: true, header: buildApprovalRequestArtifactHeaderV1(request),
            body: JSON.stringify(request), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 3,
        }, workspace.accountId));
        let failure: unknown;
        try { await approveWorkspaceSyncRelationshipCreate({ artifactId: 'failed-sync', serverId: workspace.serverId }); }
        catch (caught) { failure = caught; }
        expect(failure).toMatchObject({ code: 'credential_scope_denied' });
        const message = presentWorkspaceSyncFailure(failure);
        expect(message).toContain('machine_manage_required');
        // Recorded approval reads intentionally omit opaque, non-contract details.
        expect(failure).toMatchObject({ failureCause: request.execution?.failureCause });
        expect(message).not.toContain('/secret/workspace');
    });

    it.each(['source attach', 'destination open'])('retains an HTTP Action refusal through %s to the modal', async path => {
        const presentation = await import('@/sync/domains/sessionHandoff/workspaceSyncPresentation');
        const presentFailure = vi.spyOn(presentation, 'presentWorkspaceSyncFailure');
        let requestId = '';
        workspace.home.answer(workspace.serverId, 'POST /v1/actions/projects.open', { select: body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            requestId = request.requestId;
            return { status: 403, body: ExternalActionHttpErrorSchema.parse({ error: 'credential_scope_denied',
                requestId, details: { reason: 'target_not_authorized', privatePath: '/secret/workspace' },
                failureCause: { phase: 'target.preflight', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: null } }) };
        } });
        if (path === 'destination open') await act(async () => {
            const machines = Object.values(storage.getState().machines).map(machine => machine.id === 'machine-b'
                ? { ...machine, isShared: true, access: { custodian: { accountId: 'guest-owner', displayName: 'Guest owner' },
                    role: 'use' as const, resourceMode: 'plain' as const, accessState: 'ready' as const } } : machine);
            storage.getState().applyMachines(machines, true, { sourceServerId: workspace.serverId, sourceAccountId: workspace.accountId });
        });
        const { id: _linked, ...unlinked } = source();
        owner.openWorkspaceSyncAddMachine(path === 'source attach' ? unlinked : source(), vi.fn());
        const modal = await renderOpenedModal();
        await chooseTarget(modal.screen);
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        await act(async () => { modal.submit().props.onPress(); });
        await vi.waitFor(() => expect(workspace.home.requestsFor('/v1/actions/projects.open')).toHaveLength(1));
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('machine_manage_required'));
        expect(ExternalActionRequestEnvelopeV1Schema.parse(workspace.home.requestsFor('/v1/actions/projects.open')[0]!.input).input).toMatchObject({ materialization: { kind: path === 'source attach' ? 'attach' : 'sync' } });
        expect(requestId).not.toBe('');
        expect(presentFailure.mock.calls.some(([failure]) =>
            typeof failure === 'object' && failure !== null && 'requestId' in failure && failure.requestId === requestId)).toBe(true);
        expect(modal.screen.getTextContent()).not.toContain(requestId);
        expect(modal.screen.getTextContent()).toContain('target_not_authorized');
        expect(modal.screen.getTextContent()).not.toContain('/secret/workspace');
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
    });

    it('settles a declined destination review without running the link or reporting failure', async () => {
        requireApproval = true;
        owner.openWorkspaceSyncAddMachine(source(), vi.fn());
        const modal = await renderOpenedModal();
        await chooseTarget(modal.screen);
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        await act(async () => { modal.submit().props.onPress(); });
        await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        // A declined review ran nothing and nothing failed: no pending Artifact, no status to report.
        expect(statusLine(modal.screen)).toBeUndefined();
        expect(reviewedLink().actionArgs).toMatchObject({ sourceWorkspaceRefId: source().id, targetPath: '/target' });
        expect(modal.screen.getTextContent()).not.toContain('approval_canceled');
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
    });

    it('keeps an acknowledged committed result visible when the modal is dismissed', async () => {
        confirmModal.mockResolvedValueOnce(true);
        const modal = await startAddMachineLink();
        await act(async () => { pendingCreate.resolve(committedLink()); });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.state.watching'));
        expect(statusLine(modal.screen)?.props).toMatchObject({ kind: 'success', accessibilitySemantics: 'status' });
        expect(modal.config.onDismissRequest('shared')).toBe(true);
        expect(modal.onClose).not.toHaveBeenCalled();
    });

    it('keeps an in-flight link visible and requires inspection when cancellation wins before a late committed reply', async () => {
        confirmModal.mockResolvedValueOnce(true);
        const modal = await startAddMachineLink();
        expect(modal.config.onDismissRequest('action')).toBe(false);
        expect(modal.onClose).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)[0]?.signal.aborted).toBe(true));
        await act(async () => { pendingCreate.resolve(committedLink()); });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.error.needsAttention'));
        expect(modal.screen.getTextContent()).not.toContain('workspaceSync.state.watching');
        expect(confirmModal).not.toHaveBeenCalled();
    });

    it('does not create or open approval after cancellation wins destination admission', async () => {
        holdPreflight = true;
        const modal = await startAddMachineLink({ waitFor: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT });
        expect(modal.config.onDismissRequest('shared')).toBe(false);
        const preflight = callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)[0]!;
        await act(async () => { pendingPreflight.resolve(targetApproval(preflight)); });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.error.needsAttention'));
        expect(confirmModal).not.toHaveBeenCalled();
        expect(workspace.home.artifacts(workspace.serverId).list()).toEqual([]);
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
    });

    it('uses the source Home while another Home is focused and reacts only to its Account reachability', async () => {
        const otherHome = await workspace.home.addHome({ name: 'Other Home', serverUrl: 'https://other-workspace.test', accountId: 'other-account' });
        const { recordMachineRequestFailed, recordMachineRequestSucceeded } = await import('@/sync/domains/machines/reachability/machineReachability');
        recordMachineRequestFailed({ serverId: otherHome, accountId: 'other-account', machineId: 'machine-b' });
        owner.openWorkspaceSyncAddMachine(source(), vi.fn());
        const modal = await renderOpenedModal();
        const menu = () => modal.screen.findByType(MachineSelector).findByType(DropdownMenu);
        await vi.waitFor(() => expect(menu().props.items.find((item: { id: string }) => item.id === 'machine-b')?.disabled).toBe(false));
        await chooseTarget(modal.screen);
        await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
        await act(async () => { recordMachineRequestFailed({ serverId: workspace.serverId, accountId: 'other-account', machineId: 'machine-b' }); });
        expect(modal.submit().props.disabled).toBe(false);
        await act(async () => { recordMachineRequestFailed({ serverId: workspace.serverId, accountId: workspace.accountId, machineId: 'machine-b' }); });
        expect(modal.submit().props.disabled).toBe(true);
        await act(async () => { modal.submit().props.onPress(); });
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)).toEqual([]);
        await act(async () => { recordMachineRequestSucceeded({ serverId: workspace.serverId, accountId: workspace.accountId, machineId: 'machine-b' }); });
        expect(modal.submit().props.disabled).toBe(false);
    });

    describe('same-Machine destination', () => {
        const blocked = 'workspaceSync.start.blocked.destinationFolder';
        const chooseOwnMachine = async (path: string) => {
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen, path, 'machine-a');
            return modal;
        };

        it('lists the source Machine, labelled as this machine', async () => {
            owner.openWorkspaceSyncAddMachine(source(), vi.fn());
            const modal = await renderOpenedModal();
            const items: ReadonlyArray<{ id: string; subtitle?: string }> = modal.screen.findByType(MachineSelector).findByType(DropdownMenu).props.items;
            expect(items.find(item => item.id === 'machine-a')?.subtitle).toContain('workspaceSync.addMachine.thisMachine');
            expect(items.find(item => item.id === 'machine-b')?.subtitle ?? '').not.toContain('workspaceSync.addMachine.thisMachine');
        });

        it.each(['/source', '/source/', '/source//nested', '\\source\\nested'])('blocks %s as equal to the source root or inside it', async (path) => {
            const modal = await chooseOwnMachine(path);
            expect(modal.submit().props).toMatchObject({ disabled: true, accessibilityHint: blocked });
        });

        it('creates the link on the same Machine for a distinct sibling folder', async () => {
            requireApproval = true;
            const modal = await chooseOwnMachine('/source-copy');
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            await act(async () => { modal.submit().props.onPress(); });
            await vi.waitFor(() => expect(confirmModal).toHaveBeenCalledOnce());
            expect(reviewedLink().actionArgs).toMatchObject({ sourceWorkspaceRefId: source().id, targetMachineId: 'machine-a', targetPath: '/source-copy' });
        });
    });

    describe('refusing to attach the source checkout', () => {
        const attachSource = async (outcome: unknown) => {
            // The real UI Action host delegates Open admission to the named Home.
            // Answer that HTTP boundary, including its correlated Action envelope.
            const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
            await adoptHomeProfile({ descriptor: { serverUrl: 'https://workspace-sync.test',
                homeServerIdentityId: 'srv_workspace_sync' }, source: 'manual' });
            workspace.home.answer(workspace.serverId, 'POST /v1/actions/projects.open', { select: body => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
                if (outcome instanceof Error) return { status: 503, body: { error: 'server_unavailable' } };
                return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.open',
                    requestId: request.requestId, execution: { ok: true, result: outcome } }) };
            } });
            const { id: _linked, ...unlinked } = source();
            owner.openWorkspaceSyncAddMachine(unlinked, vi.fn());
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen);
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            await act(async () => { modal.submit().props.onPress(); });
            return modal;
        };

        it('names an unreachable source Machine instead of a generic save failure', async () => {
            const modal = await attachSource({ kind: 'refused', code: 'machine_unreachable' });
            await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.start.blocked.targetMachineOffline'));
            expect(workspace.home.requestsFor('/v1/actions/projects.open')).toHaveLength(1);
            expect(modal.screen.getTextContent()).not.toContain('common.saveError');
            expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
        });

        it('retains the Action failure code without a Project Open refusal', async () => {
            const modal = await attachSource(new Error('server_unreachable'));
            await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('server_unavailable'));
            expect(workspace.home.requestsFor('/v1/actions/projects.open')).toHaveLength(1);
        });
    });

    describe('Can use destination (owner ruling 2026-11-14)', () => {
        const memberRoot = '/members/machine-b/workspace';
        const openRequests = () => workspace.home.requestsFor('/v1/actions/projects.open');
        const shareTargetAsUse = (machineId = 'machine-b') => act(async () => {
            const machines = Object.values(storage.getState().machines).map(machine => machine.id === machineId
                ? { ...machine, isShared: true, access: { custodian: { accountId: 'guest-owner', displayName: 'Guest owner' },
                    role: 'use' as const, resourceMode: 'plain' as const, accessState: 'ready' as const } } : machine);
            storage.getState().applyMachines(machines, true, { sourceServerId: workspace.serverId, sourceAccountId: workspace.accountId });
        });
        const answerOpen = async (result: unknown) => {
            const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
            await adoptHomeProfile({ descriptor: { serverUrl: 'https://workspace-sync.test',
                homeServerIdentityId: 'srv_workspace_sync' }, source: 'manual' });
            workspace.home.answer(workspace.serverId, 'POST /v1/actions/projects.open', { select: body => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
                return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.open',
                    requestId: request.requestId, execution: { ok: true, result } }) };
            } });
        };
        const openUseDestination = async (options: Parameters<typeof owner.openWorkspaceSyncAddMachine>[2] = {}, machineId = 'machine-b') => {
            const root = `/members/${machineId}/workspace`;
            const incumbent = daemonRpc.getMockImplementation()!;
            daemonRpc.mockImplementation(request => request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST
                && (request.payload as { requesterAvailability?: true }).requesterAvailability && request.machineId === machineId ? {
                    ...createWorkspaceSyncRelationshipsListFixture([], request.machineId),
                    requesterAvailability: { kind: 'available', homeDir: `/members/${machineId}`, workspaceRoot: root,
                        preparation: 'member_not_prepared' },
                } : incumbent(request));
            await shareTargetAsUse(machineId);
            owner.openWorkspaceSyncAddMachine(source(), vi.fn(), options);
            const modal = await renderOpenedModal();
            await chooseTarget(modal.screen, `${root}/copy`, machineId);
            return modal;
        };

        it('creates the link by opening the source Workspace into the own folder on that Machine', async () => {
            await answerOpen({ kind: 'opened', directory: `${memberRoot}/copy`, setup: 'notRequired',
                workspace: { serverId: workspace.serverId, workspaceId: 'copy', machineId: 'machine-b', rootPath: `${memberRoot}/copy` } });
            const modal = await openUseDestination();
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            await act(async () => { modal.submit().props.onPress(); });
            await vi.waitFor(() => expect(openRequests()).toHaveLength(1));
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(openRequests()[0]!.input);
            expect(envelope.input).toMatchObject({ serverId: workspace.serverId, machineId: 'machine-b',
                source: { kind: 'workspace', workspaceId: source().id },
                materialization: { kind: 'sync', targetPath: `${memberRoot}/copy`,
                    workspaceAction: { kind: 'create_relationship', mode: 'keep_synced', flushBeforeCommit: true } } });
            await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.state.watching'));
            expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
            expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)).toEqual([]);
        });

        it.each([
            ['workspace_private_checkout_review_required', 'workspaceSync.error.ownFolderOnly'],
            ['target_not_empty', 'workspaceSync.error.destinationNeedsPreparation'],
        ])('says the typed %s refusal in product words', async (code, key) => {
            await answerOpen({ kind: 'refused', code, effectAttempted: false });
            const modal = await openUseDestination();
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            await act(async () => { modal.submit().props.onPress(); });
            await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain(key));
            expect(statusLine(modal.screen)?.props).toMatchObject({ kind: 'error' });
            expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
        });

        it.each(['machine-b', 'machine-a'])('says a worker clean copy needs Manage instead of offering it (%s)', async machineId => {
            const modal = await openUseDestination({ targetMachineId: machineId, purpose: 'worker_clean_copy' }, machineId);
            await vi.waitFor(() => expect(modal.submit().props).toMatchObject({ disabled: true,
                accessibilityHint: 'workspaceSync.error.manageRequired' }));
            expect(openRequests()).toEqual([]);
            expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
        });

        it('opens a sibling own folder on the Can use source Machine instead of the Manage-only relationship', async () => {
            const root = '/members/machine-a/workspace';
            await answerOpen({ kind: 'opened', directory: `${root}/copy`, setup: 'notRequired',
                workspace: { serverId: workspace.serverId, workspaceId: 'copy', machineId: 'machine-a', rootPath: `${root}/copy` } });
            const modal = await openUseDestination({}, 'machine-a');
            await vi.waitFor(() => expect(modal.submit().props.disabled).toBe(false));
            await act(async () => { modal.submit().props.onPress(); });
            await vi.waitFor(() => expect(openRequests()).toHaveLength(1));
            expect(ExternalActionRequestEnvelopeV1Schema.parse(openRequests()[0]!.input).input).toMatchObject({
                machineId: 'machine-a', source: { kind: 'workspace', workspaceId: source().id },
                materialization: { kind: 'sync', targetPath: `${root}/copy`, workspaceAction: { kind: 'create_relationship' } } });
            expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
            expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)).toEqual([]);
        });
    });

    it('retires an in-flight destination admission when its Account credential changes', async () => {
        holdPreflight = true;
        const modal = await startAddMachineLink({ waitFor: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT });
        const preflight = callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT)[0]!;
        await act(async () => { await workspace.home.switchAccount(workspace.serverId, 'replacement-account'); });
        await vi.waitFor(() => expect(preflight.signal.aborted).toBe(true));
        await act(async () => { pendingPreflight.resolve(targetApproval(preflight)); });
        await vi.waitFor(() => expect(modal.screen.getTextContent()).toContain('workspaceSync.error.needsAttention'));
        expect(confirmModal).not.toHaveBeenCalled();
        expect(callsFor(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE)).toEqual([]);
    });
});
