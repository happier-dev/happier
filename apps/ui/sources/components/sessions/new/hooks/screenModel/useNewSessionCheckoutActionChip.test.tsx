import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';


globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionScreenModelCommonModuleMocks();

vi.mock('@/components/sessions/new/components/NewSessionWorktreeBranchDetail', () => ({
    NewSessionWorktreeBranchDetail: (props: Record<string, unknown>) => React.createElement('NewSessionWorktreeBranchDetail', props),
}));

describe('useNewSessionCheckoutActionChip', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('applies no-worktree immediately and groups existing worktrees under a single picker mode', async () => {
        const setSelectedPath = vi.fn();
        const setCheckoutCreationDraft = vi.fn();
        const setCheckoutPickerOpen = vi.fn();
        const shouldReconcileInitialHydratedCheckoutCreationDraftRef = { current: true };

        const { useNewSessionCheckoutActionChip } = await import('./useNewSessionCheckoutActionChip');

        let chip: any = null;
        function Probe() {
            chip = useNewSessionCheckoutActionChip({
                repoScmSnapshot: {
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        worktrees: [
                            { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                            { path: '/repo/.worktrees/release', branch: 'release', isCurrent: false },
                        ],
                    },
                    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                } as any,
                checkoutChipModel: {
                    selectedOptionId: 'current_path',
                    options: [
                        { id: 'current_path', kind: 'current_path', path: '/repo/packages/app' },
                        { id: 'create_git_worktree', kind: 'create_git_worktree' },
                        {
                            id: 'checkout:/repo/.worktrees/release',
                            kind: 'linked_checkout',
                            path: '/repo/.worktrees/release',
                            displayName: 'release',
                            gitBranch: 'release',
                            checkoutKind: 'git_worktree',
                        },
                    ],
                },
                checkoutPickerOpen: true,
                setCheckoutPickerOpen,
                checkoutCreationDraft: { kind: 'git_worktree', displayName: 'feature-auth', baseRef: 'main', branchMode: 'new' },
                selectedMachineId: 'machine-1',
                selectedPath: '/repo/packages/app',
                setSelectedPath,
                setCheckoutCreationDraft,
                pendingGitWorktreeBaseRefRef: { current: null },
                pendingGitWorktreeSourceKindRef: { current: 'current' },
                shouldReconcileInitialHydratedCheckoutCreationDraftRef,
                router: { push: vi.fn() },
            });
            return null;
        }

        await renderScreen(<Probe />);

        const currentPathOption = chip.collapsedOptionsPopover.options.find((option: any) => option.id === 'current_path');
        const existingModeOption = chip.collapsedOptionsPopover.options.find((option: any) => option.id === '__existing_worktree__');

        expect(currentPathOption.onSelectImmediate).toBeTypeOf('function');
        expect(existingModeOption.detailSelectOptions).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'checkout:/repo/.worktrees/release' }),
        ]));

        await act(async () => {
            currentPathOption.onSelectImmediate();
        });

        expect(setCheckoutCreationDraft).toHaveBeenCalledWith(null);
        expect(setSelectedPath).toHaveBeenCalledWith('/repo/packages/app');
        expect(setCheckoutPickerOpen).toHaveBeenCalledWith(false);
        expect(shouldReconcileInitialHydratedCheckoutCreationDraftRef.current).toBe(false);
    });

    it('offers to reuse an existing sibling worktree when the selected branch already has one', async () => {
        const setSelectedPath = vi.fn();
        const setCheckoutCreationDraft = vi.fn();
        const setCheckoutPickerOpen = vi.fn();

        const { useNewSessionCheckoutActionChip } = await import('./useNewSessionCheckoutActionChip');

        let chip: any = null;
        function Probe() {
            chip = useNewSessionCheckoutActionChip({
                repoScmSnapshot: {
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        worktrees: [
                            { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                            { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                        ],
                    },
                    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                } as any,
                checkoutChipModel: {
                    selectedOptionId: 'create_git_worktree',
                    options: [
                        { id: 'current_path', kind: 'current_path', path: '/repo' },
                        { id: 'create_git_worktree', kind: 'create_git_worktree' },
                    ],
                },
                checkoutPickerOpen: true,
                setCheckoutPickerOpen,
                checkoutCreationDraft: null,
                selectedMachineId: 'machine-1',
                selectedPath: '/repo/packages/app',
                setSelectedPath,
                setCheckoutCreationDraft,
                pendingGitWorktreeBaseRefRef: { current: 'feature/auth' },
                pendingGitWorktreeSourceKindRef: { current: 'local' },
                shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: true },
                router: { push: vi.fn() },
            });
            return null;
        }

        await renderScreen(<Probe />);

        const newWorktreeOption = chip.collapsedOptionsPopover.options.find((option: any) => option.id === 'create_git_worktree');
        expect(newWorktreeOption.detailActionLabel).toBe('newSession.checkout.useExistingWorktreeAction');

        await act(async () => {
            newWorktreeOption.onDetailAction();
        });

        expect(setCheckoutCreationDraft).toHaveBeenCalledWith(null);
        expect(setSelectedPath).toHaveBeenCalledWith('/repo/.worktrees/feature-auth');
    });

    it('keeps applying new worktree creation from the selected branch even when a reusable worktree exists', async () => {
        const setCheckoutCreationDraft = vi.fn();

        const { useNewSessionCheckoutActionChip } = await import('./useNewSessionCheckoutActionChip');

        let chip: any = null;
        function Probe() {
            chip = useNewSessionCheckoutActionChip({
                repoScmSnapshot: {
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        worktrees: [
                            { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                            { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                        ],
                    },
                    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                } as any,
                checkoutChipModel: {
                    selectedOptionId: 'create_git_worktree',
                    options: [
                        { id: 'current_path', kind: 'current_path', path: '/repo' },
                        { id: 'create_git_worktree', kind: 'create_git_worktree' },
                    ],
                },
                checkoutPickerOpen: true,
                setCheckoutPickerOpen: vi.fn(),
                checkoutCreationDraft: null,
                selectedMachineId: 'machine-1',
                selectedPath: '/repo',
                setSelectedPath: vi.fn(),
                setCheckoutCreationDraft,
                pendingGitWorktreeBaseRefRef: { current: 'feature/auth' },
                pendingGitWorktreeSourceKindRef: { current: 'local' },
                shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: true },
                router: { push: vi.fn() },
            });
            return null;
        }

        await renderScreen(<Probe />);

        const newWorktreeOption = chip.collapsedOptionsPopover.options.find((option: any) => option.id === 'create_git_worktree');
        await act(async () => {
            newWorktreeOption.onApply();
        });

        expect(setCheckoutCreationDraft).toHaveBeenCalledTimes(1);
        const updater = setCheckoutCreationDraft.mock.calls[0][0];
        expect(updater(null)).toEqual({
            kind: 'git_worktree',
            displayName: expect.any(String),
            baseRef: 'feature/auth',
            branchMode: 'new',
        });
    });

    it('recomputes reusable-worktree actions after selecting a base branch in the detail pane', async () => {
        const setSelectedPath = vi.fn();
        const setCheckoutCreationDraft = vi.fn();
        const setCheckoutPickerOpen = vi.fn();
        const pendingGitWorktreeBaseRefRef = { current: null as string | null };
        const pendingGitWorktreeSourceKindRef = { current: 'current' as 'current' | 'local' | 'remote' };

        const { useNewSessionCheckoutActionChip } = await import('./useNewSessionCheckoutActionChip');

        let chip: any = null;
        function Probe() {
            chip = useNewSessionCheckoutActionChip({
                repoScmSnapshot: {
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        worktrees: [
                            { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                            { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                        ],
                    },
                    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                } as any,
                checkoutChipModel: {
                    selectedOptionId: 'create_git_worktree',
                    options: [
                        { id: 'current_path', kind: 'current_path', path: '/repo' },
                        { id: 'create_git_worktree', kind: 'create_git_worktree' },
                    ],
                },
                checkoutPickerOpen: true,
                setCheckoutPickerOpen,
                checkoutCreationDraft: null,
                selectedMachineId: 'machine-1',
                selectedPath: '/repo/packages/app',
                setSelectedPath,
                setCheckoutCreationDraft,
                pendingGitWorktreeBaseRefRef,
                pendingGitWorktreeSourceKindRef,
                shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: true },
                router: { push: vi.fn() },
            });
            return null;
        }

        await renderScreen(<Probe />);

        const getCreateOption = () => chip.collapsedOptionsPopover.options.find((option: any) => option.id === 'create_git_worktree');

        expect(getCreateOption().detailActionLabel).toBeUndefined();

        const detailElement = getCreateOption().renderDetailContent?.() as React.ReactElement<{
            onSelectionChange?: (selection: { baseRef: string | null; sourceKind: 'current' | 'local' | 'remote' }) => void;
        }>;

        await act(async () => {
            detailElement.props.onSelectionChange?.({ baseRef: 'feature/auth', sourceKind: 'local' });
        });

        expect(getCreateOption().detailActionLabel).toBe('newSession.checkout.useExistingWorktreeAction');

        await act(async () => {
            getCreateOption().onDetailAction?.();
        });

        expect(setCheckoutCreationDraft).toHaveBeenCalledWith(null);
        expect(setSelectedPath).toHaveBeenCalledWith('/repo/.worktrees/feature-auth');
    });

    it('offers to use a local branch directly when it is not already checked out in another worktree', async () => {
        const setCheckoutCreationDraft = vi.fn();

        const { useNewSessionCheckoutActionChip } = await import('./useNewSessionCheckoutActionChip');

        let chip: any = null;
        function Probe() {
            chip = useNewSessionCheckoutActionChip({
                repoScmSnapshot: {
                    repo: {
                        isRepo: true,
                        rootPath: '/repo',
                        backendId: 'git',
                        mode: '.git',
                        worktrees: [
                            { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                        ],
                    },
                    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                } as any,
                checkoutChipModel: {
                    selectedOptionId: 'create_git_worktree',
                    options: [
                        { id: 'current_path', kind: 'current_path', path: '/repo' },
                        { id: 'create_git_worktree', kind: 'create_git_worktree' },
                    ],
                },
                checkoutPickerOpen: true,
                setCheckoutPickerOpen: vi.fn(),
                checkoutCreationDraft: null,
                selectedMachineId: 'machine-1',
                selectedPath: '/repo',
                setSelectedPath: vi.fn(),
                setCheckoutCreationDraft,
                pendingGitWorktreeBaseRefRef: { current: 'feature/auth' },
                pendingGitWorktreeSourceKindRef: { current: 'local' },
                shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: true },
                router: { push: vi.fn() },
            });
            return null;
        }

        await renderScreen(<Probe />);

        const newWorktreeOption = chip.collapsedOptionsPopover.options.find((option: any) => option.id === 'create_git_worktree');
        expect(newWorktreeOption.detailActionLabel).toBe('newSession.checkout.useExistingBranchAction');

        await act(async () => {
            newWorktreeOption.onDetailAction();
        });

        expect(setCheckoutCreationDraft).toHaveBeenCalledTimes(1);
        const updater = setCheckoutCreationDraft.mock.calls[0][0];
        expect(updater(null)).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: null,
            branchMode: 'existing',
        });
    });
});
