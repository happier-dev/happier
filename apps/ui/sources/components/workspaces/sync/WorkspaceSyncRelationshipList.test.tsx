import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { WorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { resetWorkspaceSyncStatusStoreForTests } from '@/sync/domains/sessionHandoff/workspaceSyncStatusStore';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const openDefaultDetailsSpy = vi.hoisted(() => vi.fn());
const relationshipActionSpies = vi.hoisted(() => ({
    disable: vi.fn(async () => ({ ok: true, v: 1, relationshipId: 'relationship-1', enabled: false })),
    enable: vi.fn(async () => ({ ok: true, v: 1, relationshipId: 'relationship-1', enabled: true })),
    flush: vi.fn(async () => ({ ok: true, v: 1, relationshipId: 'relationship-1', status: null })),
    terminate: vi.fn(async () => ({ ok: true, v: 1, relationshipId: 'relationship-1', terminated: true })),
}));
const mountedExecuteSpy = vi.hoisted(() => vi.fn());
const mountedExecution = vi.hoisted(() => ({ current: true }));

installSessionHandoffCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: false }).module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
                useWorkspaceRefs: () => [],
                useWorkspaceSyncRelationships: () => [],
                useMachineDisplayNamesById: () => ({}),
        });
    },
    text: async () => ({
        t: (key: string, params?: Record<string, unknown>) => params
            ? `${key}:${JSON.stringify(params)}`
            : key,
    }),
});

vi.mock('@/components/approvals/useMountedActionExecution', () => ({
    useMountedActionExecution: () => ({ execute: mountedExecuteSpy, ready: true, isCurrent: () => mountedExecution.current }),
}));

vi.mock('@/sync/ops/actions/workspaceSyncRelationshipActions', () => ({
    disableWorkspaceSyncRelationshipAction: relationshipActionSpies.disable,
    enableWorkspaceSyncRelationshipAction: relationshipActionSpies.enable,
    flushWorkspaceSyncRelationshipAction: relationshipActionSpies.flush,
    terminateWorkspaceSyncRelationship: relationshipActionSpies.terminate,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
});

vi.mock('./openWorkspaceSyncRelationshipDetails', () => ({
    openWorkspaceSyncRelationshipDetails: openDefaultDetailsSpy,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement(
        'Item',
        props,
        props.children,
        props.rightElement as React.ReactNode,
        props.bottomElement as React.ReactNode,
    ),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Readonly<Record<string, unknown> & {
        trigger?: (state: Readonly<{ toggle: () => void }>) => React.ReactNode;
    }>) => React.createElement(
        'DropdownMenu',
        props,
        props.trigger?.({ toggle: () => undefined }),
    ),
}));

vi.mock('@/components/ui/buttons/IconButton', () => ({
    IconButton: (props: Record<string, unknown>) => React.createElement('IconButton', props),
}));

const desktopHostState = vi.hoisted(() => ({ isDesktop: false }));
const invokeDesktopHostSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => desktopHostState.isDesktop,
    invokeDesktopHost: invokeDesktopHostSpy,
}));

function createSummary(
    conflictCount: number,
    mode: WorkspaceSyncRelationshipSummary['relationship']['mode'] = 'keep_both_in_sync',
): WorkspaceSyncRelationshipSummary {
    return {
        relationshipId: 'relationship-1',
        relationship: {
            v: 1,
            relationshipId: 'relationship-1',
            controllerMachineId: 'machine-alpha',
            alphaWorkspaceRefId: 'workspace-alpha',
            betaWorkspaceRefId: 'workspace-beta',
            mode,
            contentPolicy: {
                v: 1,
                selection: 'git_worktree',
                extraIgnorePatterns: [],
                extraIncludePatterns: [],
                policyDigest: 'sha256:test',
            },
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 2,
        },
        alpha: {
            workspaceRefId: 'workspace-alpha',
            workspaceRef: { id: 'workspace-alpha', serverId: 'server-1', machineId: 'machine-alpha', rootPath: '/alpha', label: 'Alpha', createdAtMs: 1 },
            label: 'Alpha',
            name: 'Alpha',
            machineName: 'Alpha Mac',
        },
        beta: {
            workspaceRefId: 'workspace-beta',
            workspaceRef: { id: 'workspace-beta', serverId: 'server-1', machineId: 'machine-beta', rootPath: '/beta', label: 'Beta', createdAtMs: 1 },
            label: 'Beta',
            name: 'Beta',
            machineName: 'Beta workstation',
        },
        status: {
            relationshipId: 'relationship-1',
            controllerMachineId: 'machine-alpha',
            state: conflictCount > 0 ? 'conflicted' : 'watching',
            alphaPath: '/alpha',
            betaPath: '/beta',
            mode,
            endpointStates: { alpha: null, beta: null },
            conflictCount,
            lastCycleObservedAtMs: 4,
        },
    };
}

