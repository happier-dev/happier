import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { repoScmBranchService } from '@/scm/repository/repoScmBranchService';
import { resolveSessionPathWithinWorktree } from '@/scm/repository/resolveSessionPathWithinWorktree';
import { useRepoScmBranchList } from '@/scm/repository/useRepoScmBranchList';
import { repoScmWorktreeService } from '@/scm/repository/repoScmWorktreeService';
import { runSessionScmMutation } from '@/scm/operations/runSessionScmMutation';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { sessionScmBranchCheckout, sessionScmBranchCreate, sessionScmStashCreate } from '@/sync/ops';
import { storage, useSetting } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { showSwitchBranchWithChangesDialog } from '@/components/workspaces/scm/branches/SwitchBranchWithChangesDialog';
import { t } from '@/text';
import {
    buildWorkspaceScmBranchPopoverItems,
    GIT_BRANCH_MENU_ITEM_IDS,
} from '@/components/workspaces/scm/branches/buildWorkspaceScmBranchPopoverItems';
import { filterVisibleRepoWorktreeRows } from '@/components/workspaces/scm/worktrees/filterVisibleRepoWorktreeRows';
import { WorkspaceScmBranchPopover } from '@/components/workspaces/scm/branches/WorkspaceScmBranchPopover';
import {
    hasUncommittedChanges,
    isBranchStashAlreadyExistsError,
    normalizeBranchSwitchSetting,
} from '@/components/workspaces/scm/branches/branchMenuPredicates';
import { handleSourceControlBranchMenuSelect } from '@/components/sessions/sourceControl/branches/handleSourceControlBranchMenuSelect';
import { useSessionScmStashes } from './useSessionScmStashes';

export type GitBranchButtonProps = Readonly<{
    sessionId: string;
    serverId?: string;
    snapshot: ScmWorkingSnapshot | null;
    /** Another write is running, or the session cannot act right now: the list stays readable, nothing starts. */
    disabled?: boolean;
    /** Opens the kept-aside changes in Details (the pane's existing stash destination). */
    onOpenStashDetails?: () => void;
    /** `line`: the pane header's live-line door (default); `title`: a standalone branch title. */
    appearance?: 'line' | 'title';
    testID?: string;
}>;

/**
 * The session Git pane's branch door (Git lab BR): the branch name in the pane header opens one list — where
 * you are, the other branches, what Happier kept aside, worktrees, and what you can start (a branch, a
 * worktree, keeping the changes aside). Every write runs through the project SCM operation owner, so its
 * progress and outcome show in the pane's outcome line; failures never raise a dialog here. The asks that
 * decide what happens to uncommitted changes (switch with changes, overwrite a kept stash) stay before the
 * write, as the shipped dialogs.
 */
