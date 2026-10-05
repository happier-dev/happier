import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SelectionListStep } from '@/components/ui/selectionList';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { authoringMemoryDefaults } from '@/sync/store/domains/authoringMemory';
import { settingsDefaults } from '@/sync/domains/settings/settings';

/**
 * The Workflow "Where" row consumes New Session's project/checkout owners.
 *
 * Only genuine boundaries are replaced: the Machine list picker and the
 * SelectionList popover (virtualized list/portal UI, rendered here as the step
 * they are handed), the Machine path browser modal, and the SCM repository
 * service RPC. The checkout model, the one checkout picker builder, the
 * default-directory policy and the Workflow project adapter all run for real.
 */

const browser = vi.hoisted(() => ({ open: vi.fn() }));
const scm = vi.hoisted(() => ({ snapshot: null as ScmWorkingSnapshot | null }));

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
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));
vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: (props: Record<string, unknown>) => React.createElement('MachineSelector', props),
}));
vi.mock('@/components/sessions/agentInput/components/AgentInputSelectionListPopover', () => ({
    AgentInputSelectionListPopover: (props: Record<string, unknown>) => (
        props.open === true ? React.createElement('SelectionListPopover', props) : null
    ),
}));
// The anchored popover's portal and measurement are a platform boundary; its content stays real.
vi.mock('@/components/ui/popover/Popover', () => ({
    Popover: (props: { open: boolean; children: (render: unknown) => React.ReactNode }) =>
        (props.open ? React.createElement(React.Fragment, null, props.children({})) : null),
}));
vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: browser.open,
}));
vi.mock('@/scm/scmRepositoryService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/scm/scmRepositoryService')>();
    return {
        ...actual,
        scmRepositoryService: {
            readCachedSnapshotForMachinePath: () => scm.snapshot,
            readCachedWorktreesEnrichment: () => null,
            fetchSnapshotForMachinePath: async () => scm.snapshot,
            fetchWorktreesEnrichment: async () => null,
        },
    };
});

const MACHINES = [
    { id: 'machine-1', metadata: { displayName: 'Mac Studio', homeDir: '/Users/me', platform: 'darwin' } },
    { id: 'machine-2', metadata: { displayName: 'Linux box', homeDir: '/home/me', platform: 'linux' } },
];

function repoSnapshot(): ScmWorkingSnapshot {
    return {
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
    } as unknown as ScmWorkingSnapshot;
}

function workspaceRef(id: string, rootPath: string) {
    return { id, machineId: 'machine-1', serverId: 'server-a', rootPath, createdAtMs: 1 };
}

beforeEach(() => {
    browser.open.mockReset();
    scm.snapshot = repoSnapshot();
    const workspaceRefs = [
            workspaceRef('ref-main', '/repo/payments'),
            workspaceRef('ref-feature', '/repo/payments-feature-auth'),
        ];
    storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' },
        settings: { ...settingsDefaults, workspaceRefsV1: workspaceRefs },
        authoringMemory: { ...authoringMemoryDefaults, recentMachinePaths: [{ machineId: 'machine-2', path: '/home/me/service' }] } });
});

afterEach(async () => {
    await standardCleanup();
});

async function renderControl(props: Readonly<Record<string, unknown>>) {
    const { WorkflowProjectTargetControl } = await import('./WorkflowProjectTargetControl');
    return renderScreen(React.createElement(WorkflowProjectTargetControl, {
        machineName: 'Mac Studio',
        machines: MACHINES,
        testIDPrefix: 'workflow-editor',
        ...props,
    } as never));
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
        await act(async () => {});

        await screen.pressByTestIdAsync('workflow-editor-project-checkout');
        const popover = screen.root.findByType('SelectionListPopover' as never);
        const rootStep = popover.props.rootStep as SelectionListStep;

        // A new worktree is the Workspace policy's job here, so the picker offers
        // existing checkouts only — never a create path the project cannot carry.
        expect(stepOptions(rootStep, 'worktree:quick-actions').map((option) => option.id))
            .toEqual(['current_path']);
        const feature = stepOptions(rootStep, 'worktree:existing')
            .find((option) => option.subtitle === '/repo/payments-feature-auth');
        await act(async () => {
            feature?.onSelect?.();
        });

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

        await act(async () => {
            screen.root.findByType('MachineSelector' as never).props.onSelect(MACHINES[1]);
        });

        expect(onChange).toHaveBeenCalledWith({ machineId: 'machine-2', directory: '/home/me/service' });
    });

    it('applies a browsed folder only to the target it was opened for', async () => {
        const picked = createDeferred<string | null>();
        browser.open.mockImplementationOnce(() => picked.promise);
        const onChange = vi.fn();
        const opened = { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' };
        const screen = await renderControl({ target: opened, onChange });

        await screen.pressByTestIdAsync('workflow-editor-project-directory');
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
            picked.resolve('/repo/other');
            await picked.promise;
        });

        expect(onChange).not.toHaveBeenCalled();
    });

    it('drops a stale project binding when a browsed folder names another project', async () => {
        browser.open.mockResolvedValueOnce('/Users/me/unbound');
        const onChange = vi.fn();
        const screen = await renderControl({
            target: { machineId: 'machine-1', directory: '/repo/payments', workspaceRefId: 'ref-main' },
            onChange,
        });

        await screen.pressByTestIdAsync('workflow-editor-project-directory');
        await act(async () => {});

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
        expect(screen.getTextContent()).toContain('Mac Studio / ~/project');
        expect(screen.getTextContent()).not.toContain('/Users/me/project');
        expect(screen.root.findAllByType('MachineSelector' as never)).toHaveLength(0);
        expect(screen.findByTestId('workflow-editor-project-directory')).toBeNull();

        await screen.pressByTestIdAsync('workflow-editor-machine-row');
        expect(screen.findByTestId('workflow-editor-where-popover')).not.toBeNull();
        await act(async () => {
            screen.root.findByType('MachineSelector' as never).props.onSelect(MACHINES[1]);
        });
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
