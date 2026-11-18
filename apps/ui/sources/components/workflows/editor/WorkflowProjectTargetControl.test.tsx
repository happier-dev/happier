import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
import { ScmWorkingSnapshotSchema, createScmCapabilities } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { DaemonFilesystemListDirectoryRequestSchema, DaemonFilesystemListDirectoryResponseSchema, DaemonFilesystemListRootsResponseSchema } from '@happier-dev/protocol/machines/fileBrowser';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePathBrowserView } from '@/components/ui/pathBrowser/MachinePathBrowserModal';
import { PathSelectionList } from '@/components/ui/pathPicker/PathSelectionList';
import { getPathBrowserRowTestId } from '@/components/ui/pathBrowser/pathBrowserTestIds';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import { createWorkflowActionHttpTransport } from '@/dev/testkit/fixtures/workflowActionHttpTransport';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createServedHomeAccountToken } from '@/dev/testkit/harness/actionHomesHttpHarness';

/**
 * The Workflow "Where" row consumes New Session's project/checkout owners.
 *
 * HTTP, native RPC, recycler and Radix are the boundaries. The modal host,
 * Machine/checkout pickers, SCM cache and mapper, folder-dialog promise and
 * Workflow project adapter all run for real.
 */

const machineRpc = vi.hoisted(() => vi.fn());
let restorePopoverGlobals: (() => void) | undefined;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// The socket is the native Machine RPC boundary; scoped routing, guards,
// currentness, parsers and caches all run through their real owners.
installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, raw: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
            throw new Error('Malformed native Machine RPC');
        }
        return { ok: true, result: await machineRpc({ method: raw.method.slice(raw.method.indexOf(':') + 1), payload: raw.params }) };
    });
});
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
vi.mock('@legendapp/list/react-native', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(), renderItems: true,
    }).module);
const { ModalProvider } = await import('@/modal/ModalProvider');
function ModalHost({ children }: React.PropsWithChildren) {
    return <ModalProvider>{children}</ModalProvider>;
}

const MACHINES = [
    createMachineFixture({ id: 'machine-1', metadata: { ...createMachineFixture().metadata!, displayName: 'Mac Studio', homeDir: '/Users/me', platform: 'darwin' } }),
    createMachineFixture({ id: 'machine-2', metadata: { ...createMachineFixture().metadata!, displayName: 'Linux box', homeDir: '/home/me', platform: 'linux' } }),
];
const HOME_ID = 'srv_workflow_where';
const RECENT_MACHINE_PATHS = [{ machineId: 'machine-2', path: '/home/me/service' }];
const browserReadRequests: Array<Readonly<{ actionId: string; requestId?: string; surface: string; authority: string }>> = [];

function repoSnapshot() {
    return ScmWorkingSnapshotSchema.parse({
        projectKey: 'machine-1:/repo/payments',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo/payments',
            backendId: 'git',
            mode: '.git',
            worktrees: [
                { path: '/repo/payments', branch: 'main', isCurrent: true, isMain: true },
                { path: '/repo/payments-feature-auth', branch: 'feature/auth', isCurrent: false },
            ],
        },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        capabilities: createScmCapabilities({ readStatus: true }),
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    });
}

function workspaceRef(id: string, rootPath: string, serverId = HOME_ID) {
    return { id, machineId: 'machine-1', serverId, rootPath, createdAtMs: 1 };
}

