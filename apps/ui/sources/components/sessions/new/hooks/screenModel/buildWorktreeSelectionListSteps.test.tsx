import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';

installNewSessionScreenModelCommonModuleMocks();

type RepoScmBranchServiceMockShape = {
    repoScmBranchService: {
        fetchBranchesForMachinePath: ReturnType<typeof vi.fn>;
        readCachedBranchesForMachinePath: ReturnType<typeof vi.fn>;
    };
};

vi.mock('@/scm/repository/repoScmBranchService', () => {
    const fetchBranchesForMachinePath = vi.fn(async () => []);
    const readCachedBranchesForMachinePath = vi.fn(() => []);
    return {
        repoScmBranchService: {
            fetchBranchesForMachinePath,
            readCachedBranchesForMachinePath,
        },
    } satisfies RepoScmBranchServiceMockShape;
});

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type {
    SelectionListDynamicSection,
    SelectionListOption,
    SelectionListSection,
    SelectionListStep,
} from '@/components/ui/selectionList';

const TEST_ROW_ICON_COLOR = '#456DEF';

function makeSnapshot(overrides?: Partial<ScmWorkingSnapshot['repo']>): ScmWorkingSnapshot {
    return {
        projectKey: 'test-project',
        fetchedAt: 1_700_000_000_000,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            worktrees: [
                { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
            ],
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

function findStaticSection(step: SelectionListStep, sectionId: string): SelectionListSection | undefined {
    const section = step.sections.find((candidate) => candidate.id === sectionId);
    return section?.kind === 'static' ? section : undefined;
}

function requireStaticSection(step: SelectionListStep, sectionId: string): SelectionListSection {
    const section = findStaticSection(step, sectionId);
    if (!section) throw new Error(`${sectionId} must be static`);
    return section;
}

function requireOption(section: SelectionListSection, optionId: string): SelectionListOption {
    const option = section.options.find((candidate) => candidate.id === optionId);
    if (!option) throw new Error(`${optionId} option must exist`);
    return option;
}

function requireOpenStep(option: SelectionListOption): SelectionListStep {
    const openStep = option.openStep;
    if (!openStep) throw new Error(`${option.id} must open a SelectionList step`);
    return openStep;
}

function requireCreateWorktreeStep(rootStep: SelectionListStep): SelectionListStep {
    const quickActions = requireStaticSection(rootStep, 'worktree:quick-actions');
    return requireOpenStep(requireOption(quickActions, 'create_git_worktree'));
}

function requireDynamicSection(step: SelectionListStep, sectionId: string): SelectionListDynamicSection {
    const section = step.sections.find((candidate) => candidate.id === sectionId);
    if (section?.kind !== 'dynamic') throw new Error(`${sectionId} must be dynamic`);
    return section;
}

describe('buildWorktreeSelectionListSteps', () => {
    it('exposes a root step with quick-actions, an existing-worktrees section, and a create-worktree drilldown', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const onSelectCurrentDir = vi.fn();
        const onSelectExistingWorktree = vi.fn();
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();

        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/release', branch: 'release', isCurrent: false },
                ],
            }),
            currentDirPath: '/repo/packages/app',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir,
            onSelectExistingWorktree,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        expect(rootStep.id).toBe('worktree-root');
        // First section: quick actions (use-current-dir + create-new-worktree drill-down).
        const sectionIds = rootStep.sections.map((s) => s.id);
        expect(sectionIds).toContain('worktree:quick-actions');
        expect(sectionIds).toContain('worktree:existing');

        const quickActions = requireStaticSection(rootStep, 'worktree:quick-actions');
        const optionIds = quickActions.options.map((o) => o.id);
        expect(optionIds).toEqual(expect.arrayContaining(['current_path', 'create_git_worktree']));

        const currentDirOption = requireOption(quickActions, 'current_path');
        expect(currentDirOption?.onSelect).toBeTypeOf('function');
        currentDirOption?.onSelect?.();
        expect(onSelectCurrentDir).toHaveBeenCalledTimes(1);

        const createWorktreeOption = requireOption(quickActions, 'create_git_worktree');
        expect(createWorktreeOption?.openStep).toBeDefined();
        expect(createWorktreeOption?.openStep?.id).toBe('worktree-create');

        const existingWorktrees = requireStaticSection(rootStep, 'worktree:existing');
        const existingIds = existingWorktrees.options.map((o) => o.id);
        // The current-dir worktree is the main root; the OTHER worktree should be listed.
        expect(existingIds).toContain('checkout:/repo/.worktrees/release');

        const releaseOption = requireOption(existingWorktrees, 'checkout:/repo/.worktrees/release');
        releaseOption?.onSelect?.();
        expect(onSelectExistingWorktree).toHaveBeenCalledWith('/repo/.worktrees/release');
    });

    it('routes branch selection through the reuse callback when a worktree already exists for the branch', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');

        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();

        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                ],
            }),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        const createStep = requireCreateWorktreeStep(rootStep);
        expect(createStep.sections).toBeDefined();

        // Find a dynamic section that resolves branches. We assert: when buildBranchOption (or
        // synthesised option for a branch already on a worktree) is invoked, onSelect routes to
        // the reuse callback.
        const branchesSection = createStep.sections.find((s) => s.id === 'worktree:branches:local' || s.id === 'worktree:branches');
        expect(branchesSection).toBeDefined();
        expect(branchesSection?.kind).toBe('dynamic');

        // The builder exposes a `buildBranchOption` helper that callers can use to test the
        // reuse-vs-create routing without invoking the live resolver.
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const reuseOption = buildWorktreeBranchOption({
            branch: { name: 'feature/auth', type: 'local', upstream: null },
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                ],
            }),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        reuseOption.onSelect?.();
        expect(onReuseExistingWorktreeForBranch).toHaveBeenCalledWith({
            worktreePath: '/repo/.worktrees/feature-auth',
            branch: 'feature/auth',
        });
        expect(onSelectBranchForNewWorktree).not.toHaveBeenCalled();
    });

    it('routes branch selection through the create callback when no worktree exists for the branch yet', async () => {
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();

        const option = buildWorktreeBranchOption({
            branch: { name: 'feature/new', type: 'local', upstream: null },
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                ],
            }),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        option.onSelect?.();
        expect(onSelectBranchForNewWorktree).toHaveBeenCalledWith({
            branchName: 'feature/new',
            sourceKind: 'local',
        });
        expect(onReuseExistingWorktreeForBranch).not.toHaveBeenCalled();
    });

    it('resolves worktree status variants from changeCount and lastActivityAt', async () => {
        const { resolveWorktreeStatusVariant } = await import('./worktreeExistingOptions');
        const now = 1_700_000_000_000;
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

        expect(resolveWorktreeStatusVariant({ changeCount: undefined, lastActivityAt: undefined, nowMs: now })).toBeNull();
        expect(resolveWorktreeStatusVariant({ changeCount: 3, lastActivityAt: now, nowMs: now })).toBe('dirty');
        expect(resolveWorktreeStatusVariant({ changeCount: 0, lastActivityAt: now - sevenDaysMs - 1, nowMs: now })).toBe('stale');
        expect(resolveWorktreeStatusVariant({ changeCount: 0, lastActivityAt: now, nowMs: now })).toBe('clean');
        expect(resolveWorktreeStatusVariant({ changeCount: 0, lastActivityAt: undefined, nowMs: now })).toBe('clean');
    });

    // ---- R10: Blocker 1 — canonical path normalization in current/reuse detection ----

    it('R10: treats trailing-slash variants of currentDirPath as the same worktree (suppresses self-row)', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    // Same path as currentDirPath but with a trailing separator — must still be elided.
                    { path: '/repo/.worktrees/feature/', branch: 'feature', isCurrent: false },
                ],
            }),
            currentDirPath: '/repo/.worktrees/feature',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });

        const existing = rootStep.sections.find((s) => s.id === 'worktree:existing');
        // The trailing-slash worktree IS the current dir, so the entire existing-worktrees section
        // should be omitted (the only entry would have been suppressed).
        expect(existing).toBeUndefined();
    });

    it('R10: treats backslash-separator paths as equivalent to forward-slash (Windows-style match)', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                rootPath: 'C:/Users/foo',
                worktrees: [
                    { path: 'C:/Users/foo', branch: 'main', isCurrent: true, isMain: true },
                    { path: 'C:\\Users\\foo\\.worktrees\\feature', branch: 'feature', isCurrent: false },
                ],
            }),
            currentDirPath: 'C:/Users/foo/.worktrees/feature',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: 'C:/Users/foo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });

        // The backslash worktree resolves to the same canonical path as currentDirPath, so the
        // existing-worktrees section must be omitted.
        const existing = rootStep.sections.find((s) => s.id === 'worktree:existing');
        expect(existing).toBeUndefined();
    });

    it('R10: expands tilde currentDirPath against machineHomeDir for self-row suppression', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/Users/leeroy/foo', branch: 'feature', isCurrent: false },
                ],
            }),
            // Tilde-form input matches the absolute worktree path once expanded.
            currentDirPath: '~/foo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineHomeDir: '/Users/leeroy',
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });

        const existing = rootStep.sections.find((s) => s.id === 'worktree:existing');
        // /Users/leeroy/foo === ~/foo (after expansion), so this worktree should be suppressed.
        expect(existing).toBeUndefined();
    });

    it('R10: branch row routes to reuse only when the existing worktree is not the canonical current dir', async () => {
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();

        // Existing worktree path differs from currentDirPath only by trailing slash & separator.
        // Canonically they ARE the same dir, so we must NOT route to reuse.
        const option = buildWorktreeBranchOption({
            branch: { name: 'feature/auth', type: 'local', upstream: null },
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature/', branch: 'feature/auth', isCurrent: false },
                ],
            }),
            currentDirPath: '/repo/.worktrees/feature',
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        option.onSelect?.();
        expect(onReuseExistingWorktreeForBranch).not.toHaveBeenCalled();
        expect(onSelectBranchForNewWorktree).toHaveBeenCalledWith({
            branchName: 'feature/auth',
            sourceKind: 'local',
        });
    });

    // ---- R10: Blocker 2 — dirty-status pill must not duplicate the count ----

    it('R10: dirty worktree row passes count alone (no count duplication via the localized label)', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    {
                        path: '/repo/.worktrees/feature',
                        branch: 'feature',
                        isCurrent: false,
                        changeCount: 3,
                        lastActivityAt: 1_700_000_000_000,
                    },
                ],
            }),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });

        const existing = rootStep.sections.find((s) => s.id === 'worktree:existing');
        if (existing?.kind !== 'static') throw new Error('existing must be static');
        const row = existing.options.find((o) => o.id === 'checkout:/repo/.worktrees/feature');
        expect(row).toBeDefined();
        const accessory = row!.rightAccessory as React.ReactElement;
        // The accessory is a fragment containing <RelativeTimeText/> and <StatusPill/>.
        // Walk children to find the StatusPill and read its props.
        const fragmentChildren = React.Children.toArray((accessory.props as { children: React.ReactNode }).children);
        const pillElement = fragmentChildren.find(
            (child): child is React.ReactElement<Record<string, unknown>> =>
                React.isValidElement(child)
                && (child.props as { testID?: string }).testID === 'worktree-row-status:/repo/.worktrees/feature',
        );
        expect(pillElement).toBeDefined();
        const pillProps = pillElement!.props as {
            count?: number;
            label?: unknown;
        };
        // Blocker 2: count must be passed (so the pill prints it via tabular nums), and the
        // label must be a SHORT singular/plural suffix only — never the same localized string
        // that already embeds the count (otherwise the pill renders "3 3 changes").
        expect(pillProps.count).toBe(3);
        // The test text mock returns `{ key, params }` for keyed lookups; assert the suffix key
        // is used (NOT the legacy `changes` key that already embeds the count) and that `count`
        // is forwarded to the translator so it can pluralize.
        const labelObject = pillProps.label as { key?: string; params?: Record<string, unknown> };
        expect(labelObject.key).toBe('newSession.worktree.statusPill.changesSuffix');
        expect(labelObject.params).toMatchObject({ count: 3 });
    });

    // ---- Per-row icon contracts ----

    function getIconProps(option: { icon?: React.ReactNode }): { name?: string; color?: string; size?: number } | null {
        const icon = option.icon;
        if (icon === undefined || icon === null) return null;
        if (!React.isValidElement(icon)) return null;
        return icon.props as { name?: string; color?: string; size?: number };
    }

    it('RUX-6: assigns a folder icon to the "use current directory" quick action', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const quickActions = requireStaticSection(rootStep, 'worktree:quick-actions');
        const currentDirOption = requireOption(quickActions, 'current_path');
        const iconProps = getIconProps(currentDirOption);
        expect(iconProps).not.toBeNull();
        expect(iconProps!.name).toBe('folder-outline');
        expect(iconProps!.color).toBe(TEST_ROW_ICON_COLOR);
    });

    it('RUX-6: assigns an add icon to the "create new worktree from..." quick action', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const quickActions = requireStaticSection(rootStep, 'worktree:quick-actions');
        const createOption = requireOption(quickActions, 'create_git_worktree');
        const iconProps = getIconProps(createOption);
        expect(iconProps).not.toBeNull();
        expect(iconProps!.name).toBe('add-circle-outline');
        expect(iconProps!.color).toBe(TEST_ROW_ICON_COLOR);
    });

    it('RUX-6: assigns a git-network icon to each existing worktree row', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/release', branch: 'release', isCurrent: false },
                    { path: '/repo/.worktrees/feature', branch: 'feature', isCurrent: false },
                ],
            }),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const existing = requireStaticSection(rootStep, 'worktree:existing');
        for (const option of existing.options) {
            const iconProps = getIconProps(option);
            expect(iconProps).not.toBeNull();
            expect(iconProps!.name).toBe('git-network-outline');
            expect(iconProps!.color).toBe(TEST_ROW_ICON_COLOR);
        }
    });

    it('RUX-6: assigns a git-branch icon to each branch row in the create-worktree drilldown', async () => {
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const option = buildWorktreeBranchOption({
            branch: { name: 'feature/new', type: 'local', upstream: null },
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const iconProps = getIconProps(option);
        expect(iconProps).not.toBeNull();
        expect(iconProps!.name).toBe('git-branch-outline');
        expect(iconProps!.color).toBe(TEST_ROW_ICON_COLOR);
    });

    it('RUX-6: also assigns git-branch icon to remote branch rows', async () => {
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const option = buildWorktreeBranchOption({
            branch: { name: 'origin/main', type: 'remote', upstream: null },
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const iconProps = getIconProps(option);
        expect(iconProps).not.toBeNull();
        expect(iconProps!.name).toBe('git-branch-outline');
        expect(iconProps!.color).toBe(TEST_ROW_ICON_COLOR);
    });

    // ---- F5: remote branch rows reuse existing local worktree on canonical branch name ----

    it('F5: remote row "origin/feature" routes to reuse when a local worktree exists on "feature"', async () => {
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();

        const option = buildWorktreeBranchOption({
            branch: { name: 'origin/feature', type: 'remote', upstream: null },
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature', branch: 'feature', isCurrent: false },
                ],
                remotes: [
                    { name: 'origin', fetchUrl: 'git@example.com:repo.git' },
                ],
            }),
            currentDirPath: '/repo',
            remoteNames: ['origin'],
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        option.onSelect?.();
        expect(onReuseExistingWorktreeForBranch).toHaveBeenCalledWith({
            worktreePath: '/repo/.worktrees/feature',
            branch: 'feature',
        });
        expect(onSelectBranchForNewWorktree).not.toHaveBeenCalled();
    });

    it('F5: remote row from a non-origin remote ("upstream/feature") routes to reuse against local "feature"', async () => {
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();

        const option = buildWorktreeBranchOption({
            branch: { name: 'upstream/feature', type: 'remote', upstream: null },
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature', branch: 'feature', isCurrent: false },
                ],
                remotes: [
                    { name: 'origin', fetchUrl: 'git@example.com:repo.git' },
                    { name: 'upstream', fetchUrl: 'git@example.com:upstream.git' },
                ],
            }),
            currentDirPath: '/repo',
            remoteNames: ['origin', 'upstream'],
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        option.onSelect?.();
        expect(onReuseExistingWorktreeForBranch).toHaveBeenCalledWith({
            worktreePath: '/repo/.worktrees/feature',
            branch: 'feature',
        });
        expect(onSelectBranchForNewWorktree).not.toHaveBeenCalled();
    });

    it('F5: remote row "origin/feature/login" (slashed branch) routes to reuse against local "feature/login"', async () => {
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();

        const option = buildWorktreeBranchOption({
            branch: { name: 'origin/feature/login', type: 'remote', upstream: null },
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature-login', branch: 'feature/login', isCurrent: false },
                ],
                remotes: [
                    { name: 'origin', fetchUrl: 'git@example.com:repo.git' },
                ],
            }),
            currentDirPath: '/repo',
            remoteNames: ['origin'],
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        option.onSelect?.();
        expect(onReuseExistingWorktreeForBranch).toHaveBeenCalledWith({
            worktreePath: '/repo/.worktrees/feature-login',
            branch: 'feature/login',
        });
        expect(onSelectBranchForNewWorktree).not.toHaveBeenCalled();
    });

    it('F5: remote row "origin/bar" with no matching local worktree routes to create (no false-positive reuse)', async () => {
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();

        const option = buildWorktreeBranchOption({
            branch: { name: 'origin/bar', type: 'remote', upstream: null },
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature', branch: 'feature', isCurrent: false },
                ],
                remotes: [
                    { name: 'origin', fetchUrl: 'git@example.com:repo.git' },
                ],
            }),
            currentDirPath: '/repo',
            remoteNames: ['origin'],
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        option.onSelect?.();
        expect(onReuseExistingWorktreeForBranch).not.toHaveBeenCalled();
        expect(onSelectBranchForNewWorktree).toHaveBeenCalledWith({
            branchName: 'origin/bar',
            sourceKind: 'remote',
        });
    });

    // ---- RV-10 / F4: worktree branch dynamic sections must declare virtualization: 'auto' ----

    it("RV-10/F4: local + remote branch dynamic sections both declare virtualization: 'auto'", async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const quickActions = rootStep.sections.find((s) => s.id === 'worktree:quick-actions');
        if (quickActions?.kind !== 'static') throw new Error('quick-actions must be static');
        const createOption = quickActions.options.find((o) => o.id === 'create_git_worktree');
        const createStep = createOption?.openStep;
        expect(createStep).toBeDefined();
        const sections = createStep!.sections;
        const localSection = sections.find((s) => s.id === 'worktree:branches:local');
        const remoteSection = sections.find((s) => s.id === 'worktree:branches:remote');
        expect(localSection).toBeDefined();
        expect(remoteSection).toBeDefined();
        // Plan §1.12 + §0.5 require both sections to opt into 'auto' virtualization since
        // branch lists routinely exceed the 50-row threshold (large repos can have 100s of branches).
        expect((localSection as { virtualization?: string }).virtualization).toBe('auto');
        expect((remoteSection as { virtualization?: string }).virtualization).toBe('auto');
    });

    it('keeps first-load branch sections visible with skeletons so the drilldown body does not collapse', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });

        const createStep = requireCreateWorktreeStep(rootStep);
        const localSection = requireDynamicSection(createStep, 'worktree:branches:local');
        const remoteSection = requireDynamicSection(createStep, 'worktree:branches:remote');

        expect(localSection.showSkeletonsOnFirstLoad).toBe(true);
        expect(remoteSection.showSkeletonsOnFirstLoad).toBe(true);
    });

    // ---- RV-10 / F5: origin fallback when snapshot has no remotes listed ----

    it("RV-10/F5: defaults to 'origin' when snapshot has empty remotes", async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();
        const fetchBranchesForMachinePath = vi.fn(async () => [
            { name: 'origin/feature', type: 'remote', upstream: null },
        ]);
        const repoScmBranchServiceModule = await import('@/scm/repository/repoScmBranchService');
        (repoScmBranchServiceModule.repoScmBranchService.fetchBranchesForMachinePath as ReturnType<typeof vi.fn>)
            .mockImplementation(fetchBranchesForMachinePath);

        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature', branch: 'feature', isCurrent: false },
                ],
                // The defining condition: snapshot has NO remotes populated yet
                // (offline boot / partial fetch / fresh clone). Without the 'origin'
                // default, `origin/feature` cannot be canonicalized to `feature`,
                // and the row would route to create instead of reuse.
                remotes: [],
            }),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        const createStep = requireCreateWorktreeStep(rootStep);
        const remoteSection = requireDynamicSection(createStep, 'worktree:branches:remote');

        const ac = new AbortController();
        const result = await remoteSection.resolve('', ac.signal);
        expect(result.options.length).toBe(1);
        result.options[0]!.onSelect?.();
        expect(onReuseExistingWorktreeForBranch).toHaveBeenCalledWith({
            worktreePath: '/repo/.worktrees/feature',
            branch: 'feature',
        });
        expect(onSelectBranchForNewWorktree).not.toHaveBeenCalled();
    });

    it("RV-10/F5: defaults to 'origin' when snapshot.repo.remotes is undefined (schema permits omission)", async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();
        const fetchBranchesForMachinePath = vi.fn(async () => [
            { name: 'origin/feature', type: 'remote', upstream: null },
        ]);
        const repoScmBranchServiceModule = await import('@/scm/repository/repoScmBranchService');
        (repoScmBranchServiceModule.repoScmBranchService.fetchBranchesForMachinePath as ReturnType<typeof vi.fn>)
            .mockImplementation(fetchBranchesForMachinePath);

        // Build a snapshot without the optional `remotes` key.
        const snapshot: ScmWorkingSnapshot = {
            projectKey: 'test-project',
            fetchedAt: 1_700_000_000_000,
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature', branch: 'feature', isCurrent: false },
                ],
                // remotes intentionally omitted
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

        const rootStep = buildWorktreeSelectionListSteps({
            snapshot,
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        const createStep = requireCreateWorktreeStep(rootStep);
        const remoteSection = requireDynamicSection(createStep, 'worktree:branches:remote');

        const ac = new AbortController();
        const result = await remoteSection.resolve('', ac.signal);
        expect(result.options.length).toBe(1);
        result.options[0]!.onSelect?.();
        expect(onReuseExistingWorktreeForBranch).toHaveBeenCalledWith({
            worktreePath: '/repo/.worktrees/feature',
            branch: 'feature',
        });
        expect(onSelectBranchForNewWorktree).not.toHaveBeenCalled();
    });

    it('F5: a remote row whose canonical name matches the current dir worktree does NOT route to reuse (avoid self-row)', async () => {
        const { buildWorktreeBranchOption } = await import('./buildWorktreeSelectionListSteps');
        const onSelectBranchForNewWorktree = vi.fn();
        const onReuseExistingWorktreeForBranch = vi.fn();

        const option = buildWorktreeBranchOption({
            branch: { name: 'origin/feature', type: 'remote', upstream: null },
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { path: '/repo/.worktrees/feature', branch: 'feature', isCurrent: false },
                ],
                remotes: [
                    { name: 'origin', fetchUrl: 'git@example.com:repo.git' },
                ],
            }),
            // currentDirPath IS the local feature worktree → reuse must NOT fire.
            currentDirPath: '/repo/.worktrees/feature',
            remoteNames: ['origin'],
            rowIconColor: TEST_ROW_ICON_COLOR,
            onSelectBranchForNewWorktree,
            onReuseExistingWorktreeForBranch,
        });

        option.onSelect?.();
        expect(onReuseExistingWorktreeForBranch).not.toHaveBeenCalled();
        expect(onSelectBranchForNewWorktree).toHaveBeenCalledWith({
            branchName: 'origin/feature',
            sourceKind: 'remote',
        });
    });

    // ---- FR3-6: branch dynamic sections must declare resolverKey scoped to (machineId + canonical machinePath) ----

    it('FR3-6: local + remote branch dynamic sections expose a resolverKey scoped to machineId + canonical machinePath', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');

        const stepForMachineA = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-a',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const createStepA = requireCreateWorktreeStep(stepForMachineA);
        const localA = requireDynamicSection(createStepA, 'worktree:branches:local');
        const remoteA = requireDynamicSection(createStepA, 'worktree:branches:remote');
        expect(typeof localA.resolverKey).toBe('string');
        expect(typeof remoteA.resolverKey).toBe('string');
        expect((localA.resolverKey ?? '').length).toBeGreaterThan(0);
        // Both sections should be scoped to the same (machine, repo) identity.
        expect(localA.resolverKey).toBe(remoteA.resolverKey);
        // The key must include the machine id so a machine swap invalidates the cache.
        expect(localA.resolverKey).toContain('machine-a');

        // Switching machine id MUST yield a different resolverKey so the
        // cross-mount cache in useSelectionListDynamicSections.ts is
        // partitioned per machine.
        const stepForMachineB = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-b',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const createStepB = requireCreateWorktreeStep(stepForMachineB);
        const localB = requireDynamicSection(createStepB, 'worktree:branches:local');
        expect(localB.resolverKey).not.toBe(localA.resolverKey);
        expect(localB.resolverKey).toContain('machine-b');
    });

    it('FR3-6: resolverKey changes when machinePath changes (different repo on same machine)', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');

        const stepForRepoA = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo-a',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo-a',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const stepForRepoB = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo-b',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo-b',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const getLocalResolverKey = (rootStep: SelectionListStep): string | undefined => {
            const createStep = requireCreateWorktreeStep(rootStep);
            return requireDynamicSection(createStep, 'worktree:branches:local').resolverKey;
        };
        const keyA = getLocalResolverKey(stepForRepoA);
        const keyB = getLocalResolverKey(stepForRepoB);
        expect(keyA).toBeDefined();
        expect(keyB).toBeDefined();
        expect(keyA).not.toBe(keyB);
    });

    it('FR3-6: resolverKey is canonicalized — trailing-slash + separator variants of machinePath produce the same key', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');

        const getLocalResolverKey = (machinePath: string): string | undefined => {
            const rootStep = buildWorktreeSelectionListSteps({
                snapshot: makeSnapshot(),
                currentDirPath: '/repo',
                rowIconColor: TEST_ROW_ICON_COLOR,
                machineId: 'machine-1',
                machinePath,
                nowMs: 1_700_000_000_000,
                onSelectCurrentDir: vi.fn(),
                onSelectExistingWorktree: vi.fn(),
                onSelectBranchForNewWorktree: vi.fn(),
                onReuseExistingWorktreeForBranch: vi.fn(),
            });
            const createStep = requireCreateWorktreeStep(rootStep);
            return requireDynamicSection(createStep, 'worktree:branches:local').resolverKey;
        };
        // Same logical repo under different surface representations — canonical
        // form must collapse them to a single cache key.
        const baseline = getLocalResolverKey('/repo/foo');
        const trailingSlash = getLocalResolverKey('/repo/foo/');
        expect(baseline).toBeDefined();
        expect(trailingSlash).toBe(baseline);
    });

    // ---- FR4-5: status pill must be hidden when changeCount is unknown (porcelain failed) ----

    it('FR4-5: omits the status pill entirely when changeCount is undefined, even if lastActivityAt is known', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    {
                        path: '/repo/.worktrees/feature',
                        branch: 'feature',
                        isCurrent: false,
                        // porcelain failed → changeCount undefined
                        changeCount: undefined,
                        // git log succeeded → lastActivityAt known
                        lastActivityAt: 1_700_000_000_000,
                    },
                ],
            }),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });

        const existing = rootStep.sections.find((s) => s.id === 'worktree:existing');
        if (existing?.kind !== 'static') throw new Error('existing must be static');
        const row = existing.options.find((o) => o.id === 'checkout:/repo/.worktrees/feature');
        const accessory = row?.rightAccessory as React.ReactElement;
        const fragmentChildren = React.Children.toArray((accessory.props as { children: React.ReactNode }).children);

        // The age accessory (RelativeTimeText) MAY still render because age is independent of porcelain.
        // But the status pill MUST NOT render — clean/stale is meaningless if changeCount is unknown.
        const statusPill = fragmentChildren.find(
            (child): child is React.ReactElement<Record<string, unknown>> =>
                React.isValidElement(child)
                && (child.props as { testID?: string }).testID === 'worktree-row-status:/repo/.worktrees/feature',
        );
        expect(statusPill).toBeUndefined();
    });

    it('FR4-5: status pill is hidden when BOTH changeCount and lastActivityAt are unknown (existing back-compat)', async () => {
        const { resolveWorktreeStatusVariant } = await import('./worktreeExistingOptions');
        expect(resolveWorktreeStatusVariant({ changeCount: undefined, lastActivityAt: undefined, nowMs: 0 })).toBeNull();
    });

    it('FR4-5: status pill is still rendered when changeCount is known but lastActivityAt is undefined', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    {
                        path: '/repo/.worktrees/feature',
                        branch: 'feature',
                        isCurrent: false,
                        changeCount: 0,
                        lastActivityAt: undefined,
                    },
                ],
            }),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });

        const existing = rootStep.sections.find((s) => s.id === 'worktree:existing');
        if (existing?.kind !== 'static') throw new Error('existing must be static');
        const row = existing.options.find((o) => o.id === 'checkout:/repo/.worktrees/feature');
        const accessory = row?.rightAccessory as React.ReactElement;
        const fragmentChildren = React.Children.toArray((accessory.props as { children: React.ReactNode }).children);
        const statusPill = fragmentChildren.find(
            (child): child is React.ReactElement<Record<string, unknown>> =>
                React.isValidElement(child)
                && (child.props as { testID?: string }).testID === 'worktree-row-status:/repo/.worktrees/feature',
        );
        // changeCount IS known (0 = clean) so the pill should render.
        expect(statusPill).toBeDefined();
    });

    // ---- FR4-8: branch dynamic sections must have `seedFromInput: () => ''` so resolver is stable ----

    it('FR4-8: local + remote branch dynamic sections expose seedFromInput returning a stable empty seed', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });

        const createStep = requireCreateWorktreeStep(rootStep);
        const localSection = requireDynamicSection(createStep, 'worktree:branches:local');
        const remoteSection = requireDynamicSection(createStep, 'worktree:branches:remote');
        expect(localSection.seedFromInput).toBeTypeOf('function');
        expect(remoteSection.seedFromInput).toBeTypeOf('function');
        // Stable: every keystroke value must collapse to the same seed so the resolver fires once.
        expect(localSection.seedFromInput!('')).toBe(localSection.seedFromInput!('main'));
        expect(localSection.seedFromInput!('foo')).toBe(localSection.seedFromInput!('bar'));
        expect(remoteSection.seedFromInput!('foo')).toBe(remoteSection.seedFromInput!(''));
    });

    // ---- FR4-10: status pill must render `{count} {suffix}` (suffix has no embedded number) ----

    it('FR4-10: dirty pill passes a suffix label whose translator params do not include the count in the string', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot({
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    {
                        path: '/repo/.worktrees/feature',
                        branch: 'feature',
                        isCurrent: false,
                        changeCount: 7,
                        lastActivityAt: 1_700_000_000_000,
                    },
                ],
            }),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: 'machine-1',
            machinePath: '/repo',
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });

        const existing = rootStep.sections.find((s) => s.id === 'worktree:existing');
        if (existing?.kind !== 'static') throw new Error('existing must be static');
        const row = existing.options.find((o) => o.id === 'checkout:/repo/.worktrees/feature');
        const accessory = row!.rightAccessory as React.ReactElement;
        const fragmentChildren = React.Children.toArray((accessory.props as { children: React.ReactNode }).children);
        const pillElement = fragmentChildren.find(
            (child): child is React.ReactElement<Record<string, unknown>> =>
                React.isValidElement(child)
                && (child.props as { testID?: string }).testID === 'worktree-row-status:/repo/.worktrees/feature',
        );
        expect(pillElement).toBeDefined();
        const pillProps = pillElement!.props as { count?: number; label?: unknown };
        expect(pillProps.count).toBe(7);

        // Resolve the actual English translation via the real `t()` to assert the suffix
        // does not embed the count. The translator mock returns `{ key, params }` only;
        // we re-evaluate the key against the canonical English entry directly.
        const { en } = await import('@/text/translations/en');
        const enFn = (en.newSession as { worktree: { statusPill: { changesSuffix: (p: { count: number }) => string } } })
            .worktree.statusPill.changesSuffix;
        const singular = enFn({ count: 1 });
        const plural = enFn({ count: 7 });
        // The suffix MUST NOT include the number itself (StatusPill renders count separately).
        expect(singular).not.toMatch(/\d/);
        expect(plural).not.toMatch(/\d/);
        expect(singular).toBe('change');
        expect(plural).toBe('changes');
    });

    it('FR3-6: resolverKey falls back to a stable "no-machine" marker when machineId is null', async () => {
        const { buildWorktreeSelectionListSteps } = await import('./buildWorktreeSelectionListSteps');
        const rootStep = buildWorktreeSelectionListSteps({
            snapshot: makeSnapshot(),
            currentDirPath: '/repo',
            rowIconColor: TEST_ROW_ICON_COLOR,
            machineId: null,
            machinePath: null,
            nowMs: 1_700_000_000_000,
            onSelectCurrentDir: vi.fn(),
            onSelectExistingWorktree: vi.fn(),
            onSelectBranchForNewWorktree: vi.fn(),
            onReuseExistingWorktreeForBranch: vi.fn(),
        });
        const createStep = requireCreateWorktreeStep(rootStep);
        const local = requireDynamicSection(createStep, 'worktree:branches:local');
        expect(local.resolverKey).toBe('no-machine');
    });
});
