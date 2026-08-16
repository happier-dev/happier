import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    AgentInputExtraActionChip,
    AgentInputExtraActionChipRenderContext,
} from '@/components/sessions/agentInput/agentInputContracts';
import type {
    SelectionListOption,
    SelectionListStep,
} from '@/components/ui/selectionList';
import { renderScreen } from '@/dev/testkit';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import {
    findCheckoutChipOptionFromChip,
    getCheckoutChipRootStepFromChip,
    getCheckoutChipSectionOptionsFromChip,
    getCheckoutChipStaticSectionFromChip,
} from '../__tests__/checkoutChipSelectors';
import type { NewSessionCheckoutChipModel } from '../../modules/newSessionCheckoutChipModel';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';
import type {
    useNewSessionCheckoutActionChip as useNewSessionCheckoutActionChipType,
} from './useNewSessionCheckoutActionChip';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionScreenModelCommonModuleMocks();

vi.mock('@/scm/repository/repoScmBranchService', () => ({
    repoScmBranchService: {
        fetchBranchesForMachinePath: vi.fn(async () => []),
        readCachedBranchesForMachinePath: vi.fn(() => []),
    },
}));

type UseNewSessionCheckoutActionChipParams = Parameters<typeof useNewSessionCheckoutActionChipType>[0];

const DEFAULT_WORKTREES: NonNullable<ScmWorkingSnapshot['repo']['worktrees']> = [
    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
    { path: '/repo/.worktrees/release', branch: 'release', isCurrent: false },
];

