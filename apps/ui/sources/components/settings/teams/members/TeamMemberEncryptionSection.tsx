import * as React from 'react';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import {
    membershipHistoryPreparationScopeKey,
    type MembershipSessionDataKeyEnvelopeTarget,
} from '@/sync/api/teams/membershipSessionDataKeyEnvelopesApi';
import { SessionAccessApiError } from '@/sync/api/session/sessionAccessApi';
import type { TeamMembershipHistoryPreparationResultV1, TeamMembershipHistoryReadinessV1 } from '@happier-dev/protocol/teams/membershipHistoryPreparationV1';
import { getTeamMembershipHistoryReadiness, prepareTeamMembershipHistory } from '@/sync/ops/teams/teamMembershipHistoryOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';

import type { TeamMemberSectionContext } from './teamMemberSectionContext';

/**
 * The member-detail encrypted-access row.
 *
 * It consumes the first page of the one membership-history resource when the detail is opened or
 * refreshed, and derives everything it shows from the Action's safe projection: whether an action
 * exists (`actionable`), why some manageable Sessions are not actionable (`exceptions`), and whether the
 * recipient can receive envelopes at all. There is no second count query, no member mirror, and no
 * summary service — a state this page cannot express is not shown.
 *
 * It also never claims work is happening that is not: the active label exists only while this
 * foreground client is running a pass. Absence of a tuple is pending, never "someone is preparing".
 */

type EncryptedAccess =
    | Readonly<{ kind: 'checking' }>
    | Readonly<{
        kind: 'unavailable';
        reason: 'unsupported' | 'forbidden' | 'not_found' | 'transient';
        retryable: boolean;
    }>
    | Readonly<{ kind: 'setup_required'; reason: 'plain_account' | 'encryption_setup_required' | 'encryption_inconsistent' }>
    | Readonly<{
        kind: 'ready';
        /** Remaining work this person can still start or continue from here. */
        actionable: boolean;
        /**
         * The two server exception buckets, kept apart on purpose.
         *
         * A caller envelope that needs repair is work someone can still finish; a
         * released Account-secret Session is permanently non-transferable under the
         * approved model. Collapsing them into one flag would offer a futile repair
         * instruction for the second, so they stay separate all the way to the copy.
         */
        callerRepairRequired: boolean;
        nonTransferableHistory: boolean;
    }>
    | Readonly<{ kind: 'preparing'; preparedCount: number }>
    /** The membership now resolves to a different Account; the host reloads before retrying. */
    | Readonly<{ kind: 'recipient_changed' }>
    /** The exact Team/Group membership disappeared; the host and resource are rediscovered. */
    | Readonly<{ kind: 'membership_changed' }>
    | Readonly<{ kind: 'failed' }>;

const CHECKING: EncryptedAccess = Object.freeze({ kind: 'checking' as const });
const UNSUPPORTED: EncryptedAccess = Object.freeze({
    kind: 'unavailable' as const,
    reason: 'unsupported' as const,
    retryable: false,
});
const FAILED: EncryptedAccess = Object.freeze({ kind: 'failed' as const });

type TeamMemberRecipientEncryptionPresentation = 'plain_account' | 'setup_required' | 'repair_required';

/** Classify recipient readiness for the member-detail presentation boundary. */
export function classifyTeamMemberRecipientEncryptionState(
    reason: Extract<EncryptedAccess, { kind: 'setup_required' }>['reason'],
): TeamMemberRecipientEncryptionPresentation {
    if (reason === 'plain_account') return 'plain_account';
    if (reason === 'encryption_inconsistent') return 'repair_required';
    return 'setup_required';
}

/**
 * Preserve the boundary's failure class until presentation. Unsupported and denied membership
 * resources are intentionally omitted; a transient Home/network failure stays visible and can be
 * retried from the member detail surface.
 */
export function classifyTeamMemberEncryptionDiscoveryFailure(error: unknown): Extract<EncryptedAccess, { kind: 'unavailable' }> {
    if (error instanceof SessionAccessApiError) {
        if (error.code === 'unsupported_action' || error.code === 'session_access_sharing_unavailable') {
            return { kind: 'unavailable', reason: 'unsupported', retryable: false };
        }
        if (error.status === 403 || error.code === 'session_access_forbidden') {
            return { kind: 'unavailable', reason: 'forbidden', retryable: false };
        }
        if (error.status === 404 || error.code === 'membership_not_found') {
            return { kind: 'unavailable', reason: 'not_found', retryable: false };
        }
    }
    return { kind: 'unavailable', reason: 'transient', retryable: true };
}

