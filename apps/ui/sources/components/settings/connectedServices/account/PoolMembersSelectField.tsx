import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { t } from '@/text';

import { computePoolMembershipDiff } from './poolMembershipDiff';

/** An account eligible for pool membership. */
export type PoolMembershipCandidate = Readonly<{
    accountId: string;
    title: string;
    subtitle?: string;
}>;

export type PoolMembersSelectFieldProps = Readonly<{
    candidates: ReadonlyArray<PoolMembershipCandidate>;
    /** Current authoritative membership (account ids). */
    selectedAccountIds: ReadonlyArray<string>;
    /** Receives the target membership in candidate order when the draft is committed. */
    onCommit: (nextSelectedAccountIds: ReadonlyArray<string>) => void;
    disabled?: boolean;
    testID?: string;
}>;

/** Above this many candidates the menu gets a search field. */
const SEARCHABLE_CANDIDATE_THRESHOLD = 8;

/**
 * The single membership control for a pool: a multi-select dropdown listing
 * every eligible account — members and non-members alike — with a checkbox each.
 *
 * Toggling edits a LOCAL DRAFT and issues no request. The draft is committed as
 * one batch when the menu closes, because each add/remove is a separate
 * sequential call: committing per keystroke would fire a burst of round-trips
 * and churn the rows underneath the open menu. Removals are confirmed once, at
 * commit, since unchecking is otherwise a silent destructive action.
 */
export const PoolMembersSelectField = React.memo(function PoolMembersSelectField(
    props: PoolMembersSelectFieldProps,
) {
    const { theme } = useUnistyles();
    const { candidates, onCommit, selectedAccountIds } = props;
    const [open, setOpen] = React.useState(false);
    const [draft, setDraft] = React.useState<ReadonlySet<string> | null>(null);

    // Kept referentially stable so the derived memos below actually hold.
    const committedSelection = React.useMemo(() => new Set(selectedAccountIds), [selectedAccountIds]);
    const selected = draft ?? committedSelection;

    const selectedCount = React.useMemo(
        () => candidates.reduce((count, candidate) => (selected.has(candidate.accountId) ? count + 1 : count), 0),
        [candidates, selected],
    );

    const commitDraft = React.useCallback(async (nextSelected: ReadonlySet<string>) => {
        // Preserve candidate order so the resulting membership is deterministic.
        const nextSelectedAccountIds = candidates
            .map((candidate) => candidate.accountId)
            .filter((accountId) => nextSelected.has(accountId));
        const { toAdd, toRemove } = computePoolMembershipDiff(selectedAccountIds, nextSelectedAccountIds);
        if (toAdd.length === 0 && toRemove.length === 0) return;

        if (toRemove.length > 0) {
            const removedTitles = toRemove.map((accountId) => (
                candidates.find((candidate) => candidate.accountId === accountId)?.title ?? accountId
            ));
            const ok = await Modal.confirm(
                t('connectedServices.detail.groupActions.removeMemberConfirmTitle'),
                t('connectedServices.detail.groupActions.removeMembersConfirmBody', {
                    count: toRemove.length,
                    members: removedTitles.join(', '),
                }),
                {
                    confirmText: t('connectedServices.detail.groupActions.removeMember'),
                    cancelText: t('common.cancel'),
                    destructive: true,
                },
            );
            if (!ok) return;
        }

        onCommit(nextSelectedAccountIds);
    }, [candidates, onCommit, selectedAccountIds]);

    const handleOpenChange = React.useCallback((next: boolean) => {
        setOpen(next);
        if (next) {
            // Seed the draft from authoritative membership at open time.
            setDraft(new Set(selectedAccountIds));
            return;
        }
        // Commit OUTSIDE the state updater: an updater may run twice (StrictMode),
        // which would fire the batch — and its confirmation — a second time.
        if (draft) void commitDraft(draft);
        setDraft(null);
    }, [commitDraft, draft, selectedAccountIds]);

    const handleSelect = React.useCallback((accountId: string) => {
        setDraft((current) => {
            const next = new Set(current ?? selectedAccountIds);
            if (next.has(accountId)) next.delete(accountId);
            else next.add(accountId);
            return next;
        });
    }, [selectedAccountIds]);

    const items = React.useMemo(() => candidates.map((candidate) => {
        const checked = selected.has(candidate.accountId);
        return {
            id: candidate.accountId,
            testID: `qualified-connected-account-group:members:option:${candidate.accountId}`,
            title: candidate.title,
            subtitle: candidate.subtitle,
            icon: (
                <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon
                        name={checked ? 'check-square' : 'square'}
                        size={20}
                        color={checked ? theme.colors.accent.blue : theme.colors.text.secondary}
                    />
                </View>
            ),
        };
    }), [candidates, selected, theme.colors.accent.blue, theme.colors.text.secondary]);

    const disabled = props.disabled || candidates.length === 0;

    return (
        <DropdownMenu
            open={open}
            onOpenChange={handleOpenChange}
            items={items}
            onSelect={handleSelect}
            closeOnSelect={false}
            selectedId={null}
            variant="selectable"
            rowKind="item"
            showCategoryTitles={false}
            matchTriggerWidth
            search={candidates.length > SEARCHABLE_CANDIDATE_THRESHOLD}
            searchPlaceholder={t('connectedServices.detail.groupActions.searchMembersPlaceholder')}
            trigger={({ toggle, open: isOpen }) => (
                <Item
                    testID={props.testID}
                    title={t('connectedServices.detail.groupActions.manageMembersTitle')}
                    subtitle={candidates.length === 0
                        ? t('connectedServices.detail.profiles.empty')
                        : t('connectedServices.detail.groupActions.manageMembersSubtitle', {
                            count: selectedCount,
                            total: candidates.length,
                        })}
                    icon={<Icon name="users" size={20} color={theme.colors.accent.blue} />}
                    rightElement={(
                        <Icon
                            name={isOpen ? 'caret-up' : 'caret-down'}
                            size={20}
                            color={theme.colors.text.secondary}
                        />
                    )}
                    onPress={disabled ? undefined : toggle}
                    disabled={disabled}
                    showChevron={false}
                />
            )}
        />
    );
});