function makeSnapshot(
    worktrees: NonNullable<ScmWorkingSnapshot['repo']['worktrees']> = DEFAULT_WORKTREES,
    overrides: Partial<ScmWorkingSnapshot['repo']> = {},
): ScmWorkingSnapshot {
    return {
        projectKey: 'project:/repo',
        fetchedAt: 1_700_000_000_000,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            worktrees,
            ...overrides,
        },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

function makeCheckoutChipModel(
    options: NewSessionCheckoutChipModel['options'] = [
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
    selectedOptionId: NewSessionCheckoutChipModel['selectedOptionId'] = 'current_path',
): NewSessionCheckoutChipModel {
    return { selectedOptionId, options };
}

function createStateSetter<T>(): React.Dispatch<React.SetStateAction<T>> {
    const setter: React.Dispatch<React.SetStateAction<T>> = vi.fn();
    return setter;
}

function makeDefaultParams(
    overrides: Partial<UseNewSessionCheckoutActionChipParams> = {},
): UseNewSessionCheckoutActionChipParams {
    return {
        repoScmSnapshot: makeSnapshot(),
        checkoutChipModel: makeCheckoutChipModel(),
        checkoutPickerOpen: true,
        setCheckoutPickerOpen: createStateSetter<boolean>(),
        checkoutCreationDraft: null,
        selectedMachineId: 'machine-1',
        selectedPath: '/repo/packages/app',
        setSelectedPath: createStateSetter<string>(),
        setCheckoutCreationDraft: createStateSetter(),
        pendingGitWorktreeBaseRefRef: { current: null },
        pendingGitWorktreeSourceKindRef: { current: 'current' },
        shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: true },
        router: { push: vi.fn() },
        ...overrides,
    };
}

async function renderCheckoutChip(
    overrides: Partial<UseNewSessionCheckoutActionChipParams> = {},
): Promise<AgentInputExtraActionChip | null> {
    const { useNewSessionCheckoutActionChip } = await import('./useNewSessionCheckoutActionChip');

    let chip: AgentInputExtraActionChip | null = null;
    function Probe() {
        chip = useNewSessionCheckoutActionChip(makeDefaultParams(overrides));
        return null;
    }

    await renderScreen(<Probe />);
    return chip;
}

function makeChipRenderContext(): AgentInputExtraActionChipRenderContext {
    return {
        chipStyle: () => ({}),
        showLabel: true,
        iconColor: '#000000',
        textStyle: {},
        countTextStyle: {},
        chipAnchorRef: React.createRef<unknown>(),
        popoverAnchorRef: React.createRef<unknown>(),
    };
}

function expectDrillDownOption(option: SelectionListOption | undefined): SelectionListStep {
    expect(option).toBeDefined();
    if (!option || !('openStep' in option) || option.openStep === undefined) {
        throw new Error('Expected a drill-down SelectionList option');
    }
    return option.openStep;
}

function getOptionIconColor(option: SelectionListOption | undefined): unknown {
    if (!option || !React.isValidElement<{ color?: string }>(option.icon)) {
        return undefined;
    }
    return option.icon.props.color;
}

describe('useNewSessionCheckoutActionChip', () => {
    beforeEach(() => {
        installNewSessionScreenModelCommonModuleMocks();
        vi.resetModules();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('emits a SelectionList collapsedOptionsPopover routing the worktree picker through presentation: list', async () => {
        const setSelectedPath = vi.fn();
        const setCheckoutCreationDraft = vi.fn();
        const setCheckoutPickerOpen = vi.fn();
        const shouldReconcileInitialHydratedCheckoutCreationDraftRef = { current: true };

        const chip = await renderCheckoutChip({
            setSelectedPath,
            setCheckoutCreationDraft,
            setCheckoutPickerOpen,
            shouldReconcileInitialHydratedCheckoutCreationDraftRef,
        });

        expect(chip).not.toBeNull();
        expect(chip?.collapsedOptionsPopover?.presentation).toBe('list');
        expect(chip?.collapsedOptionsPopover?.heightBehavior).toBe('stabilizedContentHeight');
        const rootStep = getCheckoutChipRootStepFromChip(chip);
        expect(rootStep?.id).toBe('worktree-root');

        const quickActionsSection = getCheckoutChipStaticSectionFromChip(chip, 'worktree:quick-actions');
        expect(quickActionsSection).toBeDefined();
        const currentPathOption = findCheckoutChipOptionFromChip(chip, 'worktree:quick-actions', 'current_path');
        expect(currentPathOption).toBeDefined();

        const existingIds = getCheckoutChipSectionOptionsFromChip(chip, 'worktree:existing')
            .map((option) => option.id);
        expect(existingIds).toContain('checkout:/repo/.worktrees/release');

        await act(async () => {
            currentPathOption?.onSelect?.();
        });

        expect(setCheckoutCreationDraft).toHaveBeenCalledWith(null);
        expect(setSelectedPath).toHaveBeenCalledWith('/repo/packages/app');
        expect(setCheckoutPickerOpen).toHaveBeenCalledWith(false);
        expect(shouldReconcileInitialHydratedCheckoutCreationDraftRef.current).toBe(false);
    });

    it('keeps worktree popover height intent platform-agnostic so the shared popover wrapper owns native sizing', async () => {
        vi.doMock('@/components/ui/selectionList', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/components/ui/selectionList')>();
            return {
                ...actual,
                resolvePopoverSelectionListHeightBehavior: () => 'measuredToMaxHeight',
            };
        });
        vi.resetModules();

        try {
            const chip = await renderCheckoutChip();

            expect(chip?.collapsedOptionsPopover?.heightBehavior).toBe('stabilizedContentHeight');
        } finally {
            vi.doUnmock('@/components/ui/selectionList');
        }
    });

    it('routes an existing-worktree selection back through setSelectedPath and closes the popover', async () => {
        const setSelectedPath = vi.fn();
        const setCheckoutCreationDraft = vi.fn();
        const setCheckoutPickerOpen = vi.fn();

        const chip = await renderCheckoutChip({
            repoScmSnapshot: makeSnapshot(DEFAULT_WORKTREES),
            checkoutChipModel: makeCheckoutChipModel([
                { id: 'current_path', kind: 'current_path', path: '/repo' },
                { id: 'create_git_worktree', kind: 'create_git_worktree' },
                {
                    id: 'checkout:/repo/.worktrees/release',
                    kind: 'linked_checkout',
                    path: '/repo/.worktrees/release',
                    displayName: 'release',
                    gitBranch: 'release',
                    checkoutKind: 'git_worktree',
                },
            ]),
            selectedPath: '/repo',
            setSelectedPath,
            setCheckoutCreationDraft,
            setCheckoutPickerOpen,
        });

        const releaseOption = findCheckoutChipOptionFromChip(chip, 'worktree:existing', 'checkout:/repo/.worktrees/release');

        await act(async () => {
            releaseOption?.onSelect?.();
        });

        expect(setSelectedPath).toHaveBeenCalledWith('/repo/.worktrees/release');
        expect(setCheckoutCreationDraft).toHaveBeenCalledWith(null);
        expect(setCheckoutPickerOpen).toHaveBeenCalledWith(false);
    });

    it('drills into the create-worktree substep via the openStep on the New Worktree row', async () => {
        const chip = await renderCheckoutChip({
            repoScmSnapshot: makeSnapshot([
                { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
            ]),
            checkoutChipModel: makeCheckoutChipModel([
                { id: 'current_path', kind: 'current_path', path: '/repo' },
                { id: 'create_git_worktree', kind: 'create_git_worktree' },
            ]),
            selectedPath: '/repo',
        });

        const createStep = expectDrillDownOption(
            findCheckoutChipOptionFromChip(chip, 'worktree:quick-actions', 'create_git_worktree'),
        );
        expect(createStep.id).toBe('worktree-create');
        const sectionIds = createStep.sections.map((section) => section.id);
        expect(sectionIds).toContain('worktree:branches:local');
        expect(sectionIds).toContain('worktree:branches:remote');
    });

    it('themes worktree picker row icons from the effective Unistyles theme', async () => {
        // This suite's shared hoisted mock is already instantiated by earlier tests; use the
        // canonical factory directly for this one isolated effective-theme override.
        vi.doMock('react-native-unistyles', async () => {
            const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
            return createUnistylesMock({
                theme: { colors: { text: { tertiary: '#123ABC' } } },
            });
        });
        vi.resetModules();

        const chip = await renderCheckoutChip({
            repoScmSnapshot: makeSnapshot(DEFAULT_WORKTREES),
            checkoutChipModel: makeCheckoutChipModel([
                { id: 'current_path', kind: 'current_path', path: '/repo' },
                { id: 'create_git_worktree', kind: 'create_git_worktree' },
            ]),
            selectedPath: '/repo',
        });

        const currentPathOption = findCheckoutChipOptionFromChip(chip, 'worktree:quick-actions', 'current_path');
        const releaseOption = findCheckoutChipOptionFromChip(chip, 'worktree:existing', 'checkout:/repo/.worktrees/release');

        expect(getOptionIconColor(currentPathOption)).toBe('#123ABC');
        expect(getOptionIconColor(releaseOption)).toBe('#123ABC');
    });

    it('rebuilds rootStep on the next minute tick (nowMs ticks via useNowMs)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-12T00:00:00.000Z'));
        try {
            const { useNewSessionCheckoutActionChip } = await import('./useNewSessionCheckoutActionChip');

            const captures: Array<SelectionListStep | undefined> = [];
            function Probe() {
                const chip = useNewSessionCheckoutActionChip(makeDefaultParams({
                    repoScmSnapshot: makeSnapshot([
                        { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    ]),
                    checkoutChipModel: makeCheckoutChipModel([
                        { id: 'current_path', kind: 'current_path', path: '/repo' },
                        { id: 'create_git_worktree', kind: 'create_git_worktree' },
                    ]),
                    checkoutPickerOpen: false,
                    selectedPath: '/repo',
                }));
                captures.push(getCheckoutChipRootStepFromChip(chip));
                return null;
            }

            await renderScreen(<Probe />);
            const initialRoot = captures[captures.length - 1];

            await act(async () => {
                vi.advanceTimersByTime(60_000);
            });

            const tickedRoot = captures[captures.length - 1];
            // The chip must rebuild rootStep when nowMs ticks (referential identity change),
            // so RelativeTimeText / stale recomputation observes the new clock.
            expect(tickedRoot).not.toBe(initialRoot);
            // ...but the rebuild describes the SAME destination. `SelectionList` keys its
            // "a rebuilt root is a refresh, not navigation" rule on the root step id
            // (`useSelectionListStepStack`), so a rebuild that changed the id would drain
            // the step stack and throw the user out of the worktree name step — losing the
            // name they were typing — once a minute.
            expect(tickedRoot?.id).toBe(initialRoot?.id);
        } finally {
            vi.useRealTimers();
        }
    });

    it('threads machineHomeDir through to buildWorktreeSelectionListSteps so tilde worktree paths match the absolute current dir', async () => {
        // Two worktrees: the "current" worktree is recorded with a tilde path (~/repo) by SCM
        // while the new-session screen tracks the canonicalized absolute path. Without
        // machineHomeDir threading, the builder cannot canonicalize ~/repo and would render the
        // current worktree as a row in the existing-worktree section. With machineHomeDir, it
        // suppresses the row.
        const chip = await renderCheckoutChip({
            repoScmSnapshot: makeSnapshot([
                { path: '~/repo', branch: 'main', isCurrent: false, isMain: false },
                { path: '/Users/leeroy/repo/.worktrees/release', branch: 'release', isCurrent: false },
            ], { rootPath: '/Users/leeroy/repo' }),
            checkoutChipModel: makeCheckoutChipModel([
                { id: 'current_path', kind: 'current_path', path: '/Users/leeroy/repo' },
                { id: 'create_git_worktree', kind: 'create_git_worktree' },
            ]),
            checkoutPickerOpen: false,
            selectedPath: '/Users/leeroy/repo',
            machineHomeDir: '/Users/leeroy',
        });

        const ids = getCheckoutChipSectionOptionsFromChip(chip, 'worktree:existing')
            .map((option) => option.id);
        // ~/repo (the canonical current dir under tilde) must be suppressed; only the release row remains.
        expect(ids).not.toContain('checkout:~/repo');
        expect(ids).toContain('checkout:/Users/leeroy/repo/.worktrees/release');
    });

    it('commits a custom worktree name from the name step into the creation draft', async () => {
        const setCheckoutCreationDraft = vi.fn();
        const repoScmBranchServiceModule = await import('@/scm/repository/repoScmBranchService');
        (repoScmBranchServiceModule.repoScmBranchService.fetchBranchesForMachinePath as ReturnType<typeof vi.fn>)
            .mockResolvedValue([{ name: 'main', type: 'local', upstream: null }]);

        const chip = await renderCheckoutChip({
            repoScmSnapshot: makeSnapshot([
                { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
            ]),
            checkoutChipModel: makeCheckoutChipModel([
                { id: 'current_path', kind: 'current_path', path: '/repo' },
                { id: 'create_git_worktree', kind: 'create_git_worktree' },
            ]),
            selectedPath: '/repo',
            setCheckoutCreationDraft,
        });

        const createStep = expectDrillDownOption(
            findCheckoutChipOptionFromChip(chip, 'worktree:quick-actions', 'create_git_worktree'),
        );
        const localSection = createStep.sections.find((section) => section.id === 'worktree:branches:local');
        if (localSection?.kind !== 'dynamic') throw new Error('local branches section must be dynamic');
        const resolved = await localSection.resolve('', new AbortController().signal);
        const branchOption = resolved.options.find((option) => option.id === 'branch:local:main');
        const nameStep = branchOption && 'openStep' in branchOption ? branchOption.openStep : undefined;
        expect(nameStep?.id).toBe('worktree-name');
        expect(nameStep?.inputMode).toBe('value');

        await act(async () => {
            nameStep?.onCommitInputValue?.('My Custom Name');
        });

        expect(setCheckoutCreationDraft).toHaveBeenCalledTimes(1);
        const updater = setCheckoutCreationDraft.mock.calls[0]![0] as (current: unknown) => unknown;
        // The typed name is git-sanitized and stored as the authoritative draft displayName.
        expect(updater(null)).toEqual({
            kind: 'git_worktree',
            displayName: 'My-Custom-Name',
            baseRef: 'main',
            branchMode: 'new',
        });
    });

    it('selects a "New worktree: <name>" pending row at the top when a creation draft is set', async () => {
        const chip = await renderCheckoutChip({
            repoScmSnapshot: makeSnapshot([
                { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
            ]),
            checkoutChipModel: makeCheckoutChipModel([
                { id: 'current_path', kind: 'current_path', path: '/repo' },
                { id: 'create_git_worktree', kind: 'create_git_worktree' },
            ], 'create_git_worktree'),
            selectedPath: '/repo',
            checkoutCreationDraft: { kind: 'git_worktree', displayName: 'clever-cloud', baseRef: 'main', branchMode: 'new' },
        });

        // The popover highlights the synthetic pending row (not the generic create entry).
        expect(chip?.collapsedOptionsPopover?.selectedOptionId).toBe('pending_git_worktree');
        expect(chip?.collapsedOptionsPopover?.label).toContain('clever-cloud');
        const pendingRow = findCheckoutChipOptionFromChip(chip, 'worktree:pending', 'pending_git_worktree');
        expect(pendingRow?.label).toContain('clever-cloud');
    });

    it('returns null when the SCM snapshot does not indicate a git repository', async () => {
        const chip = await renderCheckoutChip({
            repoScmSnapshot: null,
            checkoutChipModel: makeCheckoutChipModel([
                { id: 'current_path', kind: 'current_path', path: '/repo' },
            ]),
            checkoutPickerOpen: false,
            selectedMachineId: null,
            selectedPath: '/repo',
            shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: false },
        });

        expect(chip).toBeNull();
    });

    /**
     * The chip descriptor is rebuilt whenever any of its inputs move — including the once-a-minute
     * `useNowMs` tick that keeps the picker's relative times fresh. If the rendered chip component
     * were minted inside that rebuild, its type would change with it and React would unmount and
     * remount the chip on a timer, discarding its press state and re-firing its popover-bridging
     * effect. The component type must survive a rebuild; only the descriptor may be new.
     */
    it('renders the same chip component type across descriptor rebuilds', async () => {
        const { useNewSessionCheckoutActionChip } = await import('./useNewSessionCheckoutActionChip');

        const chipRef: { current: AgentInputExtraActionChip | null } = { current: null };
        let selectAnotherPath: (() => void) | null = null;
        function Probe() {
            const [selectedPath, setSelectedPath] = React.useState('/repo/packages/app');
            selectAnotherPath = () => setSelectedPath('/repo/packages/other');
            chipRef.current = useNewSessionCheckoutActionChip(makeDefaultParams({ selectedPath }));
            return null;
        }

        await renderScreen(<Probe />);
        const before = chipRef.current?.render(makeChipRenderContext());
        const beforeDescriptor = chipRef.current;

        await act(async () => {
            selectAnotherPath?.();
        });

        const after = chipRef.current?.render(makeChipRenderContext());
        expect(chipRef.current).not.toBe(beforeDescriptor);
        if (!React.isValidElement(before) || !React.isValidElement(after)) {
            throw new Error('Expected the checkout chip to render a React element');
        }
        expect(after.type).toBe(before.type);
    });

    /**
     * The bridge used to ride on the remount the previous test now prevents, so it has to fire from
     * a state change instead. Opening the picker must still hand the chip to the shared overlay
     * controller and clear the legacy flag.
     */
    it('bridges the auto-open picker state into the shared popover controller when it opens', async () => {
        const { useNewSessionCheckoutActionChip } = await import('./useNewSessionCheckoutActionChip');

        const toggleCollapsedPopover = vi.fn();
        const setCheckoutPickerOpen = vi.fn();
        let openPicker: (() => void) | null = null;

        function Probe() {
            const [checkoutPickerOpen, setOpen] = React.useState(false);
            openPicker = () => setOpen(true);
            // Identity-stable, exactly as the screen model's own `useState` setter is: a fresh
            // setter each render would re-run the bridge effect on its own and hide a missing
            // `checkoutPickerOpen` dependency.
            const stableSetCheckoutPickerOpen = React.useCallback((next: React.SetStateAction<boolean>) => {
                setCheckoutPickerOpen(next);
                setOpen(false);
            }, []);
            const chip = useNewSessionCheckoutActionChip(makeDefaultParams({
                checkoutPickerOpen,
                setCheckoutPickerOpen: stableSetCheckoutPickerOpen,
            }));
            return <>{chip?.render({ ...makeChipRenderContext(), toggleCollapsedPopover })}</>;
        }

        await renderScreen(<Probe />);
        expect(toggleCollapsedPopover).not.toHaveBeenCalled();

        await act(async () => {
            openPicker?.();
        });

        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-checkout');
        expect(setCheckoutPickerOpen).toHaveBeenCalledWith(false);
    });
});