export function GitBranchButton(props: GitBranchButtonProps): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();
    const disabled = props.disabled === true;
    const snapshot = props.snapshot;
    const currentBranch = snapshot?.branch.detached ? null : (snapshot?.branch.head ?? null);
    const machineTarget = useSessionMachineTarget(props.sessionId, props.serverId);
    const legacyServerId = usePreferredServerIdForSession(
        { sessionId: props.sessionId },
        props.serverId === undefined,
    );
    const targetServerId = props.serverId ?? legacyServerId;
    const repoPath = machineTarget?.basePath ?? snapshot?.repo.rootPath ?? null;

    const branchSwitchSetting = normalizeBranchSwitchSetting(useSetting('scmUncommittedChangesStrategy'));
    const askBeforeOverwrite = useSetting('scmAskBeforeOverwritingBranchStash') !== false;

    const capabilities = snapshot?.capabilities;
    const canReadBranches = capabilities?.readBranches === true;
    const canCheckout = capabilities?.writeBranchCheckout === true && !disabled;
    const canCreate = capabilities?.writeBranchCreate === true && !disabled;
    const canCreateWorktrees = capabilities?.worktreeCreate === true && !disabled;
    const canLaunchWorktreeSession = snapshot?.repo.isRepo === true;
    const canReadStashes = capabilities?.readStash === true;
    const canCreateStash = capabilities?.writeStashCreate === true;
    const [open, setOpen] = React.useState(false);
    const [includeRemotes, setIncludeRemotes] = React.useState(false);
    const [focusSearchRequest, setFocusSearchRequest] = React.useState(0);
    const [loadError, setLoadError] = React.useState<string | null>(null);

    const changedCount = React.useMemo(
        () => (snapshot?.repo.isRepo ? selectScmChangedFiles(snapshot).length : 0),
        [snapshot],
    );
    // Kept-aside rows are read only while the list is open (a closed door issues no RPC).
    const stashes = useSessionScmStashes({
        sessionId: props.sessionId,
        serverId: props.serverId,
        enabled: open && canReadStashes,
        refreshKey: `${currentBranch ?? ''}\u0000${snapshot?.stashCount ?? 0}`,
    });

    const worktreeRows = React.useMemo(() => {
        const worktrees = snapshot?.repo.worktrees ?? [];
        return [...filterVisibleRepoWorktreeRows(worktrees)].sort((left, right) => {
            if (left.isCurrent === true && right.isCurrent !== true) return -1;
            if (left.isCurrent !== true && right.isCurrent === true) return 1;
            return (left.branch ?? left.path).localeCompare(right.branch ?? right.path);
        });
    }, [snapshot?.repo.worktrees]);

    const openNewSessionForDirectory = React.useCallback((directory: string) => {
        const draftId = resolveNewSessionDraftRouteIdentity({ routeDraftId: undefined }).draftId;
        router.push({
            pathname: '/new',
            params: buildNewSessionLaunchRouteParams({
                draftId,
                directory,
                machineId: machineTarget?.machineId ?? null,
                targetServerId,
            }),
        });
    }, [machineTarget?.machineId, router, targetServerId]);

    const readCachedBranches = React.useCallback(() => {
        return repoScmBranchService.readCachedBranchesForSession({
            sessionId: props.sessionId, serverId: props.serverId,
            includeRemotes,
        });
    }, [includeRemotes, props.sessionId, props.serverId]);

    const fetchBranches = React.useCallback(async () => {
        const branches = await repoScmBranchService.fetchBranchesForSession({
            sessionId: props.sessionId, serverId: props.serverId,
            includeRemotes,
        });
        setLoadError(null);
        return branches;
    }, [includeRemotes, props.sessionId, props.serverId]);

    // A failed refresh keeps the cached branches and says so in the list, not in a dialog.
    const handleBranchLoadError = React.useCallback((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : t('files.branchMenu.failedToLoad'));
    }, []);

    const { branches, phase, refresh } = useRepoScmBranchList({
        ready: canReadBranches,
        autoLoad: open && canReadBranches,
        readCached: readCachedBranches,
        fetch: fetchBranches,
        onError: handleBranchLoadError,
    });
    const loading = phase !== 'idle';

    const { branchItems, worktreeItems } = React.useMemo(() => buildWorkspaceScmBranchPopoverItems({
        branches,
        canCheckout,
        canCreateWorktrees,
        canLaunchWorktreeSession,
        canReadBranches,
        currentBranch,
        includeRemotes,
        loading,
        hasMachineTarget: Boolean(machineTarget),
        worktreeRows,
        checkIconColor: theme.colors.text.secondary,
        current: { changedCount, ahead: snapshot?.branch.ahead ?? 0 },
        keptAside: stashes,
        keepAside: { available: canCreateStash && !disabled, changedCount },
        newBranch: { available: canCreate },
        loadError,
    }), [
        branches, canCheckout, canCreate, canCreateStash, canCreateWorktrees, canLaunchWorktreeSession, canReadBranches,
        changedCount, currentBranch, disabled, includeRemotes, loadError, loading, machineTarget, snapshot?.branch.ahead,
        stashes, theme.colors.text.secondary, worktreeRows,
    ]);

    const closeMenu = React.useCallback(() => setOpen(false), []);
    const afterBranchWrite = React.useCallback(async () => {
        repoScmBranchService.invalidateBranchesForSession({ sessionId: props.sessionId, serverId: props.serverId });
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId, props.serverId);
    }, [props.sessionId, props.serverId]);

    const createBranch = React.useCallback(async (name: string) => {
        if (!canCreate) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        closeMenu();
        await runSessionScmMutation({
            state: storage.getState(),
            sessionId: props.sessionId,
            ...(props.serverId === undefined ? {} : { serverId: props.serverId }),
            operation: 'branch_create',
            cwd: repoPath,
            fallbackError: t('files.branchMenu.create.failed'),
            run: () => sessionScmBranchCreate(props.sessionId, { name: trimmed, checkout: true }, props.serverId),
            successDetail: () => trimmed,
            refreshAfterMutation: afterBranchWrite,
        });
    }, [afterBranchWrite, canCreate, closeMenu, props.sessionId, props.serverId, repoPath]);

    const switchBranch = React.useCallback(async (targetBranch: string) => {
        if (!canCheckout) return;
        const target = targetBranch.trim();
        if (!target) return;
        if (currentBranch && target === currentBranch) {
            closeMenu();
            return;
        }

        let strategy: 'stash_on_current_branch' | 'bring_changes';
        if (!hasUncommittedChanges(snapshot) || branchSwitchSetting === 'always_bring' || !currentBranch) {
            strategy = 'bring_changes';
        } else if (branchSwitchSetting === 'always_stash') {
            strategy = 'stash_on_current_branch';
        } else {
            const choice = await showSwitchBranchWithChangesDialog({ currentBranch, targetBranch: target });
            if (choice === 'cancel') return;
            strategy = choice;
        }
        closeMenu();

        const attemptCheckout = (overwriteCurrentBranchStash: boolean) => sessionScmBranchCheckout(props.sessionId, {
            name: target,
            strategy,
            ...(overwriteCurrentBranchStash ? { overwriteCurrentBranchStash: true } : null),
        }, props.serverId);

        await runSessionScmMutation({
            state: storage.getState(),
            sessionId: props.sessionId,
            ...(props.serverId === undefined ? {} : { serverId: props.serverId }),
            operation: 'branch_switch',
            cwd: repoPath,
            fallbackError: t('files.branchMenu.switch.failed'),
            run: async () => {
                const response = await attemptCheckout(false);
                if (strategy !== 'stash_on_current_branch' || !isBranchStashAlreadyExistsError(response)) return response;
                const overwrite = askBeforeOverwrite
                    ? await Modal.confirm(
                        t('files.branchMenu.stashOverwrite.title'),
                        t('files.branchMenu.stashOverwrite.body', { branch: currentBranch ?? '' }),
                        {
                            confirmText: t('files.branchMenu.stashOverwrite.confirm'),
                            cancelText: t('common.cancel'),
                            destructive: true,
                        },
                    )
                    : true;
                return overwrite ? await attemptCheckout(true) : 'cancelled' as const;
            },
            successDetail: () => target,
            refreshAfterMutation: afterBranchWrite,
        });
    }, [
        afterBranchWrite, askBeforeOverwrite, branchSwitchSetting, canCheckout, closeMenu, currentBranch,
        props.sessionId, props.serverId, repoPath, snapshot,
    ]);

    const keepChangesAside = React.useCallback(async () => {
        if (!canCreateStash || disabled || changedCount === 0) return;
        closeMenu();
        await runSessionScmMutation({
            state: storage.getState(),
            sessionId: props.sessionId,
            ...(props.serverId === undefined ? {} : { serverId: props.serverId }),
            operation: 'stash_create',
            cwd: repoPath,
            fallbackError: t('sessionGitBranches.keepAsideFailed'),
            run: () => sessionScmStashCreate(props.sessionId, {}, props.serverId),
            successDetail: (response) => response.stashRef ?? undefined,
            refreshAfterMutation: () => scmStatusSync.invalidateFromMutationAndAwait(props.sessionId, props.serverId),
        });
    }, [canCreateStash, changedCount, closeMenu, disabled, props.sessionId, props.serverId, repoPath]);

    const createWorktreeFromCurrentBranch = React.useCallback(async () => {
        if (!canCreateWorktrees || !machineTarget || !currentBranch) return;
        const response = await repoScmWorktreeService.createWorktreeForMachinePath({
            machineId: machineTarget.machineId,
            path: machineTarget.basePath,
            baseRef: null,
            ...(targetServerId ? { serverId: targetServerId } : {}),
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.worktrees.createFailed'));
            return;
        }
        closeMenu();
        openNewSessionForDirectory(resolveSessionPathWithinWorktree({
            selectedPath: machineTarget.basePath,
            worktreePath: response.worktreePath,
            sourceRootPath: response.sourceRootPath || machineTarget.basePath,
        }));
    }, [canCreateWorktrees, closeMenu, currentBranch, machineTarget, openNewSessionForDirectory, targetServerId]);

    const pruneWorktrees = React.useCallback(async () => {
        if (!canCreateWorktrees || !machineTarget) return;
        const response = await repoScmWorktreeService.pruneWorktreesForMachinePath({
            machineId: machineTarget.machineId,
            path: machineTarget.basePath,
            ...(targetServerId ? { serverId: targetServerId } : {}),
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.stderr || t('files.branchMenu.worktrees.pruneFailed'));
            return;
        }
        closeMenu();
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId, props.serverId);
    }, [canCreateWorktrees, closeMenu, machineTarget, props.sessionId, props.serverId, targetServerId]);

    const removeWorktree = React.useCallback(async (worktreePath: string) => {
        if (!canCreateWorktrees || !machineTarget) return;
        const confirmed = await Modal.confirm(
            t('files.branchMenu.worktrees.removeConfirmTitle'),
            t('files.branchMenu.worktrees.removeConfirmBody', { path: worktreePath }),
            {
                confirmText: t('files.branchMenu.worktrees.removeConfirmButton'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        const response = await repoScmWorktreeService.removeWorktreeForMachinePath({
            machineId: machineTarget.machineId,
            path: machineTarget.basePath,
            worktreePath,
            ...(targetServerId ? { serverId: targetServerId } : {}),
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.stderr || t('files.branchMenu.worktrees.removeFailed'));
            return;
        }
        closeMenu();
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId, props.serverId);
    }, [canCreateWorktrees, closeMenu, machineTarget, props.sessionId, props.serverId, targetServerId]);

    const directoryFallback = machineTarget?.basePath ?? snapshot?.repo.rootPath ?? '.';
    const onOpenStashDetails = props.onOpenStashDetails;

    const onSelect = React.useCallback(async (itemId: string) => {
        if (itemId === GIT_BRANCH_MENU_ITEM_IDS.newBranch) {
            setFocusSearchRequest((value) => value + 1);
            return;
        }
        if (itemId === GIT_BRANCH_MENU_ITEM_IDS.keepAside) {
            await keepChangesAside();
            return;
        }
        if (itemId.startsWith(GIT_BRANCH_MENU_ITEM_IDS.stashPrefix)) {
            closeMenu();
            onOpenStashDetails?.();
            return;
        }
        await handleSourceControlBranchMenuSelect({
            itemId,
            closeMenu,
            createWorktreeFromCurrentBranch,
            directoryFallback,
            machineTarget: machineTarget ? { machineId: machineTarget.machineId, basePath: machineTarget.basePath } : null,
            openNewSessionForDirectory,
            pruneWorktrees,
            removeWorktree,
            router,
            setIncludeRemotes,
            setOpen,
            switchBranch,
            targetServerId,
        });
    }, [
        closeMenu, createWorktreeFromCurrentBranch, directoryFallback, keepChangesAside, machineTarget,
        onOpenStashDetails, openNewSessionForDirectory, pruneWorktrees, removeWorktree, router, switchBranch, targetServerId,
    ]);

    return (
        <WorkspaceScmBranchPopover
            open={open}
            onOpenChange={setOpen}
            currentBranch={currentBranch}
            branchItems={branchItems}
            worktreeItems={worktreeItems}
            onSelectItem={onSelect}
            onCreateBranch={canCreate ? createBranch : null}
            triggerAppearance={props.appearance ?? 'line'}
            focusSearchRequest={focusSearchRequest}
            testID={props.testID}
        />
    );
}