/**
 * One discovery page, read as this row's state.
 *
 * `items` and `nextCursor` decide whether an action exists; the two exception counts
 * are the Home's truth about manageable Sessions that are not actionable, and they
 * stay separate because only one of them has a remedy.
 */
export function projectTeamMemberEncryptionReadyState(
    page: Extract<TeamMembershipHistoryReadinessV1, { status: 'ready' }>,
): Extract<EncryptedAccess, { kind: 'ready' }> {
    return {
        kind: 'ready',
        actionable: page.actionable,
        callerRepairRequired: page.exceptions.callerEnvelopeRepairRequiredCount > 0,
        nonTransferableHistory: page.exceptions.callerVisibleNonTransferableSessionCount > 0,
    };
}

/**
 * What a finished membership-history pass means for this row.
 *
 * `recipient_changed` and `scope_changed` are deliberately not settled results: the
 * first has to refresh the canonical membership before anything is retried, and the
 * second has to ask the Home again rather than report state that belongs to material
 * this device no longer holds. Both are expressed as row states the host reacts to,
 * so this stays one decision rather than two.
 */
export function projectTeamMemberPreparationOutcome(
    outcome: TeamMembershipHistoryPreparationResultV1,
): EncryptedAccess {
    if (outcome.status === 'recipient_unavailable' && outcome.recipientUnavailableReason) {
        return { kind: 'setup_required', reason: outcome.recipientUnavailableReason };
    }
    if (outcome.status === 'recipient_changed') return { kind: 'recipient_changed' };
    if (outcome.status === 'membership_changed') return { kind: 'membership_changed' };
    if (outcome.status === 'scope_changed') return CHECKING;
    if (outcome.status === 'complete' || outcome.status === 'incomplete') {
        const server = outcome.exceptions;
        return {
            kind: 'ready',
            // `incomplete` is ordinary remaining work — locally unopenable envelopes,
            // or work found behind the cursor — not a failure state.
            actionable: outcome.status === 'incomplete',
            // A locally empty failure set cannot erase what the Home reported, and a
            // locally unopenable envelope is repair work even when the Home saw none.
            callerRepairRequired: (server?.callerEnvelopeRepairRequiredCount ?? 0) > 0
                || outcome.repairRequiredCount > 0,
            // A Session whose served key did not prove it is that Session's (an older Home, or
            // layout 0 until its owner upgrades it) is history this device cannot share either.
            nonTransferableHistory: (server?.callerVisibleNonTransferableSessionCount ?? 0) > 0
                || outcome.sessionKeyUnprovenCount > 0,
        };
    }
    // An unverifiable recipient binding is the one stable cryptographic failure left:
    // committed pages stay correct, and nothing was sealed to a key the claiming
    // Account did not sign.
    return FAILED;
}

