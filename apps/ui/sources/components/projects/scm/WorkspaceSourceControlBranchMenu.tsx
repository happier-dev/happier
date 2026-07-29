import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { repoScmBranchService } from '@/scm/repository/repoScmBranchService';
import { repoScmWorktreeService } from '@/scm/repository/repoScmWorktreeService';
import { useRepoScmBranchList } from '@/scm/repository/useRepoScmBranchList';
import { buildWorkspaceScmBranchPopoverItems } from '@/components/workspaces/scm/branches/buildWorkspaceScmBranchPopoverItems';
import { filterVisibleRepoWorktreeRows } from '@/components/workspaces/scm/worktrees/filterVisibleRepoWorktreeRows';
import { sortRepoWorktreeRows } from '@/components/workspaces/scm/worktrees/sortRepoWorktreeRows';
import {
    hasUncommittedChanges,
    isBranchStashAlreadyExistsError,
    normalizeBranchSwitchSetting,
} from '@/components/workspaces/scm/branches/branchMenuPredicates';
import { showSwitchBranchWithChangesDialog } from '@/components/workspaces/scm/branches/SwitchBranchWithChangesDialog';
import { WorkspaceScmBranchPopover } from '@/components/workspaces/scm/branches/WorkspaceScmBranchPopover';
import { machineScmBranchCheckout, machineScmBranchCreate } from '@/sync/ops/scm/machineScm';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type WorkspaceSourceControlBranchMenuProps = Readonly<{
    serverId?: string | null;
    machineId: string;
    rootPath: string;
    currentBranch: string | null;
    snapshot: ScmWorkingSnapshot | null;
    writeEnabled?: boolean;
    disabled?: boolean;
    onRefreshSnapshot: () => Promise<void>;
    onSelectWorkspacePath?: (path: string) => void;
    onRequestCreateWorktreeFromAnotherBranch?: () => void;
    testID?: string;
}>;

