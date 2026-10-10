import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { WorkspaceSyncRelationshipSummary } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const openDefaultDetailsSpy = vi.hoisted(() => vi.fn());

installSessionHandoffCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
                useWorkspaceRefs: () => [],
                useWorkspaceSyncRelationships: () => [],
                useMachineDisplayNamesById: () => ({}),
        });
    },
    typography: async () => ({
        FontWeights: { regular: '400', semiBold: '500', bold: '600' },
        Typography: new Proxy({}, { get: () => () => ({}) }),
    }),
    text: async () => ({
        t: (key: string, params?: Record<string, unknown>) => params
            ? `${key}:${JSON.stringify(params)}`
            : key,
    }),
});

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
            machineName: 'Alpha Mac',
        },
        beta: {
            workspaceRefId: 'workspace-beta',
            workspaceRef: { id: 'workspace-beta', serverId: 'server-1', machineId: 'machine-beta', rootPath: '/beta', label: 'Beta', createdAtMs: 1 },
            label: 'Beta',
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

describe('WorkspaceSyncRelationshipRow', () => {
    it('opens general details from every row while keeping conflict attention and actions row-scoped', async () => {
        const { WorkspaceSyncRelationshipRow } = await import('./WorkspaceSyncRelationshipList');
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

        const conflictAction = screen.findByTestId('workspace-sync-relationship-relationship-1-conflicts');
        const moreAction = screen.findByTestId('workspace-sync-relationship-relationship-1-actions');
        expect(conflictAction?.props.minimumInteractiveTargetSize).toBe(44);
        expect(moreAction?.props.minimumInteractiveTargetSize).toBe(44);
        await screen.pressByTestIdAsync('workspace-sync-relationship-relationship-1-conflicts');
        expect(openConflicts).toHaveBeenCalledWith(summary);
    });

    it('opens general details for a healthy relationship and does not invent conflict attention', async () => {
        const { WorkspaceSyncRelationshipRow } = await import('./WorkspaceSyncRelationshipList');
        const openDetails = vi.fn();
        const summary = createSummary(0);
        const screen = await renderScreen(
            <WorkspaceSyncRelationshipRow summary={summary} onOpenDetails={openDetails} />,
        );

        await screen.pressByTestIdAsync('workspace-sync-relationship-relationship-1');
        expect(openDetails).toHaveBeenCalledWith(summary);
        expect(screen.findByTestId('workspace-sync-relationship-relationship-1-conflicts')).toBeNull();
    });

    it('omits Last checked when no cycle observation exists', async () => {
        const { WorkspaceSyncRelationshipRow } = await import('./WorkspaceSyncRelationshipList');
        const summary = createSummary(0);
        if (!summary.status) throw new Error('expected relationship status fixture');
        summary.status.lastCycleObservedAtMs = null;

        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={summary} />);

        expect(screen.findByTestId('workspace-sync-relationship-relationship-1')?.props.subtitle)
            .not.toContain('workspaceSync.lastChecked');
    });

    it('uses one-way direction and machine display names for relationship and open actions', async () => {
        const { WorkspaceSyncRelationshipRow } = await import('./WorkspaceSyncRelationshipList');
        const summary = createSummary(0, 'keep_synced');
        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={summary} />);

        expect(screen.findByTestId('workspace-sync-relationship-relationship-1')?.props.title).toBe('Alpha → Beta');
        expect(screen.findByTestId('workspace-sync-relationship-relationship-1')?.props.subtitle).toContain('Alpha Mac → Beta workstation');
        const menu = screen.findAllByType('DropdownMenu')[0];
        expect(menu?.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'open-alpha', title: 'workspaceSync.actions.openOnMachine:{"machine":"Alpha Mac"}' }),
            expect.objectContaining({ id: 'open-beta', title: 'workspaceSync.actions.openOnMachine:{"machine":"Beta workstation"}' }),
            expect.objectContaining({ id: 'terminate', title: 'workspaceSync.actions.terminate' }),
        ]));
    });

    it('keeps a generic attention message for an unmapped daemon error code', async () => {
        const { WorkspaceSyncRelationshipRow } = await import('./WorkspaceSyncRelationshipList');
        const summary = createSummary(0);
        if (!summary.status) throw new Error('expected relationship status fixture');
        summary.status.errorCode = 'indeterminate';

        const screen = await renderScreen(<WorkspaceSyncRelationshipRow summary={summary} />);

        expect(screen.findByTestId('workspace-sync-relationship-relationship-1')?.props.subtitle)
            .toContain('workspaceSync.error.needsAttention');
    });

    it('uses the existing details destination when its host surface has no pane callback', async () => {
        const { WorkspaceSyncRelationshipRow } = await import('./WorkspaceSyncRelationshipList');
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
        const { WorkspaceSyncRelationshipRow } = await import('./WorkspaceSyncRelationshipList');
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
        expect(invokeDesktopHostSpy).toHaveBeenCalledWith('system_tasks_open_log_path', { path: '/alpha' });

        desktopHostState.isDesktop = false;
    });
});

describe('WorkspaceSyncRelationshipList', () => {
    it('opens Add machine from Project availability without creating a Session', async () => {
        const { WorkspaceSyncRelationshipList } = await import('./WorkspaceSyncRelationshipList');
        const onAddMachine = vi.fn();
        const screen = await renderScreen(
            <WorkspaceSyncRelationshipList workspaceRefId="workspace-alpha" onAddMachine={onAddMachine} />,
        );

        await screen.pressByTestIdAsync('workspace-sync-add-machine');
        expect(onAddMachine).toHaveBeenCalledOnce();
    });
});