export function TeamMemberEncryptionSection(props: Readonly<{
    context: TeamMemberSectionContext;
    /** Group member detail addresses the same resource by its own public identity. */
    target?: MembershipSessionDataKeyEnvelopeTarget;
    /**
     * Set only when this detail was reached from an add journey that explicitly chose
     * to include existing history. That choice is the instruction, so the first pass
     * starts here instead of asking the administrator to repeat it. It fires at most
     * once per membership and never for a detail opened any other way.
     */
    autoStartPreparation?: boolean;
}>) {
    const { context } = props;
    const availability = useSessionCollaborationAvailability(context.scope.serverId);
    const [state, setState] = React.useState<EncryptedAccess>(CHECKING);
    const [refreshing, setRefreshing] = React.useState(false);
    // One generation guards every async write: a Home, Account or membership change makes an
    // in-flight discovery or pass stale, and a stale result must never repaint this row.
    const generation = React.useRef(0);

    const serverId = context.scope.serverId;
    const accountId = context.scope.accountId;
    const teamId = context.address.teamId;
    const recipientAccountId = context.membership.accountId;
    const membershipId = context.membership.id;
    // The target is rebuilt from its parts inside the memo so that re-rendering the host does not
    // restart discovery: only a genuinely different address does.
    const groupId = props.target?.kind === 'group' ? props.target.teamGroupId : null;
    const groupAccountId = props.target?.kind === 'group' ? props.target.accountId : null;

    const request = React.useMemo(() => ({
        scope: { serverId, accountId },
        address: { serverId, teamId },
        target: (groupId !== null && groupAccountId !== null
            ? { kind: 'group' as const, teamGroupId: groupId, accountId: groupAccountId }
            : { kind: 'team' as const, teamMembershipId: membershipId }),
        recipientAccountId,
        availability,
    }), [serverId, accountId, teamId, groupId, groupAccountId, membershipId, recipientAccountId, availability]);

    const discover = React.useCallback(() => {
        const currentGeneration = (generation.current += 1);
        setRefreshing(true);
        setState((previous) => previous.kind === 'checking' ? CHECKING : previous);
        void (async () => {
            try {
                const page = await getTeamMembershipHistoryReadiness({
                    ...request,
                    isCurrent: () => currentGeneration === generation.current,
                });
                if (currentGeneration !== generation.current) return;
                if (page.status === 'recipient_unavailable') {
                    setState({ kind: 'setup_required', reason: page.reason });
                    return;
                }
                setState(projectTeamMemberEncryptionReadyState(page));
            } catch (error) {
                if (currentGeneration !== generation.current) return;
                // Preserve the boundary's typed distinction: unsupported or denied resources stay
                // omitted, while a transient Home/network failure remains actionable.
                setState(classifyTeamMemberEncryptionDiscoveryFailure(error));
            } finally {
                if (currentGeneration === generation.current) setRefreshing(false);
            }
        })();
    }, [request]);

    React.useEffect(() => {
        if (availability !== 'available') {
            generation.current += 1;
            setRefreshing(false);
            setState(UNSUPPORTED);
            return;
        }
        discover();
        return () => {
            generation.current += 1;
        };
    }, [discover, availability]);

    const prepare = React.useCallback(() => {
        const previousState = state;
        const currentGeneration = (generation.current += 1);
        setRefreshing(false);
        setState({ kind: 'preparing', preparedCount: 0 });
        announceAccessibilityMessage(t('teams.members.encryption.preparing', { prepared: 0 }));
        void (async () => {
            try {
                const settle = (outcome: TeamMembershipHistoryPreparationResultV1) => {
                    if (currentGeneration !== generation.current) return;
                    const settled = projectTeamMemberPreparationOutcome(outcome);
                    if (settled.kind === 'recipient_changed') { setState(settled); context.refresh(); return; }
                    if (settled.kind === 'membership_changed') { context.refresh(); discover(); return; }
                    if (settled.kind === 'checking') { discover(); return; }
                    announceAccessibilityMessage(
                        settled.kind === 'ready'
                            ? settled.actionable || settled.callerRepairRequired
                                ? t('teams.members.encryption.pending') : t('teams.members.encryption.ready')
                            : settled.kind === 'setup_required' ? t('teams.members.encryption.setupRequired') : t('teams.members.encryption.failed'),
                    );
                    setState(settled);
                };
                // Detached on purpose: closing the member sheet stops this row from
                // observing progress, but it does not cancel a pass whose exact
                // Home/Account/membership/recipient scope and encryption generation are
                // still current. The authority guard inside the operation stops the next
                // write when one of those actually changes.
                const outcome = await prepareTeamMembershipHistory({
                    ...request,
                    onProgress: (progress) => {
                        if (currentGeneration !== generation.current) return;
                        setState({ kind: 'preparing', preparedCount: progress.preparedCount });
                    },
                    onApprovalSucceeded: settle,
                    onApprovalFailed: () => { if (currentGeneration === generation.current) setState(FAILED); },
                });
                settle(outcome);
            } catch (cause) {
                if (currentGeneration !== generation.current) return;
                if (isTeamActionApprovalPendingError(cause) && context.requestApproval) {
                    setState(previousState);
                    context.requestApproval(cause.registration);
                    return;
                }
                announceAccessibilityMessage(t('teams.members.encryption.failed'));
                setState(FAILED);
            }
        })();
    }, [context, discover, request, state]);

    // The `all_existing` add journey already made this decision, so the first pass
    // starts on arrival rather than asking for it again. It is gated on real
    // actionable work and on this exact membership, so a rerender, a retry, or an
    // ordinary visit to the same detail never starts another one.
    const autoStarted = React.useRef<string | null>(null);
    const autoStartKey = membershipHistoryPreparationScopeKey(request);
    React.useEffect(() => {
        if (props.autoStartPreparation !== true) return;
        if (autoStarted.current === autoStartKey) return;
        if (state.kind !== 'ready' || !state.actionable || !context.mutationsAvailable) return;
        autoStarted.current = autoStartKey;
        prepare();
    }, [props.autoStartPreparation, autoStartKey, state, context.mutationsAvailable, prepare]);

    if (state.kind === 'unavailable') {
        if (!state.retryable) return null;
        return (
            <ItemGroup
                title={t('teams.members.encryption.title')}
                description={t('teams.unavailable.offline')}
            >
                <Item
                    testID="team-member-encryption-unavailable"
                    title={t('teams.unavailable.offline')}
                    detail={t('common.retry')}
                    loading={refreshing}
                    onPress={discover}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    if (state.kind === 'checking') {
        return (
            <ItemGroup title={t('teams.members.encryption.title')}>
                <Item
                    testID="team-member-encryption-checking"
                    title={t('teams.members.encryption.checking')}
                    loading
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    if (state.kind === 'setup_required') {
        const presentation = classifyTeamMemberRecipientEncryptionState(state.reason);
        const canCheckAgain = presentation !== 'plain_account';
        return (
            <ItemGroup
                title={t('teams.members.encryption.title')}
                description={presentation === 'plain_account'
                    ? t('teams.members.encryption.plainAccount')
                    : presentation === 'setup_required'
                        ? t('teams.members.encryption.setupRequiredBody')
                        : undefined}
            >
                <Item
                    testID="team-member-encryption-setup-required"
                    title={t('teams.members.encryption.title')}
                    loading={refreshing}
                    detail={presentation === 'plain_account'
                        ? t('teams.members.encryption.notEncrypted')
                        : presentation === 'repair_required'
                            ? t('teams.members.encryption.repairRequired')
                            : t('teams.members.encryption.setupRequired')}
                    showChevron={false}
                />
                {canCheckAgain ? (
                    <Item
                        testID="team-member-encryption-check-again"
                        title={t('externalSessions.settingsIntegrationActionCheckAgain')}
                        disabled={refreshing}
                        onPress={discover}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
        );
    }

    if (state.kind === 'preparing') {
        return (
            <ItemGroup title={t('teams.members.encryption.title')}>
                <Item
                    testID="team-member-encryption-preparing"
                    title={t('teams.members.encryption.preparing', { prepared: state.preparedCount })}
                    loading
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    if (state.kind === 'recipient_changed') {
        return (
            <ItemGroup title={t('teams.members.encryption.title')}>
                <Item
                    testID="team-member-encryption-recipient-changed"
                    title={t('teams.members.encryption.recipientChanged')}
                    detail={t('common.retry')}
                    onPress={discover}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    if (state.kind === 'membership_changed') return null;

    if (state.kind === 'failed') {
        return (
            <ItemGroup title={t('teams.members.encryption.title')} description={t('teams.members.encryption.failed')}>
                <Item
                    testID="team-member-encryption-retry"
                    title={t('teams.members.encryption.retry')}
                    loading={refreshing}
                    disabled={!context.mutationsAvailable || refreshing}
                    onPress={prepare}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    // Repairable and permanently non-transferable Sessions get their own sentence.
    // The second offers no instruction on purpose: there is no action that would work.
    const footer = [
        t('teams.members.encryption.scopeBody'),
        state.callerRepairRequired ? t('teams.members.encryption.repairBody') : undefined,
        state.nonTransferableHistory ? t('teams.members.encryption.nonTransferableBody') : undefined,
    ].filter((line): line is string => line !== undefined).join(' ');

    return (
        <ItemGroup
            title={t('teams.members.encryption.title')}
            description={footer.length > 0 ? footer : undefined}
        >
            <Item
                testID="team-member-encryption-status"
                // The section already names encrypted access; the row names whose sessions it covers.
                title={t('teams.members.encryption.rowTitle')}
                loading={refreshing}
                // Ready means every eligible Session was prepared. A caller envelope the
                // Home still reports as needing repair is not that, even when this
                // client's own page finished without a local failure.
                detail={state.actionable
                    ? t('teams.members.encryption.pending')
                    : state.callerRepairRequired
                        ? t('session.access.repair')
                        : t('teams.members.encryption.ready')}
                showChevron={false}
            />
            {state.actionable ? (
                <Item
                    testID="team-member-encryption-prepare"
                    title={t('teams.members.encryption.prepare')}
                    disabled={!context.mutationsAvailable || refreshing}
                    onPress={prepare}
                    showChevron={false}
                />
            ) : null}
        </ItemGroup>
    );
}
