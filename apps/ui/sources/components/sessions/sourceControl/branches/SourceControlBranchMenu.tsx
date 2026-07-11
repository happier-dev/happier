import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { repoScmBranchService } from '@/scm/repository/repoScmBranchService';
import { resolveSessionPathWithinWorktree } from '@/scm/repository/resolveSessionPathWithinWorktree';
import { useRepoScmBranchList } from '@/scm/repository/useRepoScmBranchList';
import { repoScmWorktreeService } from '@/scm/repository/repoScmWorktreeService';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import { sessionScmBranchCheckout, sessionScmBranchCreate, sessionScmRepositoryRemoveIndexLock } from '@/sync/ops';
import { useSetting } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { showSwitchBranchWithChangesDialog } from '@/components/workspaces/scm/branches/SwitchBranchWithChangesDialog';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { buildWorkspaceScmBranchPopoverItems } from '@/components/workspaces/scm/branches/buildWorkspaceScmBranchPopoverItems';
import { filterVisibleRepoWorktreeRows } from '@/components/workspaces/scm/worktrees/filterVisibleRepoWorktreeRows';
import { WorkspaceScmBranchPopover } from '@/components/workspaces/scm/branches/WorkspaceScmBranchPopover';
import {
    hasUncommittedChanges,
    isBranchStashAlreadyExistsError,
    normalizeBranchSwitchSetting,
} from '@/components/workspaces/scm/branches/branchMenuPredicates';
import { handleSourceControlBranchMenuSelect } from './handleSourceControlBranchMenuSelect';

export type SourceControlBranchMenuProps = Readonly<{
    sessionId: string;
    currentBranch: string | null;
    snapshot: ScmWorkingSnapshot | null;
    writeEnabled?: boolean;
    disabled?: boolean;
    testID?: string;
}>;

