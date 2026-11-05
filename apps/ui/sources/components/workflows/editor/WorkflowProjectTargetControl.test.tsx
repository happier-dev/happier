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
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { AgentInputSelectionListPopover } from '@/components/sessions/agentInput/components/AgentInputSelectionListPopover';
import { createWorkflowActionHttpTransport } from '@/dev/testkit/fixtures/workflowActionHttpTransport';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { storage } from '@/sync/domains/state/storage';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { settingsDefaults } from '@/sync/domains/settings/settings';

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

function workspaceRef(id: string, rootPath: string) {
    return { id, machineId: 'machine-1', serverId: account!.home.id, rootPath, createdAtMs: 1 };
}

beforeEach(async () => {
    restorePopoverGlobals = withPopoverWebGlobals();
    machineRpc.mockReset();
    machineRpc.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
        if (method === RPC_METHODS.SCM_WORKTREES_ENRICHMENT) return { success: true, entries: [] };
        if (method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS) return DaemonFilesystemListRootsResponseSchema.parse({
            ok: true, roots: [{ id: 'root', label: 'Root', path: '/' }],
        });
        if (method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
            const request = DaemonFilesystemListDirectoryRequestSchema.parse(payload);
            return DaemonFilesystemListDirectoryResponseSchema.parse({ ok: true, path: request.path, truncated: false,
                entries: request.path === '/' ? [{ name: 'Users', path: '/Users', type: 'directory' }]
                    : request.path === '/Users' ? [{ name: 'me', path: '/Users/me', type: 'directory' }]
                    : request.path === '/Users/me' ? [{ name: 'unbound', path: '/Users/me/unbound', type: 'directory' }]
                    : [],
            });
        }
        if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: repoSnapshot() };
        throw new Error(`Unexpected native Machine RPC: ${method}`);
    });
    const transport = createWorkflowActionHttpTransport({ fixtureResponse: async () => ({ ok: true, result: { definitions: [] } }), accountId: () => 'account-a' });
    const machineRows = MACHINES.map(machine => ({
        ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a' }),
        metadata: encodePlainMachineStoredContent(machine.metadata),
    }));
    account = await restoreServerAccountForTest({ serverUrl: 'https://workflow-where.test', accountId: 'account-a', request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/machines') return Response.json(machineRows);
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
            id => machineRows.find(row => row.id === id) ?? null);
        const machine = machineRows.find(row => path === `/v1/machines/${row.id}`);
        if (machine) return Response.json({ machine });
        if (path === '/health' || path.startsWith('/v1/features') || path.startsWith('/v1/account/encryption')
            || path === '/v2/account/settings' || path === '/v1/artifacts' || path.startsWith('/v3/automations')) {
            return transport.fetch(url, init);
        }
        // Unrelated bootstrap domains are absent on this Home, not network failures.
        // Throwing here would retire reachability and stall the real Machine census.
        return new Response('{}', { status: 404 });
    } });
    const scope = { serverId: account.home.id, accountId: 'account-a' };
    // Hydrate through Sync so the plain Machine content mode is available to
    // active RPC as well as scoped RPC; a display fixture has no storage-mode authority.
    await (await import('@/sync/sync')).sync.refreshMachines();
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
        settings: settingsDefaults,
        authoringMemory: { ...authoringMemoryDefaults, recentMachinePaths: [{ machineId: 'machine-2', path: '/home/me/service' }] } });
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

        expect(onChange).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/repo/payments-feature-auth',
            workspaceRefId: 'ref-feature',
        });
    });

    it('starts a newly selected Machine in its default folder without the previous binding', async () => {
        const onChange = vi.fn();
        const screen = await renderControl({
            target: { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' },
            onChange,
        });

        await screen.pressByTestIdAsync('workflow-editor-machine-option:machine-2');

        expect(onChange).toHaveBeenCalledWith({ machineId: 'machine-2', directory: '/home/me/service' });
    });

    it('browses inline and returns without changing the retained target or opening a modal', async () => {
        const onChange = vi.fn();
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show');
        const screen = await renderControl({ target: { machineId: 'machine-1', directory: '/repo/payments' }, onChange });
        const before = show.mock.calls.length;
        await screen.pressByTestIdAsync('workflow-editor-project-directory');
        expect(screen.findAllByType(MachinePathBrowserView)).toHaveLength(1);
        expect(show.mock.calls).toHaveLength(before);
        await act(async () => screen.findByType(MachinePathBrowserView).props.onRequestClose());
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.findAllByType(MachinePathBrowserView)).toHaveLength(0);
        expect(screen.findAllByType(MachineSelector)).toHaveLength(1);
        show.mockRestore();
    });

    it('applies a browsed folder only to the target it was opened for', async () => {
        const onChange = vi.fn();
        const opened = { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' };
        const screen = await renderControl({ target: opened, onChange });

        await screen.pressByTestIdAsync('workflow-editor-project-directory');
        // The real browser is owned by the real modal host, and its published
        // selection callback settles the opener's promise for the captured target.
        const browsers = screen.findAllByType(MachinePathBrowserView);
        expect(browsers).toHaveLength(1);
        const browser = browsers[0];
        expect(browser.props.machineId).toBe('machine-1');
        const { WorkflowProjectTargetControl } = await import('./WorkflowProjectTargetControl');
        // The host moved to another target while the browser was open.
        await screen.update(React.createElement(WorkflowProjectTargetControl, {
            machineName: 'Linux box',
            machines: MACHINES,
            testIDPrefix: 'workflow-editor',
            target: { machineId: 'machine-2', directory: '/home/me/service' },
            onChange,
        } as never));
        await act(async () => {
            browser.props.onPickPath('/repo/other');
        });

        expect(onChange).not.toHaveBeenCalled();
    });

    it('drops a stale project binding when a browsed folder names another project', async () => {
        const onChange = vi.fn();
        const screen = await renderControl({
            target: { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' },
            onChange,
        });

        await screen.pressByTestIdAsync('workflow-editor-project-directory');
        expect(screen.findAllByType(MachinePathBrowserView)).toHaveLength(1);
        await act(async () => {
            screen.findByType(MachinePathBrowserView).props.onPickPath('/Users/me/unbound');
        });

        expect(onChange).toHaveBeenCalledWith({ machineId: 'machine-1', directory: '/Users/me/unbound' });
    });

    it('presents Machine and project as one field select whose value is the where-summary, opening the same choices', async () => {
        const onChange = vi.fn();
        const screen = await renderControl({
            presentation: 'field',
            title: 'Runs on',
            subtitle: 'All of this workflow\'s triggers run here.',
            target: { machineId: 'machine-1', directory: '/Users/me/project' },
            onChange,
        });

        // One row: its label, its consequence and one value — no nested Machine tile and no
        // separate folder line until the person opens the field.
        expect(screen.getTextContent()).toContain('Runs on');
        expect(screen.getTextContent()).toContain('Mac Studio · ~/project');
        expect(screen.getTextContent()).not.toContain('/Users/me/project');
        expect(screen.findAllByType(MachineSelector)).toHaveLength(0);
        expect(screen.findByTestId('workflow-editor-project-directory')).toBeNull();

        await screen.pressByTestIdAsync('workflow-editor-machine-row');
        expect(screen.findByTestId('workflow-editor-where-popover')).not.toBeNull();
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
    });
});
