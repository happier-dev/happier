import * as React from 'react';
import type {
    SessionHistoryAccessV1,
    TeamInvitationAdmissibleRoleV1,
    TeamInvitationCreateResultV1,
} from '@happier-dev/protocol/teams';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { useTeamInvitations } from '@/hooks/teams/useTeamInvitations';
import { randomUUID } from '@/platform/randomUUID';
import {
    createTeamInvitation,
    reissueTeamInvitation,
} from '@/sync/ops/teams/teamInvitationOperations';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';
import { teamRoleLabel } from '../teamLabels';
import { teamMutationFailureLabel } from '../teamMutationPresentation';
import { TeamLinkDelivery } from '../TeamLinkDelivery';

const ADMISSIBLE_ROLES: readonly TeamInvitationAdmissibleRoleV1[] = Object.freeze([
    'admin',
    'member',
    'guest',
]);

type Delivery = 'link' | 'email';

/**
 * The one invitation form: delivery, role, history access and the confined bearer. The Team's own
 * invitation page and the Home console's Invite people dialog both render it.
 */
export const TeamInvitationForm = React.memo(function TeamInvitationForm(props: Readonly<{ context: TeamSectionContext }>) {
    const { context } = props;
    const [delivery, setDelivery] = React.useState<Delivery>('link');
    const [email, setEmail] = React.useState('');
    const [role, setRole] = React.useState<TeamInvitationAdmissibleRoleV1>('member');
    const [historyAccess, setHistoryAccess] = React.useState<SessionHistoryAccessV1>(
        context.team.policy.defaultSessionHistoryAccess,
    );
    const [submitting, setSubmitting] = React.useState(false);
    const [retryingDelivery, setRetryingDelivery] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    /**
     * The one confined delivery of the raw bearer. It lives in this screen's
     * memory only: it is never persisted, never placed in a snapshot, and cannot
     * be recovered from the invitation list afterwards.
     */
    const [issued, setIssued] = React.useState<TeamInvitationCreateResultV1 | null>(null);

    /**
     * Whether this Home can currently mail an invitation at all.
     *
     * It is the Home's answer, carried on the invitation page — this device
     * cannot tell from its own origin whether a mail boundary exists or whether
     * the Home can render the link that mail must contain. The sheet renders no
     * rows, so it asks for the smallest page the Home will answer with.
     */
    const canManageInvitations = context.team.capabilities.manageInvitations;
    const { emailDelivery, linkDelivery } = useTeamInvitations({
        scope: context.scope,
        address: context.address,
        state: null,
        enabled: canManageInvitations,
        limit: 1,
    });
    // Until the Home has answered, Email is not offered. Offering it optimistically
    // would put a manager in a form whose submission the Home is going to refuse.
    const emailAvailable = emailDelivery === 'available';
    /**
     * This Home has published no join target, so it can render no shareable
     * link — and therefore no mail either. This is the one state in which a
     * created invitation has no way to reach anyone, so both halves of the
     * sheet say that rather than offering a link to share or to reissue.
     */
    const linkUnavailable = linkDelivery === 'unavailable';
    /**
     * The Home's answer outranks a stale local selection. If mail stops being
     * possible while this sheet is open, the sheet falls back to the link rather
     * than keeping a hidden email intent that would be submitted and refused.
     */
    const effectiveDelivery: Delivery = emailAvailable ? delivery : 'link';

    /**
     * This form's mount lifetime, and the whole custody of a bearer it asks for.
     *
     * Creation and reissue are live-only: an explicit UI approval keeps the
     * invocation pending through the shared blocking waiter and the raw link
     * comes back to *this* call and nowhere else, because the durable Artifact
     * keeps only the safe projection. So the request is bound to this mount —
     * TeamSection remounts this form when the Home, Account or Team changes, so
     * that switch cancels the wait instead of letting an answer arrive for a
     * Team the person is no longer looking at. A cancelled wait cannot be
     * recovered, and this screen never pretends otherwise: reissue is the only
     * honest way back to a link.
     */
    const bearerLifetime = React.useRef<AbortController>(new AbortController());
    React.useEffect(() => {
        const lifetime = bearerLifetime.current;
        return () => lifetime.abort();
    }, []);

    // One retry identity per submission; a lost response must not mint a second
    // live bearer for the same intent.
    const requestKey = React.useRef(randomUUID());
    const submitInFlightRef = React.useRef(false);
    const deliveryRetryInFlightRef = React.useRef(false);
    const deliveryRetryIdentity = React.useRef<Readonly<{
        invitationId: string;
        requestKey: string;
    }> | null>(null);
    React.useEffect(() => {
        requestKey.current = randomUUID();
    }, [delivery, email, role, historyAccess]);

    const historyChoiceAvailable = context.team.admission.historyChoice[role] === 'choice';
    const trimmedEmail = email.trim();
    const canSubmit = !submitting
        && context.canMutate
        && (effectiveDelivery === 'link' || trimmedEmail.length >= 3);

    const submit = React.useCallback(async () => {
        if (submitInFlightRef.current) return;
        submitInFlightRef.current = true;
        setSubmitting(true);
        setError(null);
        let outcome: Awaited<ReturnType<typeof createTeamInvitation>>;
        try {
            outcome = await createTeamInvitation({
                scope: context.scope,
                address: context.address,
                role,
                historyAccess: historyChoiceAvailable ? historyAccess : 'from_membership',
                recipientEmail: effectiveDelivery === 'email' ? trimmedEmail : null,
                requestKey: requestKey.current,
                // An explicit UI approval keeps this exact call pending rather
                // than handing custody to anything durable, so the button stays
                // busy for as long as the person is being asked — and the link,
                // when it comes, comes back here.
                signal: bearerLifetime.current.signal,
            });
        } catch {
            submitInFlightRef.current = false;
            if (bearerLifetime.current.signal.aborted) return;
            setError(t('teams.errors.generic'));
            setSubmitting(false);
            return;
        }
        submitInFlightRef.current = false;
        setSubmitting(false);
        if (outcome.kind === 'succeeded') {
            setIssued(outcome.value);
            return;
        }
        // One failure vocabulary, shared with every other Team mutation. An
        // operation this Home does not have is an update fact about the Home,
        // never relabelled as a mail-delivery problem, and an answer that was
        // lost says so rather than claiming no invitation exists.
        setError(teamMutationFailureLabel(outcome.failure));
    }, [context, role, historyAccess, historyChoiceAvailable, effectiveDelivery, trimmedEmail]);

    const reissueIssuedInvitation = React.useCallback(async () => {
        if (!issued || deliveryRetryInFlightRef.current) return;
        deliveryRetryInFlightRef.current = true;

        const retryIdentity = deliveryRetryIdentity.current?.invitationId === issued.invitation.id
            ? deliveryRetryIdentity.current
            : Object.freeze({ invitationId: issued.invitation.id, requestKey: randomUUID() });
        deliveryRetryIdentity.current = retryIdentity;

        setRetryingDelivery(true);
        setError(null);
        let outcome: Awaited<ReturnType<typeof reissueTeamInvitation>>;
        try {
            outcome = await reissueTeamInvitation({
                scope: context.scope,
                address: context.address,
                invitationId: retryIdentity.invitationId,
                // Null means preserve the exact stored recipient, including no
                // recipient for a transferable link. The Home revokes the
                // inaccessible bearer and creates its replacement atomically.
                recipientEmail: null,
                requestKey: retryIdentity.requestKey,
                // Live-only custody, exactly as creation: the replacement link
                // returns to this pending call and is never recoverable from
                // anywhere else.
                signal: bearerLifetime.current.signal,
            });
        } catch {
            deliveryRetryInFlightRef.current = false;
            if (bearerLifetime.current.signal.aborted) return;
            setError(t('teams.errors.generic'));
            setRetryingDelivery(false);
            return;
        }
        deliveryRetryInFlightRef.current = false;
        setRetryingDelivery(false);
        if (outcome.kind === 'succeeded') {
            deliveryRetryIdentity.current = null;
            setIssued({ invitation: outcome.value.replacement, joinUrl: outcome.value.joinUrl });
            return;
        }
        // One failure vocabulary, shared with every other Team mutation. An
        // operation this Home does not have is an update fact about the Home,
        // never relabelled as a mail-delivery problem, and an answer that was
        // lost says so rather than claiming no invitation exists.
        setError(teamMutationFailureLabel(outcome.failure));
    }, [context, issued]);

    if (!canManageInvitations) {
        return (
            <ItemGroup>
                <SurfaceStateCard
                    testID="team-invite-forbidden"
                    kind="denied"
                    size="line"
                    title={t('teams.denied.title')}
                />
            </ItemGroup>
        );
    }

    if (issued) {
        const joinUrl = issued.joinUrl;
        const deliveryResult = issued.invitation.lastEmailDelivery;
        const emailBound = issued.invitation.recipientEmailMask !== null;
        const canRetryEmail = emailBound && deliveryResult?.status !== 'sent';
        return (
            <>
                {/* The bearer's fate is reported from the Home's own facts. A
                    missing link is not proof of a delivered email: it also
                    happens for an egress-restricted caller, and a mailed
                    invitation can have failed at the mail boundary. */}
                {deliveryResult !== null || canRetryEmail ? (
                    <AttentionBanner
                        testID={deliveryResult?.status === 'sent'
                            ? 'team-invite-delivery-sent'
                            : 'team-invite-delivery-failed'}
                        tone={deliveryResult?.status === 'sent' ? 'neutral' : 'warning'}
                        title={deliveryResult?.status === 'sent'
                            ? t('teams.invitations.deliverySent')
                            : t('teams.invitations.deliveryFailed')}
                        description={error ?? undefined}
                        action={canRetryEmail ? {
                            label: t('teams.invitations.deliveryRetry'),
                            onPress: () => void reissueIssuedInvitation(),
                            loading: retryingDelivery,
                            disabled: !context.canMutate || retryingDelivery,
                            testID: 'team-invite-retry-delivery',
                        } : null}
                    />
                ) : null}

                {joinUrl === null && !emailBound && linkUnavailable ? (
                    <ItemGroup description={error ?? t('teams.invitations.linkUnavailableBody')}>
                        <Item
                            testID="team-invite-link-unavailable"
                            title={t('teams.invitations.linkUnavailableRow')}
                            mode="info"
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : joinUrl === null && !emailBound ? (
                    <ItemGroup description={error ?? t('teams.invitations.bearerUnavailable')}>
                        <Item
                            testID="team-invite-bearer-unavailable"
                            title={deliveryResult === null
                                ? t('teams.invitations.deliveryUnknown')
                                : t('teams.invitations.linkRow')}
                            showChevron={false}
                        />
                        {/* The bearer is not stored, so there is nothing to copy.
                            Reissue atomically retires it before handing over a
                            replacement; a second create would leave two live
                            invitations for one manager intent. */}
                        <Item
                            testID="team-invite-create-new-link"
                            title={t('teams.invitations.reissue')}
                            loading={retryingDelivery}
                            disabled={!context.canMutate || retryingDelivery}
                            onPress={() => void reissueIssuedInvitation()}
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : joinUrl !== null ? (
                    <TeamLinkDelivery
                        url={joinUrl}
                        testIDPrefix="team-invite"
                        title={t('teams.invitations.linkRow')}
                        copyLabel={t('teams.invitations.copyLink')}
                        shareLabel={t('teams.invitations.shareLink')}
                        qrAccessibilityLabel={t('teams.invitations.qrLabel')}
                        description={t('teams.invitations.linkNotice', {
                            team: context.team.name,
                            role: teamRoleLabel(role),
                        })}
                    />
                ) : null}
            </>
        );
    }

    return (
        <>
            {/* With no mail boundary there is only one way to invite, and a
                chooser with a single option is noise. The transferable link
                stays fully usable either way — email is the part that becomes
                unavailable, never the invitation. */}
            {emailAvailable ? (
                <ItemGroup
                    title={t('teams.invitations.inviteTitle', { team: context.team.name })}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t('teams.invitations.inviteTitle', { team: context.team.name })}
                >
                    <Item
                        testID="team-invite-delivery:link"
                        title={t('teams.invitations.byLink')}
                        selected={delivery === 'link'}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={delivery === 'link'}
                        onPress={() => setDelivery('link')}
                        showChevron={false}
                    />
                    <Item
                        testID="team-invite-delivery:email"
                        title={t('teams.invitations.byEmail')}
                        selected={delivery === 'email'}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={delivery === 'email'}
                        onPress={() => setDelivery('email')}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : linkUnavailable ? (
                // No join target means no link and no mail: the sheet says the
                // invitation will exist but has no way to reach anyone yet,
                // instead of promising a link this Home cannot render.
                <ItemGroup
                    title={t('teams.invitations.inviteTitle', { team: context.team.name })}
                    description={t('teams.invitations.linkUnavailableBody')}
                >
                    <Item
                        testID="team-invite-link-unavailable-notice"
                        title={t('teams.invitations.linkUnavailableRow')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : emailDelivery === 'unavailable' ? (
                // The Home answered that it cannot mail an invitation. Silently
                // dropping the option would leave a manager looking for it, so
                // the sheet says the link is the way and why.
                <ItemGroup
                    title={t('teams.invitations.inviteTitle', { team: context.team.name })}
                    description={t('teams.invitations.emailUnavailable')}
                >
                    <Item
                        testID="team-invite-delivery-link-only"
                        title={t('teams.invitations.byLink')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {effectiveDelivery === 'email' ? (
                <ItemGroup>
                    <Item
                        title={t('teams.invitations.emailLabel')}
                        accessoryLayout="adaptive"
                        showChevron={false}
                        rightElement={(
                            <FieldTextInput
                                testID="team-invite-email"
                                value={email}
                                onChangeText={setEmail}
                                placeholder={t('teams.invitations.emailPlaceholder')}
                                accessibilityLabel={t('teams.invitations.emailLabel')}
                                keyboardType="email-address"
                                autoCapitalize="none"
                                autoFocus
                            />
                        )}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup
                title={t('teams.members.roleLabel')}
                description={role === 'guest'
                    ? t('teams.roleHelp.guest')
                    : role === 'admin'
                        ? t('teams.roleHelp.admin')
                        : t('teams.roleHelp.member')}
                accessibilityRole="radiogroup"
                accessibilityLabel={t('teams.members.roleLabel')}
            >
                {ADMISSIBLE_ROLES.map((candidate) => (
                    <Item
                        key={candidate}
                        testID={`team-invite-role:${candidate}`}
                        title={teamRoleLabel(candidate)}
                        selected={candidate === role}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={candidate === role}
                        onPress={() => setRole(candidate)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {/* A guest never receives Team-principal access, so the server
                withholds the history choice for it rather than promising access
                the role does not carry. */}
            {historyChoiceAvailable ? (
                <ItemGroup
                    title={t('teams.history.label')}
                    description={t('teams.history.scopeNote')}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t('teams.history.label')}
                >
                    <Item
                        testID="team-invite-history:from_membership"
                        title={t('teams.history.fromMembership')}
                        selected={historyAccess === 'from_membership'}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={historyAccess === 'from_membership'}
                        onPress={() => setHistoryAccess('from_membership')}
                        showChevron={false}
                    />
                    <Item
                        testID="team-invite-history:all_existing"
                        title={t('teams.history.allExisting')}
                        selected={historyAccess === 'all_existing'}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={historyAccess === 'all_existing'}
                        onPress={() => setHistoryAccess('all_existing')}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup surface="none">
                <SectionButtonRow
                    footnote={error ?? (effectiveDelivery === 'link'
                        ? t('teams.invitations.linkNotice', {
                            team: context.team.name,
                            role: teamRoleLabel(role),
                        })
                        : null)}
                    footnoteTone={error ? 'danger' : 'secondary'}
                >
                    <RoundButton
                        testID="team-invite-submit"
                        size="small"
                        title={t('teams.invitations.create')}
                        loading={submitting}
                        disabled={!canSubmit}
                        onPress={() => void submit()}
                    />
                </SectionButtonRow>
            </ItemGroup>
        </>
    );
});