export function WorkspaceSourceControlBranchMenu(props: WorkspaceSourceControlBranchMenuProps): React.ReactElement {
    const { theme } = useUnistyles();
    const disabled = props.disabled === true;
    const writeEnabled = props.writeEnabled !== false;
    const snapshot = props.snapshot;
    const currentBranch = props.currentBranch;
    const serverId = typeof props.serverId === 'string' ? props.serverId.trim() : '';
    const machineScmOptions = React.useMemo(() => (
        serverId ? { serverId } : undefined
    ), [serverId]);

    const branchSwitchSettingRaw = useSetting('scmUncommittedChangesStrategy');
    const branchSwitchSetting = normalizeBranchSwitchSetting(branchSwitchSettingRaw);
    const askBeforeOverwriteRaw = useSetting('scmAskBeforeOverwritingBranchStash');
    const askBeforeOverwrite = askBeforeOverwriteRaw !== false;

    const canReadBranches = snapshot?.capabilities?.readBranches === true;
    const canCheckout = snapshot?.capabilities?.writeBranchCheckout === true && writeEnabled && !disabled;
    const canCreate = snapshot?.capabilities?.writeBranchCreate === true && writeEnabled && !disabled;
    const canCreateWorktrees = snapshot?.capabilities?.worktreeCreate === true && writeEnabled && !disabled;
    const canLaunchWorktreeSession = snapshot?.repo.isRepo === true;

    const [open, setOpen] = React.useState(false);
    const [includeRemotes, setIncludeRemotes] = React.useState(false);

    const worktreeRows = React.useMemo(() => {
        const worktrees = snapshot?.repo.worktrees ?? [];
        return sortRepoWorktreeRows(filterVisibleRepoWorktreeRows(worktrees));
    }, [snapshot?.repo.worktrees]);

    const selectWorkspacePath = React.useCallback((path: string) => {
        props.onSelectWorkspacePath?.(path);
    }, [props]);

    const readCachedBranches = React.useCallback(() => {
        return repoScmBranchService.readCachedBranchesForMachinePath({
            machineId: props.machineId,
            path: props.rootPath,
            includeRemotes,
        });
    }, [includeRemotes, props.machineId, props.rootPath]);

    const fetchBranches = React.useCallback(async () => {
        return await repoScmBranchService.fetchBranchesForMachinePath({
            ...(serverId ? { serverId } : {}),
            machineId: props.machineId,
            path: props.rootPath,
            includeRemotes,
        });
    }, [includeRemotes, props.machineId, props.rootPath, serverId]);

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

    const { branchItems, worktreeItems } = React.useMemo(() => {
        const built = buildWorkspaceScmBranchPopoverItems({
            branches,
            canCheckout,
            canCreateWorktrees,
            canLaunchWorktreeSession,
            canReadBranches,
            currentBranch,
            includeRemotes,
            loading,
            hasMachineTarget: true,
            worktreeRows,
            checkIconColor: theme.colors.text.secondary,
        });
        if (props.onRequestCreateWorktreeFromAnotherBranch) {
            return built;
        }
        return {
            branchItems: built.branchItems,
            worktreeItems: built.worktreeItems.map((item) => {
                if (item.id !== 'worktree:create-from-another-branch') return item;
                return {
                    ...item,
                    disabled: true,
                };
            }),
        };
    }, [
        branches,
        canCheckout,
        canCreateWorktrees,
        canLaunchWorktreeSession,
        canReadBranches,
        currentBranch,
        includeRemotes,
        loading,
        props.onRequestCreateWorktreeFromAnotherBranch,
        theme.colors.text.secondary,
        worktreeRows,
    ]);

    const closeMenu = React.useCallback(() => setOpen(false), []);

    const refreshWorkspaceState = React.useCallback(async () => {
        closeMenu();
        await props.onRefreshSnapshot();
    }, [closeMenu, props]);

    const createBranch = React.useCallback(async (name: string) => {
        if (!canCreate) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        const response = await machineScmBranchCreate(props.machineId, {
            cwd: props.rootPath,
            name: trimmed,
            checkout: true,
        }, machineScmOptions);
        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.create.failed'));
            return;
        }
        await refreshWorkspaceState();
        setOpen(true);
        void refresh('loading');
    }, [canCreate, machineScmOptions, props.machineId, props.rootPath, refresh, refreshWorkspaceState]);

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
        } else if (!currentBranch) {
            strategy = 'bring_changes';
        } else {
            const choice = await showSwitchBranchWithChangesDialog({
                currentBranch,
                targetBranch: target,
            });
            if (choice === 'cancel') return;
            strategy = choice;
        }

        const attemptCheckout = async (overwriteCurrentBranchStash?: boolean) => {
            return await machineScmBranchCheckout(props.machineId, {
                cwd: props.rootPath,
                name: target,
                strategy,
                ...(overwriteCurrentBranchStash ? { overwriteCurrentBranchStash: true } : null),
            }, machineScmOptions);
        };

        let response = await attemptCheckout(false);
        if (strategy === 'stash_on_current_branch' && isBranchStashAlreadyExistsError(response)) {
            const shouldOverwrite = askBeforeOverwrite
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
            response = await attemptCheckout(true);
        }

        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.switch.failed'));
            return;
        }

        await refreshWorkspaceState();
    }, [
        askBeforeOverwrite,
        branchSwitchSetting,
        canCheckout,
        closeMenu,
        currentBranch,
        machineScmOptions,
        props.machineId,
        props.rootPath,
        refreshWorkspaceState,
        snapshot,
    ]);

    const createWorktreeFromCurrentBranch = React.useCallback(async () => {
        if (!canCreateWorktrees) return;

        const response = await repoScmWorktreeService.createWorktreeForMachinePath({
            ...(serverId ? { serverId } : {}),
            machineId: props.machineId,
            path: props.rootPath,
            baseRef: null,
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.worktrees.createFailed'));
            return;
        }

        await refreshWorkspaceState();
        if (response.worktreePath) {
            selectWorkspacePath(response.worktreePath);
        }
    }, [canCreateWorktrees, props.machineId, props.rootPath, refreshWorkspaceState, selectWorkspacePath, serverId]);

    const pruneWorktrees = React.useCallback(async () => {
        if (!canCreateWorktrees) return;
        const response = await repoScmWorktreeService.pruneWorktreesForMachinePath({
            ...(serverId ? { serverId } : {}),
            machineId: props.machineId,
            path: props.rootPath,
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.stderr || t('files.branchMenu.worktrees.pruneFailed'));
            return;
        }
        await refreshWorkspaceState();
    }, [canCreateWorktrees, props.machineId, props.rootPath, refreshWorkspaceState, serverId]);

    const removeWorktree = React.useCallback(async (worktreePath: string) => {
        if (!canCreateWorktrees) return;

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
            ...(serverId ? { serverId } : {}),
            machineId: props.machineId,
            path: props.rootPath,
            worktreePath,
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.stderr || t('files.branchMenu.worktrees.removeFailed'));
            return;
        }
        await refreshWorkspaceState();
    }, [canCreateWorktrees, props.machineId, props.rootPath, refreshWorkspaceState, serverId]);

    const onSelect = React.useCallback(async (itemId: string) => {
        if (itemId === 'worktree:create-current-branch') {
            await createWorktreeFromCurrentBranch();
            return;
        }
        if (itemId === 'worktree:create-from-another-branch') {
            closeMenu();
            props.onRequestCreateWorktreeFromAnotherBranch?.();
            return;
        }
        if (itemId === 'worktree:prune') {
            await pruneWorktrees();
            return;
        }
        if (itemId.startsWith('worktree:open:')) {
            closeMenu();
            selectWorkspacePath(itemId.slice('worktree:open:'.length));
            return;
        }
        if (itemId.startsWith('worktree:remove:')) {
            await removeWorktree(itemId.slice('worktree:remove:'.length));
            return;
        }
        if (itemId === 'remotes_on') {
            setIncludeRemotes(true);
            setOpen(true);
            return;
        }
        if (itemId === 'remotes_off') {
            setIncludeRemotes(false);
            setOpen(true);
            return;
        }
        if (itemId.startsWith('branch:')) {
            await switchBranch(itemId.slice('branch:'.length));
        }
    }, [
        closeMenu,
        createWorktreeFromCurrentBranch,
        props.onRequestCreateWorktreeFromAnotherBranch,
        pruneWorktrees,
        removeWorktree,
        selectWorkspacePath,
        switchBranch,
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
