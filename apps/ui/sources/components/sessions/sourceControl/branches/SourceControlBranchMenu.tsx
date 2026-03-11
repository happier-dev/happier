import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { ScmBranchListEntry } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { usePublishBranchAction } from '@/hooks/session/sourceControl/usePublishBranchAction';
import { Modal } from '@/modal';
import { sessionScmBranchCheckout, sessionScmBranchCreate, sessionScmBranchList } from '@/sync/ops';
import { useSetting } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { showSwitchBranchWithChangesDialog } from './SwitchBranchWithChangesDialog';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';

type BranchSwitchSetting = 'ask' | 'always_bring' | 'always_stash';

function normalizeBranchSwitchSetting(value: unknown): BranchSwitchSetting {
    if (value === 'always_bring' || value === 'always_stash' || value === 'ask') return value;
    return 'ask';
}

function hasUncommittedChanges(snapshot: ScmWorkingSnapshot | null): boolean {
    const totals = snapshot?.totals;
    if (!totals) return false;
    return (totals.includedFiles ?? 0) > 0 || (totals.pendingFiles ?? 0) > 0 || (totals.untrackedFiles ?? 0) > 0;
}

function isBranchStashAlreadyExistsError(response: Readonly<{ success: boolean; errorCode?: string; error?: string }>): boolean {
    if (response.success) return false;
    if (response.errorCode !== SCM_OPERATION_ERROR_CODES.INVALID_REQUEST) return false;
    const message = typeof response.error === 'string' ? response.error.toLowerCase() : '';
    return message.includes('stash') && message.includes('already') && message.includes('branch');
}

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
    const disabled = props.disabled === true;
    const writeEnabled = props.writeEnabled !== false;
    const snapshot = props.snapshot;
    const currentBranch = props.currentBranch;

    const branchSwitchSettingRaw = useSetting('scmUncommittedChangesStrategy');
    const branchSwitchSetting = normalizeBranchSwitchSetting(branchSwitchSettingRaw);
    const askBeforeOverwriteRaw = useSetting('scmAskBeforeOverwritingBranchStash');
    const askBeforeOverwrite = askBeforeOverwriteRaw !== false;

    const canReadBranches = snapshot?.capabilities?.readBranches === true;
    const canCheckout = snapshot?.capabilities?.writeBranchCheckout === true && writeEnabled && !disabled;
    const canCreate = snapshot?.capabilities?.writeBranchCreate === true && writeEnabled && !disabled;
    const { canPublish, publishBranch } = usePublishBranchAction({
        sessionId: props.sessionId,
        snapshot,
        writeEnabled,
        disabled,
    });

    const [open, setOpen] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const [branches, setBranches] = React.useState<ScmBranchListEntry[]>([]);
    const [includeRemotes, setIncludeRemotes] = React.useState(false);

    const loadBranches = React.useCallback(async () => {
        if (!canReadBranches) {
            setBranches([]);
            return;
        }
        setLoading(true);
        try {
            const response = await sessionScmBranchList(props.sessionId, { includeRemotes });
            if (!response.success) {
                Modal.alert(t('common.error'), response.error || t('files.branchMenu.failedToLoad'));
                setBranches([]);
                return;
            }
            setBranches(response.branches ?? []);
        } catch (error) {
            const message = error instanceof Error ? error.message : t('files.branchMenu.failedToLoad');
            Modal.alert(t('common.error'), message);
            setBranches([]);
        } finally {
            setLoading(false);
        }
    }, [canReadBranches, includeRemotes, props.sessionId]);

    React.useEffect(() => {
        if (!open) return;
        void loadBranches();
    }, [loadBranches, open]);

    const items: DropdownMenuItem[] = React.useMemo(() => {
        const out: DropdownMenuItem[] = [];

        if (canPublish) {
            out.push({
                id: 'publish',
                title: t('files.branchMenu.publish.title'),
                subtitle: t('files.branchMenu.publish.subtitle'),
                category: t('files.branchMenu.category.actions'),
            });
        }

        if (loading) {
            out.push({
                id: 'loading',
                title: t('common.loading'),
                disabled: true,
                category: t('files.branchMenu.category.branches'),
            });
            return out;
        }

        if (!canReadBranches) {
            out.push({
                id: 'unsupported',
                title: t('files.branchMenu.unavailable'),
                disabled: true,
                category: t('files.branchMenu.category.branches'),
            });
            return out;
        }

        const sorted = [...branches].sort((a, b) => {
            if (a.type !== b.type) return a.type === 'local' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        for (const branch of sorted) {
            const isCurrent = branch.isCurrent === true || (currentBranch ? branch.name === currentBranch : false);
            out.push({
                id: `branch:${branch.name}`,
                title: branch.name,
                subtitle: branch.upstream ? t('files.branchMenu.branch.upstream', { upstream: branch.upstream }) : undefined,
                category: branch.type === 'remote' ? t('files.branchMenu.category.remote') : t('files.branchMenu.category.local'),
                disabled: !canCheckout || isCurrent,
                rightElement: isCurrent ? (
                    <Octicons name="check" size={14} color={theme.colors.textSecondary} />
                ) : null,
            });
        }

        out.push({
            id: includeRemotes ? 'remotes_off' : 'remotes_on',
            title: includeRemotes ? t('files.branchMenu.remotes.hide') : t('files.branchMenu.remotes.show'),
            subtitle: t('files.branchMenu.remotes.subtitle'),
            category: t('files.branchMenu.category.options'),
            disabled: !canReadBranches,
        });

        return out;
    }, [branches, canCheckout, canPublish, canReadBranches, currentBranch, includeRemotes, loading, theme.colors.textSecondary]);

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
        await scmStatusSync.invalidateFromMutationAndAwait(props.sessionId);
        setOpen(true);
        void loadBranches();
    }, [canCreate, loadBranches, props.sessionId]);

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

        if (!response.success) {
            Modal.alert(t('common.error'), response.error || t('files.branchMenu.switch.failed'));
            return;
        }

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

    const onSelect = React.useCallback(async (itemId: string) => {
        if (itemId === 'publish') {
            const published = await publishBranch();
            if (published) closeMenu();
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
            const name = itemId.slice('branch:'.length);
            await switchBranch(name);
            return;
        }
    }, [closeMenu, publishBranch, switchBranch]);

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
