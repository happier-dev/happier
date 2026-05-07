import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import type { ScmBranchListEntry } from '@happier-dev/protocol';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { repoScmBranchService } from '@/scm/repository/repoScmBranchService';
import { resolveSessionPathWithinWorktree } from '@/scm/repository/resolveSessionPathWithinWorktree';
import { useRepoScmBranchList } from '@/scm/repository/useRepoScmBranchList';
import { repoScmWorktreeService } from '@/scm/repository/repoScmWorktreeService';
import {
    sessionScmBranchCheckout,
    sessionScmBranchCreate,
    sessionScmPullRequestCheckout,
    sessionScmPullRequestPrepareWorktree,
    sessionScmRepositoryRemoveIndexLock,
} from '@/sync/ops';
import { useSetting } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { showSwitchBranchWithChangesDialog } from './SwitchBranchWithChangesDialog';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { buildSourceControlBranchMenuItems } from './buildSourceControlBranchMenuItems';
import {
    hasUncommittedChanges,
    isBranchStashAlreadyExistsError,
    isGitIndexLockError,
    normalizeBranchSwitchSetting,
} from './branchMenuPredicates';
import { handleSourceControlBranchMenuSelect } from './handleSourceControlBranchMenuSelect';
import { parsePullRequestReferenceInput } from './pullRequestReferenceInput';

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

    const branchSwitchSettingRaw = useSetting('scmUncommittedChangesStrategy');
    const branchSwitchSetting = normalizeBranchSwitchSetting(branchSwitchSettingRaw);
    const askBeforeOverwriteRaw = useSetting('scmAskBeforeOverwritingBranchStash');
    const askBeforeOverwrite = askBeforeOverwriteRaw !== false;

    const canReadBranches = snapshot?.capabilities?.readBranches === true;
    const canCheckout = snapshot?.capabilities?.writeBranchCheckout === true && writeEnabled && !disabled;
    const canCreate = snapshot?.capabilities?.writeBranchCreate === true && writeEnabled && !disabled;
    const canCheckoutPullRequests =
        snapshot?.capabilities?.writePullRequestCheckout === true && writeEnabled && !disabled;
    const canPreparePullRequestWorktrees =
        snapshot?.capabilities?.writePullRequestPrepareWorktree === true && writeEnabled && !disabled;

    const [open, setOpen] = React.useState(false);
    const [includeRemotes, setIncludeRemotes] = React.useState(false);

    const worktreeRows = React.useMemo(() => {
        const worktrees = snapshot?.repo.worktrees ?? [];
        return [...worktrees].sort((left, right) => {
            if (left.isCurrent === true && right.isCurrent !== true) return -1;
            if (left.isCurrent !== true && right.isCurrent === true) return 1;
            return (left.branch ?? left.path).localeCompare(right.branch ?? right.path);
        });
    }, [snapshot?.repo.worktrees]);
    const canCreateWorktrees = snapshot?.capabilities?.worktreeCreate === true && writeEnabled && !disabled;
    const canLaunchWorktreeSession = snapshot?.repo.isRepo === true;

    const openNewSessionForDirectory = React.useCallback((directory: string) => {
        const params = machineTarget?.machineId
            ? { machineId: machineTarget.machineId, directory }
            : { directory };
        router.push({
            pathname: '/new',
            params,
        });
    }, [machineTarget?.machineId, router]);

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

    const items = React.useMemo(() => {
        return buildSourceControlBranchMenuItems({
            branches,
            canCheckout,
            canCheckoutPullRequests,
            canCreateWorktrees,
            canLaunchWorktreeSession,
            canPreparePullRequestWorktrees,
            canReadBranches,
            currentBranch,
            includeRemotes,
            loading,
            hasMachineTarget: Boolean(machineTarget),
            worktreeRows,
            checkIconColor: theme.colors.textSecondary,
        });
    }, [
        branches,
        canCheckout,
        canCheckoutPullRequests,
        canCreateWorktrees,
        canLaunchWorktreeSession,
        canPreparePullRequestWorktrees,
        canReadBranches,
        currentBranch,
        includeRemotes,
        loading,
        machineTarget,
        theme.colors.textSecondary,
        worktreeRows,
    ]);

    const closeMenu = React.useCallback(() => setOpen(false), []);

    const createBranch = React.useCallback(async (name: string) => {
        if (!canCreate) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        const response = await sessionScmBranchCreate(props.sessionId, { name: trimmed, checkout: true });
        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.create.failed'));
            return;
        }
        repoScmBranchService.invalidateBranchesForSession({ sessionId: props.sessionId });
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
        setOpen(true);
        void refresh('loading');
    }, [canCreate, props.sessionId, refresh]);

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

        let response = await attemptCheckout(false);
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
            response = await attemptCheckout(true);
        }

        if (isGitIndexLockError(response)) {
            const shouldRecover = await Modal.confirm(
                t('files.branchMenu.indexLock.title'),
                t('files.branchMenu.indexLock.body'),
                {
                    confirmText: t('files.branchMenu.indexLock.confirm'),
                    cancelText: t('common.cancel'),
                },
            );
            if (!shouldRecover) return;
            const recovery = await sessionScmRepositoryRemoveIndexLock(props.sessionId, {});
            if (!recovery.success) {
                Modal.alert(t('common.error'), recovery.error || t('files.branchMenu.indexLock.recoveryFailed'));
                return;
            }
            response = await attemptCheckout(false);
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
        snapshot,
    ]);

    const promptForPullRequestReference = React.useCallback(async () => {
        const raw = await Modal.prompt(
            t('files.branchMenu.pullRequests.promptTitle'),
            t('files.branchMenu.pullRequests.promptBody'),
            {
                placeholder: t('files.branchMenu.pullRequests.promptPlaceholder'),
                confirmText: t('common.continue'),
                cancelText: t('common.cancel'),
            },
        );
        if (raw == null) return null;
        const reference = parsePullRequestReferenceInput(raw);
        if (!reference) {
            Modal.alert(
                t('common.error'),
                t('files.branchMenu.pullRequests.invalidReferenceBody'),
            );
            return null;
        }
        return reference;
    }, []);

    const checkoutPullRequestLocally = React.useCallback(async () => {
        if (!canCheckoutPullRequests) return;
        const prReference = await promptForPullRequestReference();
        if (!prReference) return;

        const response = await sessionScmPullRequestCheckout(props.sessionId, {
            prReference,
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.pullRequests.checkoutFailed'));
            return;
        }

        repoScmBranchService.invalidateBranchesForSession({ sessionId: props.sessionId });
        closeMenu();
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [canCheckoutPullRequests, closeMenu, promptForPullRequestReference, props.sessionId]);

    const openPullRequestWorktree = React.useCallback(async () => {
        if (!canPreparePullRequestWorktrees || !machineTarget) return;
        const prReference = await promptForPullRequestReference();
        if (!prReference) return;

        const response = await sessionScmPullRequestPrepareWorktree(props.sessionId, {
            sourcePath: machineTarget.basePath,
            mode: 'worktree',
            prReference,
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.pullRequests.worktreeFailed'));
            return;
        }

        repoScmBranchService.invalidateBranchesForSession({ sessionId: props.sessionId });
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
        closeMenu();
        openNewSessionForDirectory(response.targetPath);
    }, [
        canPreparePullRequestWorktrees,
        closeMenu,
        machineTarget,
        openNewSessionForDirectory,
        promptForPullRequestReference,
        props.sessionId,
    ]);

    const createWorktreeFromCurrentBranch = React.useCallback(async () => {
        if (!canCreateWorktrees || !machineTarget || !currentBranch) {
            return;
        }

        const response = await repoScmWorktreeService.createWorktreeForMachinePath({
            machineId: machineTarget.machineId,
            path: machineTarget.basePath,
            baseRef: null,
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
    }, [canCreateWorktrees, closeMenu, currentBranch, machineTarget, openNewSessionForDirectory]);

    const pruneWorktrees = React.useCallback(async () => {
        if (!canCreateWorktrees || !machineTarget) {
            return;
        }

        const response = await repoScmWorktreeService.pruneWorktreesForMachinePath({
            machineId: machineTarget.machineId,
            path: machineTarget.basePath,
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.stderr || t('files.branchMenu.worktrees.pruneFailed'));
            return;
        }

        closeMenu();
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [canCreateWorktrees, closeMenu, machineTarget, props.sessionId]);

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
        });
        if (!response.success) {
            Modal.alert(t('common.error'), response.stderr || t('files.branchMenu.worktrees.removeFailed'));
            return;
        }

        closeMenu();
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
    }, [canCreateWorktrees, closeMenu, machineTarget, props.sessionId]);

    const directoryFallback = machineTarget?.basePath ?? snapshot?.repo.rootPath ?? '.';

    const onSelect = React.useCallback(async (itemId: string) => {
        await handleSourceControlBranchMenuSelect({
            itemId,
            checkoutPullRequestLocally,
            closeMenu,
            createWorktreeFromCurrentBranch,
            directoryFallback,
            machineTarget: machineTarget ? { machineId: machineTarget.machineId, basePath: machineTarget.basePath } : null,
            openPullRequestWorktree,
            openNewSessionForDirectory,
            pruneWorktrees,
            removeWorktree,
            router,
            setIncludeRemotes,
            setOpen,
            switchBranch,
        });
    }, [
        closeMenu,
        checkoutPullRequestLocally,
        createWorktreeFromCurrentBranch,
        directoryFallback,
        machineTarget?.basePath,
        machineTarget?.machineId,
        openPullRequestWorktree,
        openNewSessionForDirectory,
        pruneWorktrees,
        removeWorktree,
        router,
        switchBranch,
    ]);

    const selectedId = currentBranch ? `branch:${currentBranch}` : null;
    const triggerTestId = props.testID ?? 'scm-branch-menu-trigger';

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            closeOnSelect={false}
            matchTriggerWidth={false}
            items={items}
            onSelect={onSelect}
            selectedId={selectedId}
            search
            searchPlaceholder={t('files.branchMenu.searchPlaceholder')}
            emptyLabel={t('files.branchMenu.empty')}
            onCreateItem={canCreate ? createBranch : null}
            createItemDisplay={(query) => ({
                title: t('files.branchMenu.create.title'),
                subtitle: t('files.branchMenu.create.subtitle', { name: query.trim() }),
                disabled: !query.trim(),
            })}
            trigger={({ toggle }) => (
                <Pressable
                    testID={triggerTestId}
                    accessibilityRole="button"
                    accessibilityLabel={t('files.branchMenu.openA11y')}
                    onPress={toggle}
                    disabled={disabled}
                    style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        opacity: disabled ? 0.6 : pressed ? 0.82 : 1,
                    })}
                >
                    <Text numberOfLines={1} style={{ fontSize: 14, color: theme.colors.text, ...Typography.default('semiBold') }}>
                        {currentBranch || t('files.detachedHead')}
                    </Text>
                    <Octicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
                </Pressable>
            )}
        />
    );
}