const { WorkspaceSyncRelationshipRow, WorkspaceSyncRelationshipList } = await import('./WorkspaceSyncRelationshipList');

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;
/** The row's secondary line: its folders (when machines lead the title) and its mode. */
function metaLineOf(screen: RenderedScreen): string {
    return screen.findByTestId('workspace-sync-relationship-relationship-1')?.props.subtitle as string;
}
/** The row's one status line, as presented. */
function statusOf(screen: RenderedScreen): Readonly<{ text: string; tone: string; action: string | null }> {
    return screen.findAll((node) => node.props.testID === 'workspace-sync-relationship-relationship-1-status' && 'model' in node.props)[0]?.props.model;
}

describe('WorkspaceSyncRelationshipRow', () => {
    // A failed lifecycle Action records its error in the shared status snapshot; no row test inherits another's.
    beforeEach(() => resetWorkspaceSyncStatusStoreForTests());

    it('routes termination through its Action even when a private modal would refuse', async () => {
        for (const spy of Object.values(relationshipActionSpies)) spy.mockClear();
        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={createSummary(0)} />);
        const menu = screen.findAllByType('DropdownMenu')[0];

        await act(async () => { menu?.props.onSelect('terminate'); });
        await vi.waitFor(() => expect(relationshipActionSpies.terminate).toHaveBeenCalledWith({
            controllerMachineId: 'machine-alpha',
            relationshipId: 'relationship-1',
        }, null, mountedExecuteSpy));
    });

    it('presents a refused lifecycle Action as its own refusal instead of a generic failure', async () => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={createSummary(0)} />);
        const menu = screen.findAllByType('DropdownMenu')[0];

        relationshipActionSpies.enable.mockResolvedValueOnce({ ok: false, errorCode: 'target_bootstrap_required', error: 'Git workspace sync target requires an explicit SCM bootstrap source' } as never);
        await act(async () => { menu?.props.onSelect('enable'); });
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith('common.error', 'workspaceSync.error.destinationNeedsPreparation (target_bootstrap_required)'));

        vi.mocked(Modal.alert).mockClear();
        relationshipActionSpies.enable.mockResolvedValueOnce({ ok: false, errorCode: 'something_unmapped', error: 'x' } as never);
        await act(async () => { menu?.props.onSelect('enable'); });
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith('common.error', 'common.requestFailed (something_unmapped)'));
    });

    it('presents nothing when the row left the list before its own Stop settled', async () => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={createSummary(0)} />);
        const menu = screen.findAllByType('DropdownMenu')[0];

        // The daemon removes the relationship before its Stop settles, so the list drops the row and
        // retires the row's mounted Action interest; the cancelled settle is not a failed Stop.
        relationshipActionSpies.terminate.mockImplementationOnce(async () => {
            mountedExecution.current = false;
            return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' } as never;
        });
        try {
            await act(async () => { menu?.props.onSelect('terminate'); });
            await vi.waitFor(() => expect(relationshipActionSpies.terminate).toHaveBeenCalled());
        } finally {
            mountedExecution.current = true;
        }
        expect(Modal.alert).not.toHaveBeenCalled();
    });

    it('opens general details from every row while keeping conflict attention and actions row-scoped', async () => {
        const openDetails = vi.fn();
        const openConflicts = vi.fn();
        const summary = createSummary(2);
        const screen = await renderScreen(
            <WorkspaceSyncRelationshipRow
                summary={summary}
                onOpenDetails={openDetails}
                onOpenConflicts={openConflicts}
            />,
        );

        const row = screen.findByTestId('workspace-sync-relationship-relationship-1');
        expect(row?.props.showChevron).toBe(true);
        expect(row?.props.rightElementOutsidePressable).toBe(true);
        await screen.pressByTestIdAsync('workspace-sync-relationship-relationship-1');
        expect(openDetails).toHaveBeenCalledWith(summary);
        expect(openConflicts).not.toHaveBeenCalled();

        // Conflicts are the row's status line, in tone, with Review as its one next step.
        expect(statusOf(screen)).toMatchObject({ text: 'workspaceSync.conflictCount:{"count":2}', tone: 'warn', action: 'review' });
        await act(async () => { screen.findAll((node) => node.props.testID === 'workspace-sync-relationship-relationship-1-status' && 'onReview' in node.props)[0]?.props.onReview(); });
        expect(openConflicts).toHaveBeenCalledWith(summary);
    });

    it('opens general details for a healthy relationship and does not invent conflict attention', async () => {
        const openDetails = vi.fn();
        const summary = createSummary(0);
        const screen = await renderScreen(
            <WorkspaceSyncRelationshipRow summary={summary} onOpenDetails={openDetails} />,
        );

        await screen.pressByTestIdAsync('workspace-sync-relationship-relationship-1');
        expect(openDetails).toHaveBeenCalledWith(summary);
        expect(statusOf(screen)).toMatchObject({ tone: 'quiet', action: null });
        expect(statusOf(screen).text).toContain('workspaceSync.state.watching');
    });

    it('omits Last checked when no cycle observation exists', async () => {
        const summary = createSummary(0);
        if (!summary.status) throw new Error('expected relationship status fixture');
        summary.status.lastCycleObservedAtMs = null;

        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={summary} />);

        expect(statusOf(screen).text).not.toContain('workspaceSync.lastChecked');
    });

    it('uses one-way direction and machine display names for relationship and open actions', async () => {
        const summary = createSummary(0, 'keep_synced');
        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={summary} />);

        // Plan 02 §5.2: the machines lead; the folders are the secondary line.
        expect(screen.findByTestId('workspace-sync-relationship-relationship-1')?.props.title).toBe('Alpha Mac → Beta workstation');
        expect(metaLineOf(screen)).toContain('Alpha → Beta');
        const menu = screen.findAllByType('DropdownMenu')[0];
        expect(menu?.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'open-alpha', title: 'workspaceSync.actions.openOnMachine:{"machine":"Alpha Mac"}' }),
            expect.objectContaining({ id: 'open-beta', title: 'workspaceSync.actions.openOnMachine:{"machine":"Beta workstation"}' }),
            expect.objectContaining({ id: 'terminate', title: 'workspaceSync.actions.terminate', destructive: true }),
        ]));
        // Stopping the link is set apart from the routine actions.
        expect(menu?.props.separateCategories).toBe(true);
        const items = menu?.props.items as ReadonlyArray<{ id: string; category?: string }>;
        expect(new Set(items.filter((item) => item.id !== 'terminate').map((item) => item.category))).toEqual(new Set(['link']));
        expect(items.at(-1)).toMatchObject({ id: 'terminate', category: 'stop' });
    });

    it('tells two folders on the same machine apart in the open actions', async () => {
        const summary = createSummary(0, 'keep_synced');
        const sameNameSummary = {
            ...summary,
            beta: { ...summary.beta, machineName: summary.alpha.machineName },
        };
        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={sameNameSummary} />);

        const items = screen.findAllByType('DropdownMenu')[0]?.props.items as ReadonlyArray<{ id: string; title: string }>;
        const titles = items.filter((item) => item.id === 'open-alpha' || item.id === 'open-beta').map((item) => item.title);
        expect(new Set(titles).size).toBe(2);
        expect(titles[0]).toContain('Alpha');
        expect(titles[1]).toContain('Beta');
    });

    it('names the machine once when both folders live on the same machine', async () => {
        const summary = createSummary(0, 'keep_synced');
        const onOneMachine = {
            ...summary,
            beta: {
                ...summary.beta,
                workspaceRef: { ...summary.beta.workspaceRef!, machineId: summary.alpha.workspaceRef!.machineId },
                machineName: summary.alpha.machineName,
            },
        };
        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={onOneMachine} />);

        expect(screen.findByTestId('workspace-sync-relationship-relationship-1')?.props.title).toBe('Alpha Mac');
        expect(metaLineOf(screen)).toContain('Alpha → Beta');
        expect(metaLineOf(screen)).not.toContain('Alpha Mac');
    });

    it('keeps a generic attention message for an unmapped daemon error code', async () => {
        const summary = createSummary(0);
        if (!summary.status) throw new Error('expected relationship status fixture');
        summary.status.errorCode = 'indeterminate';

        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={summary} />);

        expect(statusOf(screen)).toMatchObject({ text: 'workspaceSync.error.needsAttention', tone: 'bad', action: 'retry' });
    });

    it('uses the existing details destination when its host surface has no pane callback', async () => {
        const summary = createSummary(0);
        const screen = await renderScreen(
            <WorkspaceSyncRelationshipRow summary={summary} localWorkspaceRefId="workspace-alpha" />,
        );

        await screen.pressByTestIdAsync('workspace-sync-relationship-relationship-1');
        expect(openDefaultDetailsSpy).toHaveBeenCalledWith(summary, 'workspace-alpha');
    });

    it('reveals only the endpoint rooted on this computer in the OS file manager', async () => {
        desktopHostState.isDesktop = true;
        invokeDesktopHostSpy.mockClear();
        mountedExecuteSpy.mockClear();
        const summary = createSummary(0);
        const screen = await renderScreen(
            <WorkspaceSyncRelationshipRow summary={summary} localMachineId="machine-alpha" />,
        );

        const menu = screen.findAllByType('DropdownMenu')[0];
        const items = menu?.props.items as ReadonlyArray<{ id: string; title: string }>;
        expect(items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'reveal-alpha', title: 'workspaceSync.actions.openFolder:{"label":"Alpha Mac"}' }),
        ]));
        expect(items.some((item) => item.id === 'reveal-beta')).toBe(false);

        menu?.props.onSelect('reveal-alpha');
        expect(mountedExecuteSpy).toHaveBeenCalledWith('relay.runtime.open_path', { path: '/alpha' });
        expect(invokeDesktopHostSpy).not.toHaveBeenCalled();

        desktopHostState.isDesktop = false;
    });
});