beforeEach(async () => {
    restorePopoverGlobals = withPopoverWebGlobals();
    browserReadRequests.length = 0;
    const { clearCachedMachineFileBrowserRoots, clearCachedMachineFileBrowserEntries } = await import('@/sync/domains/input/machineFileBrowser');
    for (const machine of MACHINES) {
        clearCachedMachineFileBrowserRoots({ machineId: machine.id });
        clearCachedMachineFileBrowserEntries({ machineId: machine.id });
    }
    machineRpc.mockReset();
    machineRpc.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
        if (method === RPC_METHODS.SCM_WORKTREES_ENRICHMENT) return { success: true, entries: [] };
        if (method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS) return DaemonFilesystemListRootsResponseSchema.parse({
            ok: true, roots: [{ id: 'root', label: 'Root', path: '/' }],
        });
        if (method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
            const request = DaemonFilesystemListDirectoryRequestSchema.parse(payload);
            return DaemonFilesystemListDirectoryResponseSchema.parse({ ok: true, path: request.path, truncated: false,
                entries: request.path === '/' ? [{ name: 'Users', path: '/Users', type: 'directory' }, { name: 'repo', path: '/repo', type: 'directory' }]
                    : request.path === '/Users' ? [{ name: 'me', path: '/Users/me', type: 'directory' }]
                    : request.path === '/Users/me' ? [{ name: 'unbound', path: '/Users/me/unbound', type: 'directory' }]
                    : request.path === '/repo' ? [{ name: 'payments', path: '/repo/payments', type: 'directory' },
                        { name: 'payments-feature-auth', path: '/repo/payments-feature-auth', type: 'directory' }]
                    : [],
            });
        }
        if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: repoSnapshot() };
        throw new Error(`Unexpected native Machine RPC: ${method}`);
    });
    const transport = createWorkflowActionHttpTransport({ fixtureResponse: async () => ({ ok: true, result: { definitions: [] } }), accountId: () => 'account-a' });
    const readActions = await Promise.all(Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1).map(actionId =>
        createExternalActionAccountHttpBoundary({ serverUrl: 'https://workflow-where.test', serverIdentityId: HOME_ID,
            accountId: 'account-a', machineId: 'machine-1', actionId, tokenEpoch: 0,
            execute: async (input, context) => {
                browserReadRequests.push({ actionId, requestId: context.requestId,
                    surface: context.invocation.surface, authority: context.invocation.authority });
                const method = actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.listRoots ? RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS
                    : actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory ? RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY
                        : RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST;
                return machineRpc({ method, payload: input });
            },
        })));
    const settings = { ...settingsDefaults, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {},
        approvalWaivedSurfaces: Object.fromEntries(Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1).map(id => [id, ['ui', 'agent']])),
    }) };
    const machineRows = MACHINES.map(machine => ({
        ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine: { ...machine, activeAt: Date.now() } }),
        ...(machine.id === 'machine-1' ? { installationPublicKey: readActions[0]!.machine.installationPublicKey } : {}),
        metadata: encodePlainMachineStoredContent(machine.metadata),
    }));
    account = await restoreServerAccountForTest({ serverUrl: 'https://workflow-where.test', serverIdentityId: HOME_ID, accountId: 'account-a',
        credentials: { token: createServedHomeAccountToken('account-a', true) }, request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v2/account/settings' && (init?.method ?? 'GET') === 'GET') return Response.json(
            AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: settings }, version: 1 }));
        if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: [
            workspaceRef('ref-main', '/repo/payments', HOME_ID),
            workspaceRef('ref-feature', '/repo/payments-feature-auth', HOME_ID),
        ] }));
        if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [
            { key: 'recentMachinePaths', revision: 0, content: { t: 'plain', v: RECENT_MACHINE_PATHS } },
        ] }));
        if (path === '/v1/machines') return Response.json(machineRows);
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
            id => machineRows.find(row => row.id === id) ?? null);
        const machine = machineRows.find(row => path === `/v1/machines/${row.id}`);
        if (machine) return Response.json({ machine });
        for (const readAction of readActions) {
            const response = await readAction.handle(new URL(String(url)), init);
            if (response) return response;
        }
        // Keep the restored Account's real profile/bootstrap contracts intact;
        // the canonical HTTP fixture owns all otherwise empty Account domains.
        return transport.fetch(url, init);
    } });
    const scope = { serverId: HOME_ID, accountId: 'account-a' };
    // Hydrate through Sync so the plain Machine content mode is available to
    // active RPC as well as scoped RPC; a display fixture has no storage-mode authority.
    await (await import('@/sync/sync')).sync.refreshMachines();
    // Display the full rows admitted by Sync, including their canonical live-presence slices.
    for (let index = 0; index < MACHINES.length; index++) {
        const admitted = storage.getState().machines[MACHINES[index]!.id];
        if (!admitted) throw new Error('Expected admitted Machine fixture');
        MACHINES[index] = admitted;
    }
    for (const machine of MACHINES) {
        machine.activeAt = Date.now();
        recordMachineRequestSucceeded({ ...scope, machineId: machine.id });
    }
    const workspaceRefs = [
            workspaceRef('ref-main', '/repo/payments'),
            workspaceRef('ref-feature', '/repo/payments-feature-auth'),
        ];
    storage.setState({ profileScope: scope,
        projectAccountRows: { scope, status: 'ready', coverage: 'complete', workspaceRefs,
            relationships: [], organizations: [], revisionsByPhysicalKey: {} },
        settings,
        authoringMemory: { ...authoringMemoryDefaults, recentMachinePaths: RECENT_MACHINE_PATHS } });
});

