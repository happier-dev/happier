import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionScmBranchCheckoutMock = vi.hoisted(() => vi.fn());
const sessionScmBranchCreateMock = vi.hoisted(() => vi.fn());
const sessionScmRemotePublishMock = vi.hoisted(() => vi.fn());
const useSettingMock = vi.hoisted(() => vi.fn());
const publishBranchMock = vi.hoisted(() => vi.fn(async () => true));
const usePublishBranchActionMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());
const fetchBranchesForSessionMock = vi.hoisted(() => vi.fn());
const readCachedBranchesForSessionMock = vi.hoisted(() => vi.fn());
const invalidateBranchesForSessionMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            surface: '#fff',
            surfaceHigh: '#f6f6f6',
            text: '#000',
            textSecondary: '#666',
            textLink: '#09f',
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme, {}) : input) },
    };
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/ops', () => ({
    sessionScmBranchCheckout: sessionScmBranchCheckoutMock,
    sessionScmRemotePublish: sessionScmRemotePublishMock,
    sessionScmBranchCreate: sessionScmBranchCreateMock,
}));

vi.mock('@/scm/repository/repoScmBranchService', () => ({
    repoScmBranchService: {
        fetchBranchesForSession: (input: unknown) => fetchBranchesForSessionMock(input),
        readCachedBranchesForSession: (input: unknown) => readCachedBranchesForSessionMock(input),
        invalidateBranchesForSession: (input: unknown) => invalidateBranchesForSessionMock(input),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => useSettingMock(key),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

vi.mock('@/hooks/session/sourceControl/usePublishBranchAction', () => ({
    usePublishBranchAction: (...args: any[]) => usePublishBranchActionMock(...args),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertMock,
        confirm: vi.fn(async () => false),
    },
}));

describe('SourceControlBranchMenu', () => {
    beforeEach(() => {
        publishBranchMock.mockClear();
        readMachineTargetForSessionMock.mockReset();
        readMachineTargetForSessionMock.mockReturnValue(null);
        routerPushMock.mockReset();
        fetchBranchesForSessionMock.mockReset();
        fetchBranchesForSessionMock.mockResolvedValue([]);
        readCachedBranchesForSessionMock.mockReset();
        readCachedBranchesForSessionMock.mockReturnValue([]);
        invalidateBranchesForSessionMock.mockReset();
        modalAlertMock.mockReset();
        usePublishBranchActionMock.mockImplementation(({ writeEnabled, disabled, snapshot }: any) => ({
            canPublish:
                writeEnabled !== false
                && disabled !== true
                && snapshot?.capabilities?.writeRemotePublish === true
                && snapshot?.branch?.upstream == null,
            publishBusy: false,
            publishBranch: publishBranchMock,
        }));
    });

    it('keeps the branch list visible while write operations are disabled', async () => {
        useSettingMock.mockImplementation(() => 'always_bring');
        fetchBranchesForSessionMock.mockResolvedValue([
            { name: 'existing-branch', type: 'local', isCurrent: true, upstream: null },
            { name: 'feature/test', type: 'local', isCurrent: false, upstream: null },
        ]);

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(SourceControlBranchMenu, {
                    sessionId: 's1',
                    currentBranch: 'existing-branch',
                    snapshot: {
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'existing-branch', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, writeBranchCreate: true, writeRemotePublish: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any,
                    disabled: false,
                    writeEnabled: false,
                } as any)
            );
        });

        let menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            menu.props.onOpenChange(true);
        });
        await act(async () => {
            await Promise.resolve();
        });
        menu = tree.root.findByType('DropdownMenu' as any);

        expect(menu.props.items.some((item: any) => item.id === 'publish')).toBe(false);
        expect(menu.props.items.find((item: any) => item.id === 'branch:feature/test')?.disabled).toBe(true);
        expect(fetchBranchesForSessionMock).toHaveBeenCalledWith({
            sessionId: 's1',
            includeRemotes: false,
        });
    });

    it('seeds the branch menu from the shared branch cache before refreshing', async () => {
        useSettingMock.mockImplementation(() => 'always_bring');
        readCachedBranchesForSessionMock.mockReturnValue([
            { name: 'cached-branch', type: 'local', isCurrent: false, upstream: null },
        ]);
        fetchBranchesForSessionMock.mockImplementation(() => new Promise(() => {}));

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, writeRemotePublish: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                    disabled={false}
                />
            );
        });

        let menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            menu.props.onOpenChange(true);
            await Promise.resolve();
        });
        menu = tree.root.findByType('DropdownMenu' as any);

        expect(menu.props.items.some((item: any) => item.id === 'branch:cached-branch')).toBe(true);
        expect(fetchBranchesForSessionMock).toHaveBeenCalledWith({
            sessionId: 's1',
            includeRemotes: false,
        });
    });

    it('keeps cached branches visible when refresh fails', async () => {
        useSettingMock.mockImplementation(() => 'always_bring');
        readCachedBranchesForSessionMock.mockReturnValue([
            { name: 'cached-branch', type: 'local', isCurrent: false, upstream: null },
        ]);
        fetchBranchesForSessionMock.mockRejectedValue(new Error('refresh failed'));

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, writeRemotePublish: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                    disabled={false}
                />
            );
        });

        let menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            menu.props.onOpenChange(true);
            await Promise.resolve();
        });
        await act(async () => {
            try {
                await fetchBranchesForSessionMock.mock.results[0]?.value;
            } catch {}
        });
        menu = tree.root.findByType('DropdownMenu' as any);

        expect(menu.props.items.some((item: any) => item.id === 'branch:cached-branch')).toBe(true);
        expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'refresh failed');
    });

    it('allows the branch menu popover to grow wider than the branch trigger', async () => {
        useSettingMock.mockImplementation(() => 'always_bring');
        fetchBranchesForSessionMock.mockResolvedValue([]);
        sessionScmBranchCreateMock.mockResolvedValue({ success: true });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="existing-branch"
                    snapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'existing-branch', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, writeRemotePublish: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                    disabled={false}
                />
            );
        });

        const menu = tree.root.findByType('DropdownMenu' as any);

        expect(menu.props.matchTriggerWidth).toBe(false);
    });

    it('switches branches using bring_changes when setting is always_bring', async () => {
        useSettingMock.mockImplementation((key: string) => {
            if (key === 'scmUncommittedChangesStrategy') return 'always_bring';
            if (key === 'scmAskBeforeOverwritingBranchStash') return true;
            return undefined;
        });
        fetchBranchesForSessionMock.mockResolvedValue([]);
        sessionScmBranchCreateMock.mockResolvedValue({ success: true });
        sessionScmBranchCheckoutMock.mockResolvedValue({ success: true });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, writeRemotePublish: true },
                        totals: { includedFiles: 1, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                    disabled={false}
                />
            );
        });

        const menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('branch:feature/test');
        });

        expect(sessionScmBranchCheckoutMock).toHaveBeenCalledWith('s1', {
            name: 'feature/test',
            strategy: 'bring_changes',
        });
    });

    it('publishes branch when selecting publish', async () => {
        useSettingMock.mockImplementation(() => 'always_bring');
        fetchBranchesForSessionMock.mockResolvedValue([]);
        sessionScmBranchCreateMock.mockResolvedValue({ success: true });
        sessionScmRemotePublishMock.mockResolvedValue({ success: true });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="main"
                    snapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, writeRemotePublish: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                    disabled={false}
                />
            );
        });

        const menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            await menu.props.onSelect('publish');
        });

        expect(publishBranchMock).toHaveBeenCalledTimes(1);
    });
});
