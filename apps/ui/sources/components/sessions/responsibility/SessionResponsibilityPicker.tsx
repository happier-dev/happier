import * as React from 'react';
import { View } from 'react-native';

import type { CustomModalInjectedProps } from '@/modal';
import { Avatar } from '@/components/ui/avatar/Avatar';
import {
    SelectionList,
    SelectionListScreen,
    type SelectionListSectionDescriptor,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

import type { SessionResponsibilityController } from './useSessionResponsibilityController';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { formatSessionResponsibilityName } from './formatSessionResponsibilityName';
import { formatSessionResponsibilityAccessHint } from './formatSessionResponsibilityAccessHint';
import { presentSessionAccessReason } from '@/components/sessions/access/presentSessionAccessFailure';

const NO_ONE_OPTION_ID = 'session-responsibility:none';
const CANDIDATE_PREFIX = 'session-responsibility:account:';

type SessionResponsibilityPickerProps = CustomModalInjectedProps & Readonly<{
    sessionId: string;
    scope: ServerAccountScope;
    /** The acting Account, so "Assign to me" appears only when it is eligible. */
    actingAccountId: string | null;
    /** Shared mounted controller from the canonical Responsibility section. */
    controller: SessionResponsibilityController;
    onResolved: () => void;
    /**
     * Which canonical selection host renders the option model.
     *
     * `anchored` is the wide desktop/web popover step; `screen` is the existing
     * compact/mobile pushed `SelectionListScreen`. Both consume the same option
     * model, search, pagination, selected state, mutation and error owner.
     */
    presentation?: 'anchored' | 'screen';
    testID?: string;
}>;

export function SessionResponsibilityPicker(props: SessionResponsibilityPickerProps): React.ReactElement {
    return <SessionResponsibilityPickerContent {...props} />;
}

function SessionResponsibilityPickerContent(
    props: SessionResponsibilityPickerProps,
): React.ReactElement {
    const controller = props.controller;
    const { theme } = useUnistyles();
    const [query, setQuery] = React.useState('');
    const [pendingChoice, setPendingChoice] = React.useState<string | null | undefined>(undefined);
    const loadCandidates = controller.loadCandidates;
    const editable = controller.availability === 'editable';

    React.useEffect(() => {
        const trimmed = query.trim();
        const handle = setTimeout(() => {
            void loadCandidates(trimmed ? { query: trimmed } : {});
        }, query === '' ? 0 : 180);
        return () => clearTimeout(handle);
    }, [loadCandidates, query]);

    const choose = React.useCallback(async (accountId: string | null) => {
        if (!editable || controller.pending) return;
        setPendingChoice(accountId);
        try {
            const applied = await controller.setResponsibleAccount(accountId);
            if (applied) props.onResolved();
        } finally {
            setPendingChoice(undefined);
        }
    }, [controller, editable, props]);

    // "Assign to me" is a fixed canonical-self option derived from the
    // authenticated Home Account plus current Session-read eligibility. It never
    // waits for, searches, or assumes membership in candidate page one. The
    // server repeats the target check in the mutation transaction.
    // Show it when the actor is eligible and not already assigned; long names
    // truncate visually without truncating the accessible name.
    const showAssignToMe = editable
        && controller.canAssignToSelf
        && typeof props.actingAccountId === 'string'
        && props.actingAccountId.length > 0
        && props.actingAccountId !== controller.responsibleAccountId;

    const sections: SelectionListSectionDescriptor[] = [
        {
            kind: 'static',
            id: 'session-responsibility:quick',
            options: [
                ...(showAssignToMe
                    ? [{
                        id: `${CANDIDATE_PREFIX}${props.actingAccountId}:self`,
                        label: t('session.responsibilityAssignToMe'),
                        accessibilityLabel: t('session.responsibilityAssignToMe'),
                        disabled: controller.pending || !editable,
                        loading: controller.pending && pendingChoice === props.actingAccountId,
                        onSelect: () => { void choose(props.actingAccountId); },
                    }]
                    : []),
                {
                    id: NO_ONE_OPTION_ID,
                    // "No one" is always an explicit clear option for an authorized actor.
                    label: t('session.responsibilityNoOne'),
                    accessibilityLabel: t('session.responsibilityNoOne'),
                    disabled: controller.pending || !editable,
                    loading: controller.pending && pendingChoice === null,
                    onSelect: () => { void choose(null); },
                },
            ],
        },
        {
            kind: 'static',
            id: 'session-responsibility:people',
            title: t('session.responsibilityPeopleWithAccess'),
            options: controller.candidates.candidates.map((candidate) => {
                const hint = formatSessionResponsibilityAccessHint(candidate.accessHint);
                return {
                    id: `${CANDIDATE_PREFIX}${candidate.accountId}`,
                    label: formatSessionResponsibilityName(candidate.profile),
                    ...(candidate.profile.username ? { searchText: candidate.profile.username } : {}),
                    disabled: controller.pending || !editable,
                    loading: controller.pending && pendingChoice === candidate.accountId,
                    icon: () => (
                        <Avatar
                            id={candidate.accountId}
                            size={28}
                            imageUrl={candidate.profile.avatarUrl}
                        />
                    ),
                    ...(hint ? { rightAccessory: () => (
                        <Text style={{ color: theme.colors.text.secondary, ...Typography.variant('body'),  }}>
                            {hint}
                        </Text>
                    ) } : {}),
                    onSelect: () => { void choose(candidate.accountId); },
                };
            }),
            ...(controller.candidates.candidates.length === 0 && !controller.candidates.loading
                ? { resultHint: t('session.responsibilityNoCandidates') }
                : {}),
        },
    ];

    const rootStep: SelectionListStep = {
        id: 'root',
        title: t('session.responsibilityPickerTitle'),
        inputPlaceholder: t('session.responsibilitySearchPlaceholder'),
        sections,
    };

    // Continuation is the candidate owner's opaque cursor; the list owns the footer.
    // Page-two and exact-Home scoping are preserved: the cursor is opaque and the
    // controller guards stale scope responses, so a second page never leaks
    // another Home's candidates.
    const nextCursor = controller.candidates.nextCursor;
    const loadMore = React.useCallback(() => {
        if (!nextCursor) return;
        const trimmed = query.trim();
        void loadCandidates({ ...(trimmed ? { query: trimmed } : {}), cursor: nextCursor });
    }, [loadCandidates, nextCursor, query]);
    const retryCandidates = React.useCallback(() => {
        const trimmed = query.trim();
        void loadCandidates({
            ...(trimmed ? { query: trimmed } : {}),
            ...(nextCursor ? { cursor: nextCursor } : {}),
        });
    }, [loadCandidates, nextCursor, query]);

    // Capability loss while open clears private candidate data and becomes
    // read-only with a localized "Access changed" result. Loading, empty,
    // stale, unavailable and page-continuation states preserve stable
    // focus/scroll; clearing or success restores focus to the invoker via the
    // pane capture/return owner.
    const capabilityLost = !editable;
    const failureMessage = controller.failure === 'session_access_authentication_required'
        || controller.failure === 'session_access_authentication_unavailable'
        ? presentSessionAccessReason(controller.failure).message
        // A deferred approval is not a failure: nothing was refused and nothing
        // committed, so the row says what is waiting rather than "try again".
        : controller.failure === 'approval-pending'
            ? t('session.responsibilityApprovalPending')
        : capabilityLost || controller.failure === 'assignee-unavailable' || controller.failure === 'forbidden'
            ? t('session.responsibilityAccessChanged')
            : controller.failure
                ? t('session.responsibilityUpdateFailed')
                : null;

    // One option model, search, pagination, selection and error owner for both
    // responsive hosts: the wide anchored step and the compact pushed screen
    // differ only in which existing SelectionList host supplies the viewport.
    const listProps = {
        rootStep,
        listAccessibilityLabel: t('session.responsibilityPickerTitle'),
        selectedOptionId: controller.responsibleAccountId
            ? `${CANDIDATE_PREFIX}${controller.responsibleAccountId}`
            : NO_ONE_OPTION_ID,
        inputValue: query,
        onChangeInputValue: setQuery,
        onSelect: () => {},
        onRequestClose: props.onClose,
        pagination: {
            hasMore: nextCursor !== null,
            // The footer is also the initial-load recovery owner. Reporting the
            // empty initial retry as loading re-arms SelectionList's request-key
            // guard if that request fails again, while a retained continuation
            // cursor keeps retrying the exact failed page.
            loadingMore: controller.candidates.loading,
            requestKey: nextCursor ?? `initial:${query.trim()}`,
            error: controller.candidates.failed ? t('session.responsibilityUpdateFailed') : null,
            onEndReached: loadMore,
            onRetry: retryCandidates,
            loadingLabel: t('common.loading'),
            moreLabel: t('session.responsibilityPeopleWithAccess'),
            retryLabel: t('common.retry'),
            endReachedLabel: t('session.responsibilityPeopleWithAccess'),
        },
    } as const;

    // The list keeps one stable identity across both hosts so callers, tests and
    // accessibility tooling do not have to know which one is presenting it.
    const baseTestID = props.testID ?? 'session-responsibility-picker';
    const screenPresentation = props.presentation === 'screen';

    return (
        <View
            testID={screenPresentation ? `${baseTestID}-screen` : baseTestID}
            style={{ flex: 1, minHeight: 0 }}
        >
            {failureMessage ? (
                <Text
                    testID="session-responsibility-picker-error"
                    accessibilityRole="alert"
                    style={{
                        color: theme.colors.state.warning.textForeground,
                        fontSize: 14,
                        paddingHorizontal: theme.space.s16,
                        paddingBottom: theme.space.s8,
                        ...Typography.default(),
                    }}
                >
                    {failureMessage}
                </Text>
            ) : null}
            {screenPresentation ? (
                <SelectionListScreen testID={baseTestID} {...listProps} />
            ) : (
                <SelectionList testID={`${baseTestID}.list`} {...listProps} />
            )}
        </View>
    );
}
