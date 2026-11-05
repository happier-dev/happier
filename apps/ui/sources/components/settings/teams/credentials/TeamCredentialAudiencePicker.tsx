import * as React from 'react';

import type { SessionAccessCandidateRowModel, SessionAccessDirectoryKind, SessionAccessGrantOperationModel } from '@/components/sessions/access/sessionAccessEditorTypes';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import { Item } from '@/components/ui/lists/Item';
import { SELECTION_LIST_MODAL_MAX_HEIGHT, SELECTION_LIST_MODAL_CARD_SCROLL, SelectionList, resolveSelectionListModalHeightBehavior, type SelectionListOption, type SelectionListSectionDescriptor, type SelectionListStep } from '@/components/ui/selectionList';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { getPreferredLanguage, t } from '@/text';

export type TeamCredentialAudiencePrincipal =
    | Readonly<{ kind: 'group'; id: string; name: string }>
    | Readonly<{ kind: 'member'; id: string; accountId: string; name: string }>;
export type TeamCredentialAudiencePrincipalKind = TeamCredentialAudiencePrincipal['kind'];

const EMPTY_OPERATIONS: Readonly<Record<string, SessionAccessGrantOperationModel>> = Object.freeze({});

function optionFromRow(
    row: SessionAccessCandidateRowModel,
    excludedGroupIds: ReadonlySet<string>,
    excludedMemberIds: ReadonlySet<string>,
    choose: (principal: TeamCredentialAudiencePrincipal) => void,
): SelectionListOption | null {
    if (row.teamMembership) {
        if (excludedMemberIds.has(row.teamMembership.teamMembershipId)) return null;
        const membership = row.teamMembership;
        return {
            id: `member:${membership.teamMembershipId}`,
            testID: `team-credential-audience-pick-member:${membership.teamMembershipId}`,
            label: row.principal.displayName,
            subtitle: row.principal.secondaryLabel,
            accessibilityLabel: row.principal.accessibilityLabel,
            onSelect: () => choose({ kind: 'member', id: membership.teamMembershipId, accountId: membership.accountId, name: row.principal.displayName }),
        };
    }
    if (row.teamGroup) {
        if (excludedGroupIds.has(row.teamGroup.teamGroupId)) return null;
        const group = row.teamGroup;
        return {
            id: `group:${group.teamGroupId}`,
            testID: `team-credential-audience-pick-group:${group.teamGroupId}`,
            label: row.principal.displayName,
            subtitle: row.principal.secondaryLabel,
            accessibilityLabel: row.principal.accessibilityLabel,
            onSelect: () => choose({ kind: 'group', id: group.teamGroupId, name: row.principal.displayName }),
        };
    }
    return null;
}

function PickerContent(props: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    excludedGroupIds: readonly string[];
    excludedMemberIds: readonly string[];
    allowedKinds: readonly TeamCredentialAudiencePrincipalKind[];
    label?: string;
    onChoose: (principal: TeamCredentialAudiencePrincipal) => void;
    onClose: () => void;
}>) {
    const [query, setQuery] = React.useState('');
    const allowedDirectoryKinds = React.useMemo<readonly SessionAccessDirectoryKind[]>(() => (
        props.allowedKinds.map((kind) => kind === 'member' ? 'account' : 'group')
    ), [props.allowedKinds]);
    const directory = useSessionAccessDirectory({
        scope: props.scope,
        availability: 'available',
        contextTeams: [],
        operations: EMPTY_OPERATIONS,
        revision: 0,
        enabled: true,
        teamAddress: props.address,
        principalKinds: allowedDirectoryKinds,
    });
    const excludedGroups = React.useMemo(() => new Set(props.excludedGroupIds), [props.excludedGroupIds]);
    const excludedMembers = React.useMemo(() => new Set(props.excludedMemberIds), [props.excludedMemberIds]);
    const choose = React.useCallback((principal: TeamCredentialAudiencePrincipal) => {
        props.onClose();
        props.onChoose(principal);
    }, [props]);
    const visibleSources = directory.sections;
    const sections = visibleSources.map((source): SelectionListSectionDescriptor => ({
        kind: 'static',
        id: `team-credential-audience:${source.kind}`,
        title: source.title,
        options: source.candidates.flatMap((row) => {
            const option = optionFromRow(row, excludedGroups, excludedMembers, choose);
            return option ? [option] : [];
        }),
    }));
    const rootStep: SelectionListStep = {
        id: 'team-credential-audience',
        inputPlaceholder: t('session.access.search'),
        emptyStateLabel: t('common.noMatches'),
        sections,
    };
    const pendingSource = visibleSources.find((source) => source.status === 'error')
        ?? visibleSources.find((source) => source.hasMore);

    return <SelectionList
        testID="team-credential-audience-picker"
        rootStep={rootStep}
        inputValue={query}
        onChangeInputValue={setQuery}
        listAccessibilityLabel={props.label ?? t('teams.credentials.audience.add')}
        maxHeight={SELECTION_LIST_MODAL_MAX_HEIGHT}
        heightBehavior={resolveSelectionListModalHeightBehavior()}
        keyboardHintsEnabled
        onRequestClose={props.onClose}
        onSelect={() => {}}
        pagination={pendingSource ? {
            hasMore: pendingSource.hasMore,
            loadingMore: pendingSource.loadingMore,
            requestKey: pendingSource.cursor,
            error: pendingSource.error?.message,
            onEndReached: () => directory.loadMore(pendingSource.kind),
            onRetry: () => directory.retry(pendingSource.kind),
            loadingLabel: t('common.loading'),
            moreLabel: t('session.access.browseMore'),
            retryLabel: t('common.retry'),
            endReachedLabel: t('session.access.allLoaded'),
        } : undefined}
    />;
}

export const TeamCredentialAudiencePicker = React.memo(function TeamCredentialAudiencePicker(props: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    excludedGroupIds: readonly string[];
    excludedMemberIds: readonly string[];
    allowedKinds?: readonly TeamCredentialAudiencePrincipalKind[];
    label?: string;
    disabled: boolean;
    onChoose: (principal: TeamCredentialAudiencePrincipal) => void;
    testID: string;
}>) {
    const modalIdRef = React.useRef<string | null>(null);
    const locale = getPreferredLanguage();
    const close = React.useCallback(() => {
        if (!modalIdRef.current) return;
        Modal.hide(modalIdRef.current);
        modalIdRef.current = null;
    }, []);
    const open = React.useCallback(() => {
        if (props.disabled) return;
        close();
        const label = props.label ?? t('teams.credentials.audience.add');
        modalIdRef.current = Modal.show({
            component: PickerContent,
            props: { ...props, allowedKinds: props.allowedKinds ?? ['member', 'group'] },
            chrome: { kind: 'card', title: label, testID: 'team-credential-audience-picker:modal', ...SELECTION_LIST_MODAL_CARD_SCROLL },
            closeOnBackdrop: true,
        });
    }, [close, locale, props]);
    React.useEffect(() => close, [close]);
    const label = props.label ?? t('teams.credentials.audience.add');
    return <Item testID={props.testID} title={label}
        accessibilityLabel={label} disabled={props.disabled} onPress={open} />;
});