describe('WorkspaceSyncRelationshipList', () => {
    it('opens Add machine from Project availability without creating a Session', async () => {
        const onAddMachine = vi.fn();
        const screen = await renderScreen(
            <WorkspaceSyncRelationshipList workspaceRefId="workspace-alpha" onAddMachine={onAddMachine} />,
        );

        await screen.pressByTestIdAsync('workspace-sync-add-machine');
        expect(onAddMachine).toHaveBeenCalledOnce();
    });

    it('says what sync does and offers only its action when nothing is linked yet', async () => {
        const screen = await renderScreen(
            <WorkspaceSyncRelationshipList workspaceRefId="workspace-alpha" onAddMachine={vi.fn()} />,
        );

        const text = screen.getTextContent();
        expect(text).toContain('workspaceSync.title');
        expect(text).toContain('workspaceSync.emptyDescription');
        expect(screen.findByTestId('workspace-sync-add-machine')).toBeTruthy();
        // No dead row beside the action, and no mechanism text under it.
        expect(screen.findByTestId('workspace-sync-none')).toBeNull();
        expect(text).not.toContain('workspaceSync.footer');
    });

    it('keeps a quiet empty line where no action can be offered', async () => {
        const screen = await renderScreen(<WorkspaceSyncRelationshipList />);

        expect(screen.findByTestId('workspace-sync-none')).toBeTruthy();
    });
});
