import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const base = {
    branches: [
        { name: 'v0.3', type: 'local' as const, upstream: 'origin/v0.3', isCurrent: true },
        { name: 'dev', type: 'local' as const, upstream: 'origin/dev' },
        { name: 'leeroy/sheet', type: 'local' as const, upstream: null },
    ],
    canCheckout: true,
    canCreateWorktrees: false,
    canLaunchWorktreeSession: false,
    canReadBranches: true,
    currentBranch: 'v0.3',
    hasMachineTarget: true,
    includeRemotes: false,
    loading: false,
    worktreeRows: [],
    checkIconColor: '#000',
};

describe('buildWorkspaceScmBranchPopoverItems (Git lab BR)', () => {
    it('leads with where you are, then the other branches, then what was kept aside and what you can start', async () => {
        const { buildWorkspaceScmBranchPopoverItems } = await import('./buildWorkspaceScmBranchPopoverItems');
        const { branchItems } = buildWorkspaceScmBranchPopoverItems({
            ...base,
            current: { changedCount: 11, ahead: 3 },
            keptAside: [{ stashRef: 'stash@{0}', kind: 'branch', branch: 'v0.3', createdAt: 1 }],
            keepAside: { available: true, changedCount: 11 },
            newBranch: { available: true },
        });
        const categories = [...new Set(branchItems.map((item) => item.category))];
        expect(categories).toEqual([
            'sessionGitBranches.category.current',
            'sessionGitBranches.category.branches',
            'sessionGitBranches.category.keptAside',
            'sessionGitBranches.category.start',
        ]);
        const current = branchItems[0]!;
        expect(current).toMatchObject({ id: 'branch:v0.3', checked: true });
        expect(current.subtitle).toContain('origin/v0.3');
        expect(current.subtitle).toContain('11');
        expect(branchItems.find((item) => item.id === 'branch:leeroy/sheet')?.subtitle).toBe('sessionGitBranches.onlyHere');
        expect(branchItems.find((item) => item.id === 'stash:stash@{0}')).toBeTruthy();
        expect(branchItems.find((item) => item.id === 'git:keep-aside')?.disabled).toBe(false);
    });

    it('offers Keep changes aside only on a daemon that can create a stash, and says so when there is nothing to keep', async () => {
        const { buildWorkspaceScmBranchPopoverItems } = await import('./buildWorkspaceScmBranchPopoverItems');
        const unsupported = buildWorkspaceScmBranchPopoverItems({ ...base, keepAside: { available: false, changedCount: 4 } });
        expect(unsupported.branchItems.some((item) => item.id === 'git:keep-aside')).toBe(false);

        const clean = buildWorkspaceScmBranchPopoverItems({ ...base, keepAside: { available: true, changedCount: 0 } });
        expect(clean.branchItems.find((item) => item.id === 'git:keep-aside')).toMatchObject({
            disabled: true,
            subtitle: 'sessionGitBranches.keepAsideNothing',
        });
    });
    // The menu draws a checked row's check beside its designation; a row that drew its own showed two.
    it('leaves the check of the current branch and worktree to the menu, keeping the ahead mark', async () => {
        const React = await import('react');
        const { Icon } = await import('@/components/ui/icons/Icon');
        const { buildWorkspaceScmBranchPopoverItems } = await import('./buildWorkspaceScmBranchPopoverItems');
        const { branchItems, worktreeItems } = buildWorkspaceScmBranchPopoverItems({
            ...base,
            canLaunchWorktreeSession: true,
            current: { changedCount: 0, ahead: 2 },
            worktreeRows: [{ path: '/repo', branch: 'v0.3', isCurrent: true, isMain: true }],
        } as any);
        const glyphs = (node: unknown): string[] => {
            if (!React.isValidElement(node)) return [];
            const props = node.props as { name?: string; children?: unknown };
            return [
                ...(node.type === Icon && props.name ? [props.name] : []),
                ...React.Children.toArray(props.children as React.ReactNode).flatMap(glyphs),
            ];
        };
        const checked = [...branchItems, ...worktreeItems].filter((item) => item.checked === true);
        expect(checked.map((item) => item.id)).toEqual(['branch:v0.3', 'worktree:open:/repo']);
        expect(checked.map((item) => glyphs(item.right))).toEqual([['arrow-up'], []]);
    });
});
