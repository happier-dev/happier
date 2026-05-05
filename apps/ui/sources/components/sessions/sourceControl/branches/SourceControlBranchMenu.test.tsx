import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    installSourceControlBranchMenuCommonModuleMocks,
    listSourceControlBranchMenuItemIds,
    openSourceControlBranchMenu,
    resetSourceControlBranchMenuCommonModuleMockState,
    selectSourceControlBranchMenuItem,
    sourceControlBranchMenuModuleState,
} from './sourceControlBranchMenuTestHelpers';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSourceControlBranchMenuCommonModuleMocks();

describe('SourceControlBranchMenu', () => {
    beforeEach(() => {
        resetSourceControlBranchMenuCommonModuleMockState();
    });

    it('keeps the branch list visible while write operations are disabled', async () => {
        sourceControlBranchMenuModuleState.useSettingMock.mockImplementation(() => 'always_bring');
        sourceControlBranchMenuModuleState.fetchBranchesForSessionMock.mockResolvedValue([
            { name: 'existing-branch', type: 'local', isCurrent: true, upstream: null },
            { name: 'feature/test', type: 'local', isCurrent: false, upstream: null },
        ]);

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
                    sessionId="s1"
                    currentBranch="existing-branch"
                    snapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'existing-branch', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeBranchCheckout: true, writeBranchCreate: true, writeRemotePublish: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                    disabled={false}
                    writeEnabled={false}
                />);

        await openSourceControlBranchMenu(screen);
        const itemIds = listSourceControlBranchMenuItemIds(screen);
        const results = screen.findByType('SelectableMenuResults' as any);
        const branchItem = results.props.categories
            .flatMap((category: any) => category.items)
            .find((item: any) => item.id === 'branch:feature/test');

        expect(itemIds.includes('publish')).toBe(false);
        expect(branchItem?.disabled).toBe(true);
        expect(sourceControlBranchMenuModuleState.fetchBranchesForSessionMock).toHaveBeenCalledWith({
            sessionId: 's1',
            includeRemotes: false,
        });
    });

    it('seeds the branch menu from the shared branch cache before refreshing', async () => {
        sourceControlBranchMenuModuleState.useSettingMock.mockImplementation(() => 'always_bring');
        sourceControlBranchMenuModuleState.readCachedBranchesForSessionMock.mockReturnValue([
            { name: 'cached-branch', type: 'local', isCurrent: false, upstream: null },
        ]);
        sourceControlBranchMenuModuleState.fetchBranchesForSessionMock.mockImplementation(() => new Promise(() => {}));

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);
        expect(listSourceControlBranchMenuItemIds(screen)).toContain('branch:cached-branch');
        expect(sourceControlBranchMenuModuleState.fetchBranchesForSessionMock).toHaveBeenCalledWith({
            sessionId: 's1',
            includeRemotes: false,
        });
    });

    it('keeps cached branches visible when refresh fails', async () => {
        sourceControlBranchMenuModuleState.useSettingMock.mockImplementation(() => 'always_bring');
        sourceControlBranchMenuModuleState.readCachedBranchesForSessionMock.mockReturnValue([
            { name: 'cached-branch', type: 'local', isCurrent: false, upstream: null },
        ]);
        sourceControlBranchMenuModuleState.fetchBranchesForSessionMock.mockRejectedValue(new Error('refresh failed'));

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);
        await act(async () => {
            try {
                await sourceControlBranchMenuModuleState.fetchBranchesForSessionMock.mock.results[0]?.value;
            } catch {}
        });
        expect(listSourceControlBranchMenuItemIds(screen)).toContain('branch:cached-branch');
        expect(sourceControlBranchMenuModuleState.modalAlertSpy).toHaveBeenCalledWith('common.error', 'refresh failed');
    });

    it('allows the branch menu popover to grow wider than the branch trigger', async () => {
        sourceControlBranchMenuModuleState.useSettingMock.mockImplementation(() => 'always_bring');
        sourceControlBranchMenuModuleState.fetchBranchesForSessionMock.mockResolvedValue([]);
        sourceControlBranchMenuModuleState.sessionScmBranchCreateMock.mockResolvedValue({ success: true });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        expect(screen.findByType('Popover' as any).props.maxWidthCap).toBe(420);
    });

    it('switches branches using bring_changes when setting is always_bring', async () => {
        sourceControlBranchMenuModuleState.useSettingMock.mockImplementation((key: string) => {
            if (key === 'scmUncommittedChangesStrategy') return 'always_bring';
            if (key === 'scmAskBeforeOverwritingBranchStash') return true;
            return undefined;
        });
        sourceControlBranchMenuModuleState.fetchBranchesForSessionMock.mockResolvedValue([
            { name: 'main', type: 'local', isCurrent: true, upstream: null },
            { name: 'feature/test', type: 'local', isCurrent: false, upstream: null },
        ]);
        sourceControlBranchMenuModuleState.sessionScmBranchCreateMock.mockResolvedValue({ success: true });
        sourceControlBranchMenuModuleState.sessionScmBranchCheckoutMock.mockResolvedValue({ success: true });

        const { SourceControlBranchMenu } = await import('./SourceControlBranchMenu');

        const screen = await renderScreen(<SourceControlBranchMenu
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
                />);

        await openSourceControlBranchMenu(screen);
        await selectSourceControlBranchMenuItem(screen, 'branch:feature/test');

        expect(sourceControlBranchMenuModuleState.sessionScmBranchCheckoutMock).toHaveBeenCalledWith('s1', {
            name: 'feature/test',
            strategy: 'bring_changes',
        });
    });

});