export function SourceControlBranchMenu(props: SourceControlBranchMenuProps): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();
    const disabled = props.disabled === true;
    const writeEnabled = props.writeEnabled !== false;
    const snapshot = props.snapshot;
    const currentBranch = props.currentBranch;
    const machineTarget = readMachineTargetForSession(props.sessionId);
    const targetServerId = usePreferredServerIdForSession(props.sessionId);
    const repoPath = machineTarget?.basePath ?? snapshot?.repo.rootPath ?? null;

    const branchSwitchSettingRaw = useSetting('scmUncommittedChangesStrategy');
    const branchSwitchSetting = normalizeBranchSwitchSetting(branchSwitchSettingRaw);
    const askBeforeOverwriteRaw = useSetting('scmAskBeforeOverwritingBranchStash');
    const askBeforeOverwrite = askBeforeOverwriteRaw !== false;

    const canReadBranches = snapshot?.capabilities?.readBranches === true;
    const canCheckout = snapshot?.capabilities?.writeBranchCheckout === true && writeEnabled && !disabled;
    const canCreate = snapshot?.capabilities?.writeBranchCreate === true && writeEnabled && !disabled;
    const [open, setOpen] = React.useState(false);
    const [includeRemotes, setIncludeRemotes] = React.useState(false);

    const worktreeRows = React.useMemo(() => {
        const worktrees = snapshot?.repo.worktrees ?? [];
        return [...filterVisibleRepoWorktreeRows(worktrees)].sort((left, right) => {
            if (left.isCurrent === true && right.isCurrent !== true) return -1;
            if (left.isCurrent !== true && right.isCurrent === true) return 1;
            return (left.branch ?? left.path).localeCompare(right.branch ?? right.path);
        });
    }, [snapshot?.repo.worktrees]);
    const canCreateWorktrees = snapshot?.capabilities?.worktreeCreate === true && writeEnabled && !disabled;
    const canLaunchWorktreeSession = snapshot?.repo.isRepo === true;

    const openNewSessionForDirectory = React.useCallback((directory: string) => {
        router.push({
            pathname: '/new',
            params: buildNewSessionLaunchRouteParams({
                directory,
                machineId: machineTarget?.machineId ?? null,
                targetServerId,
            }),
        });
    }, [machineTarget?.machineId, router, targetServerId]);

    const readCachedBranches = React.useCallback(() => {
        return repoScmBranchService.readCachedBranchesForSession({
            sessionId: props.sessionId,
            includeRemotes,
        });
    }, [includeRemotes, props.sessionId]);

    const fetchBranches = React.useCallback(async () => {
        return await repoScmBranchService.fetchBranchesForSession({
            sessionId: props.sessionId,
            includeRemotes,
        });
    }, [includeRemotes, props.sessionId]);

    const handleBranchLoadError = React.useCallback((error: unknown) => {
        const message = error instanceof Error ? error.message : t('files.branchMenu.failedToLoad');
        Modal.alert(t('common.error'), message);
    }, []);

    const { branches, phase, refresh } = useRepoScmBranchList({
        ready: canReadBranches,
        autoLoad: open && canReadBranches,
        readCached: readCachedBranches,
        fetch: fetchBranches,
        onError: handleBranchLoadError,
    });
    const loading = phase !== 'idle';
    const runSessionBranchMutation = React.useCallback(async <
        TResponse extends { success: boolean; error?: string; stderr?: string; errorCode?: string },
    >(operation: () => Promise<TResponse>): Promise<TResponse> => {
        const response = await operation();
        if (response.success || !repoPath) return response;
        return await runScmOperationWithGitIndexLockRecovery<TResponse, TResponse>({
            cwd: repoPath,
            failedResponse: response,
            removeIndexLock: (request) => sessionScmRepositoryRemoveIndexLock(props.sessionId, request),
            retryOriginalOperation: operation,
        });
    }, [props.sessionId, repoPath]);

    const { branchItems, worktreeItems } = React.useMemo(() => {
        return buildWorkspaceScmBranchPopoverItems({
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
        });
    }, [
        branches,
        canCheckout,
        canCreateWorktrees,
        canLaunchWorktreeSession,
        canReadBranches,
        currentBranch,
        includeRemotes,
        loading,
        machineTarget,
        theme.colors.text.secondary,
        worktreeRows,
    ]);

    const createBranch = React.useCallback(async (name: string) => {
        if (!canCreate) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        const response = await runSessionBranchMutation(() =>
            sessionScmBranchCreate(props.sessionId, { name: trimmed, checkout: true })
        );
        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.create.failed'));
            return;
        }
        repoScmBranchService.invalidateBranchesForSession({ sessionId: props.sessionId });
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
        setOpen(true);
        void refresh('loading');
    }, [canCreate, props.sessionId, refresh, runSessionBranchMutation]);

    const closeMenu = React.useCallback(() => setOpen(false), []);

    const switchBranch = React.useCallback(async (targetBranch: string) => {
        if (!canCheckout) return;
        const target = targetBranch.trim();
        if (!target) return;
        if (currentBranch && target === currentBranch) {
            closeMenu();
            return;
        }

        let strategy: 'stash_on_current_branch' | 'bring_changes' | null = null;
        const dirty = hasUncommittedChanges(snapshot);
        if (!dirty) {
            strategy = 'bring_changes';
        } else if (branchSwitchSetting === 'always_bring') {
            strategy = 'bring_changes';
        } else if (branchSwitchSetting === 'always_stash') {
            strategy = 'stash_on_current_branch';
        } else {
            if (!currentBranch) {
                strategy = 'bring_changes';
            } else {
                const choice = await showSwitchBranchWithChangesDialog({
                    currentBranch,
                    targetBranch: target,
                });
                if (choice === 'cancel') return;
                strategy = choice;
            }
        }

        const attemptCheckout = async (overwriteCurrentBranchStash?: boolean) => {
            return await sessionScmBranchCheckout(props.sessionId, {
                name: target,
                strategy,
                ...(overwriteCurrentBranchStash ? { overwriteCurrentBranchStash: true } : null),
            });
        };

        let response = await runSessionBranchMutation(() => attemptCheckout(false));
        if (strategy === 'stash_on_current_branch' && isBranchStashAlreadyExistsError(response)) {
            const shouldOverwrite =
                askBeforeOverwrite
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

            if (!shouldOverwrite) return;
            response = await runSessionBranchMutation(() => attemptCheckout(true));
        }

        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.switch.failed'));
            return;
        }

        repoScmBranchService.invalidateBranchesForSession({ sessionId: props.sessionId });
        closeMenu();
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [
        askBeforeOverwrite,
        branchSwitchSetting,
        canCheckout,
        closeMenu,
        currentBranch,
        props.sessionId,
        runSessionBranchMutation,
        snapshot,
    ]);

    const createWorktreeFromCurrentBranch = React.useCallback(async () => {
        if (!canCreateWorktrees || !machineTarget || !currentBranch) {
            return;
        }

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
        if (!canCreateWorktrees || !machineTarget) {
            return;
        }

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
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [canCreateWorktrees, closeMenu, machineTarget, props.sessionId, targetServerId]);

    const removeWorktree = React.useCallback(async (worktreePath: string) => {
        if (!canCreateWorktrees || !machineTarget) {
            return;
        }

        const confirmed = await Modal.confirm(
            t('files.branchMenu.worktrees.removeConfirmTitle'),
            t('files.branchMenu.worktrees.removeConfirmBody', { path: worktreePath }),
            {
                confirmText: t('files.branchMenu.worktrees.removeConfirmButton'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) {
            return;
        }

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
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [canCreateWorktrees, closeMenu, machineTarget, props.sessionId, targetServerId]);

    const directoryFallback = machineTarget?.basePath ?? snapshot?.repo.rootPath ?? '.';

    const onSelect = React.useCallback(async (itemId: string) => {
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
        closeMenu,
        createWorktreeFromCurrentBranch,
        directoryFallback,
        machineTarget?.basePath,
        machineTarget?.machineId,
        openNewSessionForDirectory,
        pruneWorktrees,
        removeWorktree,
        router,
        switchBranch,
        targetServerId,
    ]);

    return (
        <WorkspaceScmBranchPopover
            open={open}
            onOpenChange={setOpen}
            currentBranch={currentBranch}
            disabled={disabled}
            branchItems={branchItems}
            worktreeItems={worktreeItems}
            onSelectItem={onSelect}
            onCreateBranch={canCreate ? createBranch : null}
            testID={props.testID}
        />
    );
}