afterEach(async () => {
    await standardCleanup();
    restorePopoverGlobals?.();
    await account?.dispose();
    account = undefined;
});

async function renderControl(props: Readonly<Record<string, unknown>>) {
    const { WorkflowProjectTargetControl } = await import('./WorkflowProjectTargetControl');
    return renderScreen(React.createElement(WorkflowProjectTargetControl, {
        machineName: 'Mac Studio',
        machines: MACHINES,
        testIDPrefix: 'workflow-editor',
        ...props,
    } as never), { wrapper: ModalHost });
}

function stepOptions(step: SelectionListStep, sectionId: string) {
    const section = step.sections.find((candidate) => candidate.id === sectionId);
    return section?.kind === 'static' ? section.options : [];
}

describe('workflow project target control', () => {
    it.each([false, true])('selects the requester workspace for member placement (shared %s)', async isShared => {
        const memberMachine = createMachineFixture({ ...MACHINES[1], isShared,
            access: { custodian: { accountId: isShared ? 'custodian-account' : 'account-a', displayName: 'Machine owner' },
                role: isShared ? 'use' : 'manage', resourceMode: 'plain', accessState: 'ready' },
            metadata: { ...MACHINES[1]!.metadata!, agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } });
        const machines = [MACHINES[0]!, memberMachine];
        storage.getState().applyMachines(machines, true, { sourceServerId: account!.home.id });
        machineRpc.mockImplementation(async ({ method }) => {
            if (method === RPC_METHODS.MACHINES_AGENT_ISOLATION_STATUS) return {
                protection: 'member_separated', status: { kind: 'effective', platform: 'linux' },
                directories: { home: '/member/home', workspace: '/member/workspace' },
            };
            if (method === RPC_METHODS.SCM_WORKTREES_ENRICHMENT) return { success: true, entries: [] };
            if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: repoSnapshot() };
            throw new Error(`Unexpected native Machine RPC: ${method}`);
        });
        const onChange = vi.fn();
        const screen = await renderControl({ machines, target: null, onChange });
        // Machine and folder are New Session's two chips (owner 2026-11-12): the Machine chip opens its picker.
        await screen.pressByTestIdAsync('agent-input-machine-chip');
        await screen.pressByTestIdAsync('workflow-editor-machine-option:machine-2');
        await vi.waitFor(async () => expect(onChange).toHaveBeenCalledWith({ machineId: 'machine-2', directory: '/member/workspace' }));
    });

    it('opens placement and edits its directory through mounted commands using the same project adapter', async () => {
        const { WorkflowProjectTargetControl } = await import('./WorkflowProjectTargetControl');
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const { readCurrentUiContextActionReader } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { ACTION_ID_FAMILIES_V1 } = await import('@happier-dev/protocol/actions/actionIds');
        const onChange = vi.fn();
        function Controlled() {
            const [target, setTarget] = React.useState<import('@/sync/domains/workflows/workflowProjectTarget').WorkflowAuthoringTarget>(
                { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' });
            return <WorkflowProjectTargetControl machineName="Mac Studio" machines={MACHINES} target={target}
                presentation="field" currentUiContextCommandScope="coach-placement" testIDPrefix="coach-placement"
                onChange={next => { onChange(next); setTarget(next); }} />;
        }
        const screen = await renderMountedCurrentUiContext(<Controlled />, { withModalProvider: true });
        const executor = createDefaultActionExecutor();
        let invocationNumber = 0;
        const invoke = async (key: string, input?: import('@happier-dev/protocol/plugins/ui').PluginUiJsonValueV1) => {
            const command = await vi.waitFor(() => {
                const commands = readCurrentUiContextActionReader({ surface: 'agent' })!.readCurrentUiContext()!.commands;
                const selected = commands.find(row => row.description?.includes(`coach-placement.${key}`));
                expect(selected, JSON.stringify({ key, commands })).toBeDefined();
                return selected!;
            });
            await act(async () => {
                const outcome = await executor.execute(ACTION_ID_FAMILIES_V1.current_ui_context[1], { commandId: command!.id,
                    ...(input === undefined ? {} : { input }) }, { surface: 'agent', authority: 'account_automation',
                    expectedAccountId: 'account-a', actionRequestId: `trigger-placement-agent-${++invocationNumber}` });
                expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
            });
        };
        // `open` opens the Machine chip's picker (New Session's); there is no combined Where popover.
        expect(screen.findAllByType(NewSessionMachineSelectionContent)).toHaveLength(0);
        await invoke('open');
        expect(screen.findAllByType(NewSessionMachineSelectionContent)).toHaveLength(1);
        await invoke('browse');
        await vi.waitFor(() => expect(screen.findByTestId(getPathBrowserRowTestId('/repo/payments-feature-auth'))).not.toBeNull());
        const browserContext = screen.findAllByType(MachinePathBrowserView)[0]?.props.callerContext as
            import('@happier-dev/protocol/actions/executor/types').ActionExecutorContext | undefined;
        const { readCredentialAuthorityKind } = await import('@/auth/context/credentialAuthority');
        expect(browserReadRequests.length, JSON.stringify({
            credentialAuthorityKind: readCredentialAuthorityKind(account!.credentials.token),
            browserCaller: browserContext && { surface: browserContext.surface, authority: browserContext.authority,
                callerKind: browserContext.actionCaller?.kind, externalCredential: Boolean(browserContext.externalActionCredential),
                externalAuthorization: Boolean(browserContext.externalActionExecutionAuthorization),
                sessionAuthorization: Boolean(browserContext.rpcSessionAuthorization) },
            nativeMethods: machineRpc.mock.calls.map(([request]) => request.method),
        })).toBeGreaterThan(0);
        expect(browserReadRequests).toEqual(expect.arrayContaining([expect.objectContaining({
            actionId: FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory,
            surface: 'agent', authority: 'account_automation',
        })]));
        expect(browserReadRequests.every(request => request.surface === 'agent' && request.authority === 'account_automation')).toBe(true);
        expect(browserReadRequests.every(request => Boolean(request.requestId) && request.requestId !== 'trigger-placement-agent-2')).toBe(true);
        expect(new Set(browserReadRequests.map(request => request.requestId)).size).toBe(browserReadRequests.length);
        await invoke('browser.activate', { path: '/repo/payments-feature-auth' });
        await invoke('browser.confirm');
        expect(onChange, JSON.stringify({ profileScope: storage.getState().profileScope,
            projectAccountRows: storage.getState().projectAccountRows })).toHaveBeenLastCalledWith({
            machineId: 'machine-1', directory: '/repo/payments-feature-auth', workspaceRefId: 'ref-feature' });
        await vi.waitFor(() => expect(screen.findByTestId('coach-placement-project-checkout')).not.toBeNull());
        await invoke('checkout.open');
        const picker = screen.findAllByType(AgentInputSelectionListPopover).find(node => node.props.open)!;
        const main = stepOptions(picker.props.rootStep as SelectionListStep, 'worktree:quick-actions')
            .find(option => option.id === 'current_path');
        expect(main).toBeDefined();
        await invoke('checkout.list.activate', { id: main!.id });
        expect(onChange).toHaveBeenLastCalledWith({ machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' });
        await invoke('machine.activate', { id: 'machine-2' });
        expect(onChange).toHaveBeenLastCalledWith({ machineId: 'machine-2', directory: '/home/me/service' });
        await invoke('close');
        expect(screen.findAllByType(NewSessionMachineSelectionContent)).toHaveLength(0);
    });
    it('picks an existing checkout through the New Session picker and rebinds its project', async () => {
        const onChange = vi.fn();
        const screen = await renderControl({
            target: { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' },
            onChange,
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findByTestId('workflow-editor-project-checkout'), JSON.stringify({
                nativeRequests: machineRpc.mock.calls, rendered: screen.getTextContent(),
            })).not.toBeNull();
        });

        await screen.pressByTestIdAsync('workflow-editor-project-checkout');
        const popover = screen.findAllByType(AgentInputSelectionListPopover).find(node => node.props.open)!;
        const rootStep = popover.props.rootStep as SelectionListStep;

        // A new worktree is the Workspace policy's job here, so the picker offers
        // existing checkouts only — never a create path the project cannot carry.
        expect(stepOptions(rootStep, 'worktree:quick-actions').map((option) => option.id))
            .toEqual(['current_path']);
        const feature = stepOptions(rootStep, 'worktree:existing')
            .find((option) => option.subtitle === '/repo/payments-feature-auth');
        if (!feature) throw new Error('Expected the alternate checkout in the real picker');
        await screen.pressByTestIdAsync(`selection-list:${rootStep.id}:option:${feature.id}`);

        expect(onChange, JSON.stringify({ profileScope: storage.getState().profileScope,
            projectAccountRows: storage.getState().projectAccountRows })).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/repo/payments-feature-auth',
            workspaceRefId: 'ref-feature',
        });
    });

    it('lays Machine, Folder and Workspace on the host rows, and the checkout picker writes the workflow Workspace', async () => {
        const { Text } = await import('@/components/ui/text/Text');
        const onChange = vi.fn();
        const onWorkspace = vi.fn();
        const rows: string[] = [];
        const screen = await renderControl({
            target: { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' },
            onChange,
            presentation: 'rows',
            renderRow: (row: string, label: string, control: React.ReactNode) => {
                rows.push(row);
                return <React.Fragment key={row}><Text>{label}</Text>{control}</React.Fragment>;
            },
            workspace: { value: undefined, onChange: onWorkspace },
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findByTestId('workflow-editor-project-checkout')).not.toBeNull();
        });
        expect(new Set(rows)).toEqual(new Set(['machine', 'folder', 'workspace']));
        // Under the Machine, the line saying where the workflow's work runs there (lab J6).
        expect(screen.findByTestId('session-placement-isolation-outcome')).not.toBeNull();

        await screen.pressByTestIdAsync('workflow-editor-project-checkout');
        let popover = screen.findAllByType(AgentInputSelectionListPopover).find(node => node.props.open)!;
        let rootStep = popover.props.rootStep as SelectionListStep;
        // A workflow creates its worktree per run: "New worktree" selects in place, no branch or name steps.
        const quickActions = stepOptions(rootStep, 'worktree:quick-actions');
        expect(quickActions.map((option) => option.id)).toEqual(['current_path', 'create_git_worktree']);
        expect(quickActions[1]!.openStep).toBeUndefined();
        await screen.pressByTestIdAsync(`selection-list:${rootStep.id}:option:create_git_worktree`);
        expect(onWorkspace).toHaveBeenLastCalledWith({ kind: 'new_worktree', source: { kind: 'original' } });
        expect(onChange).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('workflow-editor-project-checkout');
        popover = screen.findAllByType(AgentInputSelectionListPopover).find(node => node.props.open)!;
        rootStep = popover.props.rootStep as SelectionListStep;
        await screen.pressByTestIdAsync(`selection-list:${rootStep.id}:option:current_path`);
        expect(onWorkspace).toHaveBeenLastCalledWith({ kind: 'project_checkout' });
    });

    it('opens the step-scope checkout picker from another control, with the step rows, and closes on a choice', async () => {
        const { WorkflowStepWorkspacePicker } = await import('./WorkflowProjectTargetControl');
        const sameAsWorkflow = vi.fn();
        const fromStep = vi.fn();
        const onClose = vi.fn();
        const anchorRef = React.createRef<never>();
        const screen = await renderScreen(React.createElement(WorkflowStepWorkspacePicker, {
            place: { target: { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' }, machineName: 'Mac Studio', machines: MACHINES },
            workspace: { value: undefined, onChange: vi.fn(), step: {
                sameAsWorkflow: { subtitle: 'Workflow default · Project folder', onSelect: sameAsWorkflow },
                fromSteps: [{ blockId: 'plan', label: 'Plan', onSelect: fromStep }],
                selection: undefined,
            } },
            anchorRef,
            onClose,
            testIDPrefix: 'workflow-editor-step-ask-workspace',
        } as never), { wrapper: ModalHost });
        // Mounted open, hung from the chip: no trigger of its own, the step's rows first.
        expect(screen.findByTestId('workflow-editor-step-ask-workspace-project-checkout')).toBeNull();
        const popover = screen.findAllByType(AgentInputSelectionListPopover).find(node => node.props.open)!;
        expect(popover.props.anchorRef).toBe(anchorRef);
        const rootStep = popover.props.rootStep as SelectionListStep;
        const stepRows = stepOptions(rootStep, 'worktree:step-scope');
        expect(stepRows.map((option) => option.id)[0]).toBe('workspace_same_as_workflow');
        await screen.pressByTestIdAsync(`selection-list:${rootStep.id}:option:workspace_same_as_workflow`);
        expect(sameAsWorkflow).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalled();
    });

    it('says the workflow waits for an offline Machine, from the reachability verdict New Session reads (J6)', async () => {
        const { Text } = await import('@/components/ui/text/Text');
        const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
        const screen = await renderControl({
            target: { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' },
            onChange: vi.fn(),
            presentation: 'rows',
            renderRow: (row: string, label: string, control: React.ReactNode) => <React.Fragment key={row}><Text>{label}</Text>{control}</React.Fragment>,
            workspace: { value: undefined, onChange: vi.fn() },
        });
        const outcome = () => screen.findByTestId('session-placement-isolation-outcome');
        await vi.waitFor(() => expect(outcome()).not.toBeNull());
        expect(screen.getTextContent()).not.toContain(t('machineDetailPage.isolation.outcome.offline', { machine: 'Mac Studio' }));
        await act(async () => { recordMachineRequestFailed({ serverId: HOME_ID, accountId: 'account-a', machineId: 'machine-1' }); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineDetailPage.isolation.outcome.offline', { machine: 'Mac Studio' })));
    });
    it('starts a newly selected Machine in its default folder without the previous binding', async () => {
        const onChange = vi.fn();
        const screen = await renderControl({
            target: { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' },
            onChange,
        });

        await screen.pressByTestIdAsync('agent-input-machine-chip');
        await screen.pressByTestIdAsync('workflow-editor-machine-option:machine-2');

        expect(onChange).toHaveBeenCalledWith({ machineId: 'machine-2', directory: '/home/me/service' });
    });

    it('chooses the folder through New Session\'s folder chip and path picker without changing the target', async () => {
        const onChange = vi.fn();
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show');
        const screen = await renderControl({ target: { machineId: 'machine-1', directory: '/repo/payments' }, onChange });
        const before = show.mock.calls.length;
        await screen.pressByTestIdAsync('agent-input-path-chip');
        // The new-session path picker (type a path, suggestions, favourites, browse), never a second folder control.
        expect(screen.findAllByType(PathSelectionList)).toHaveLength(1);
        expect(screen.findAllByType(MachinePathBrowserView)).toHaveLength(0);
        expect(show.mock.calls).toHaveLength(before);
        expect(onChange).not.toHaveBeenCalled();
        show.mockRestore();
    });

    it('closes the folder picker when the host moves to another Machine, applying nothing', async () => {
        const onChange = vi.fn();
        const opened = { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' };
        const screen = await renderControl({ target: opened, onChange });

        await screen.pressByTestIdAsync('agent-input-path-chip');
        expect(screen.findAllByType(PathSelectionList)).toHaveLength(1);
        const { WorkflowProjectTargetControl } = await import('./WorkflowProjectTargetControl');
        // The host moved to another target while the picker was open.
        await screen.update(React.createElement(WorkflowProjectTargetControl, {
            machineName: 'Linux box',
            machines: MACHINES,
            testIDPrefix: 'workflow-editor',
            target: { machineId: 'machine-2', directory: '/home/me/service' },
            onChange,
        } as never));

        expect(screen.findAllByType(PathSelectionList)).toHaveLength(0);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('drops a stale project binding when a browsed folder names another project', async () => {
        const onChange = vi.fn();
        const screen = await renderControl({
            target: { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' },
            onChange,
        });

        await screen.pressByTestIdAsync('agent-input-path-chip');
        expect(screen.findAllByType(PathSelectionList)).toHaveLength(1);
        await act(async () => {
            screen.findByType(PathSelectionList).props.onCommit('/Users/me/unbound');
        });

        expect(onChange).toHaveBeenCalledWith({ machineId: 'machine-1', directory: '/Users/me/unbound' });
    });

    it('presents Machine and project as one settings row holding New Session\'s two chips', async () => {
        const onChange = vi.fn();
        const screen = await renderControl({
            presentation: 'field',
            title: 'Runs on',
            subtitle: 'All of this workflow\'s triggers run here.',
            target: { machineId: 'machine-1', directory: '/Users/me/project' },
            onChange,
        });

        // One row: its label, its consequence and the Machine and folder chips; no combined Where popover.
        expect(screen.getTextContent()).toContain('Runs on');
        expect(screen.findByTestId('agent-input-machine-chip')).not.toBeNull();
        expect(screen.findByTestId('agent-input-path-chip')).not.toBeNull();
        expect(screen.findByTestId('workflow-editor-where-popover')).toBeNull();
        expect(screen.findAllByType(NewSessionMachineSelectionContent)).toHaveLength(0);

        await screen.pressByTestIdAsync('agent-input-machine-chip');
        await screen.pressByTestIdAsync('workflow-editor-machine-option:machine-2');
        expect(onChange).toHaveBeenCalledWith({ machineId: 'machine-2', directory: '/home/me/service' });
    });

    it('shows a host-fixed target read-only and names an unresolved Machine truthfully', async () => {
        // No change handler: the host fixes the target (a one-shot Automation).
        const fixed = await renderControl({
            target: { machineId: 'machine-1', directory: '/Users/me/project' },
        });
        expect(fixed.getTextContent()).toContain('~/project');
        expect(fixed.findByTestId('workflow-editor-project-checkout')).toBeNull();
        await fixed.unmount();

        const unresolved = await renderControl({ target: null, machines: undefined, machineName: null });
        expect(unresolved.getTextContent()).toContain('workflows.editor.targetRequired');
    });
});

describe('read-only Machine and project field', () => {
    it('tells someone who cannot edit what is, never to choose (FIN-DESIGN-REVIEW M7)', async () => {
        const unset = await renderControl({ presentation: 'field', target: null, machines: undefined, machineName: null });
        expect(unset.getTextContent()).toContain('workflows.editor.targetNotChosen');
        expect(unset.getTextContent()).not.toContain('workflows.editor.targetRequired');
        await unset.unmount();
        const foreign = await renderControl({ presentation: 'field', target: { machineId: 'machine-x', directory: '/srv/app' },
            machines: undefined, machineName: null });
        expect(foreign.getTextContent()).toContain('workflows.editor.targetOtherMachine');
    });
});

describe('workflow where summary', () => {
    it('keeps the Machine and its folder apart even when the folder is the root', async () => {
        const { formatWorkflowWhereSummary } = await import('./WorkflowProjectTargetControl');
        expect(formatWorkflowWhereSummary({ target: { machineId: 'machine-1', directory: '/' }, machineName: 'Mac Studio', machineHomeDir: '/Users/me' }))
            .toBe('Mac Studio · /');
        expect(formatWorkflowWhereSummary({ target: { machineId: 'machine-1', directory: '/Users/me/project' }, machineName: 'Mac Studio', machineHomeDir: '/Users/me' }))
            .toBe('Mac Studio · ~/project');
        expect(formatWorkflowWhereSummary({ target: { machineId: 'machine-1', directory: '/Users/me/' }, machineName: 'Mac Studio', machineHomeDir: '/Users/me' }))
            .toBe('Mac Studio · workspacePresentation.homeFolder');
        expect(formatWorkflowWhereSummary({ target: { machineId: 'machine-1', directory: '~\\' }, machineName: 'Mac Studio' }))
            .toBe('Mac Studio · workspacePresentation.homeFolder');
    });
});
