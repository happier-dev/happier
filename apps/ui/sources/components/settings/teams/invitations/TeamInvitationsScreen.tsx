import * as React from 'react';
import { useFocusEffect } from '@/components/appShell/workspace/destinationRoute';
import type {
    TeamInvitationReissueResultV1,
    TeamInvitationRowV1,
} from '@happier-dev/protocol/teams';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { useTeamInvitations } from '@/hooks/teams/useTeamInvitations';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import {
    reissueTeamInvitation,
    revokeTeamInvitation,
} from '@/sync/ops/teams/teamInvitationOperations';
import { isTeamActionApprovalPendingError } from '@/sync/ops/teams/teamActionClient';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamMutationFailureLabel, teamReadFailureLabel } from '../teamMutationPresentation';
import { presentHomeInvitePeople } from '@/components/settings/home/governance/HomeInvitePeopleDialog';
import { TeamLinkDelivery } from '../TeamLinkDelivery';
import { partitionTeamInvitations, resolveTeamInvitationPresentation } from './teamInvitationPresentation';

const INVITATION_CHUNK_SIZE = 12;
// JavaScript timers accept a signed 32-bit millisecond delay. A far-future
// invitation is still a valid row; wake in platform-sized chunks rather than
// overflowing the timer (which would fire immediately and spin).
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type InvitationVirtualizedSegment = Readonly<{
    key: string;
    group: 'waiting' | 'finished';
    items: readonly TeamInvitationRowV1[];
    first: boolean;
    last: boolean;
}>;

const InvitationsList = React.memo(function InvitationsList(props: Readonly<{
    context: TeamSectionContext;
    header?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const { context } = props;
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState<string | null>(null);
    /**
     * The bearer produced by a reissue, held only in this screen's memory for
     * the one moment the manager can copy it. It is never persisted, never
     * written to a snapshot, and never read back from a listed row.
     */
    const [freshJoinUrl, setFreshJoinUrl] = React.useState<string | null>(null);
    const reissueRequestIdentity = React.useRef<Readonly<{
        intent: string;
        requestKey: string;
    }> | null>(null);
    const rowActionInFlightRef = React.useRef(false);

    const canManage = context.team.capabilities.manageInvitations;
    const invitations = useTeamInvitations({
        scope: context.scope,
        address: context.address,
        state: null,
        enabled: canManage,
    });
    const hasFocused = React.useRef(false);

    useFocusEffect(React.useCallback(() => {
        if (!hasFocused.current) {
            hasFocused.current = true;
            return;
        }
        void invitations.reload();
    }, [invitations.reload]));

    const publishNotice = React.useCallback((message: string) => {
        setNotice(message);
        announceAccessibilityMessage(message);
    }, []);

    /**
     * This list's mount lifetime, and the whole custody of a reissued bearer.
     *
     * Reissue is live-only: an explicit UI approval keeps the invocation
     * pending through the shared blocking waiter and the replacement link
     * returns to that call alone, because the durable Artifact keeps only the
     * safe projection. Binding the request to this mount is what stops an
     * answer arriving for a Team the person has already left — and a cancelled
     * wait is simply gone, so the only honest offer afterwards is to reissue
     * again.
     */
    const bearerLifetime = React.useRef<AbortController>(new AbortController());
    React.useEffect(() => {
        const lifetime = bearerLifetime.current;
        return () => lifetime.abort();
    }, []);

    /** Presents the replacement this exact live invocation answered with. */
    const settleReissue = React.useCallback((value: TeamInvitationReissueResultV1) => {
        reissueRequestIdentity.current = null;
        // `null` means the bearer went only to the mail boundary — not a failure.
        setFreshJoinUrl(value.joinUrl);
        if (value.joinUrl === null) {
            const delivery = value.replacement.lastEmailDelivery;
            publishNotice(delivery?.status === 'sent'
                ? t('teams.invitations.deliverySent')
                : delivery?.status === 'failed'
                    ? t('teams.invitations.deliveryFailed')
                    : t('teams.invitations.deliveryUnknown'));
        } else {
            announceAccessibilityMessage(t('teams.invitations.reissueNotice'));
        }
        void invitations.reload();
    }, [invitations.reload, publishNotice]);

    // One shared clock value keeps every row in a render consistent. The
    // nearest expiry wakes this surface once; there is no polling loop or
    // per-row timer, and the invitation owner remains authoritative.
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        const nextExpiry = invitations.rows
            .filter((row) => row.state === 'active' && row.expiresAt > now)
            .map((row) => row.expiresAt)
            .sort((left, right) => left - right)[0];
        if (nextExpiry === undefined) return;
        const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextExpiry - now + 1));
        const timer = setTimeout(() => setNow(Date.now()), delay);
        // Node's test/runtime timer exposes `unref`; using it keeps this
        // best-effort UI wake from holding a process open while preserving the
        // normal browser/native timer behavior.
        (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
        return () => clearTimeout(timer);
    }, [invitations.rows, now]);

    // Waiting first, then finished (lab `tsInvites-A`): the two questions a manager asks of this
    // list. Each group is its own titled section, chunked for the virtualized list.
    const invitationSegments = React.useMemo<readonly InvitationVirtualizedSegment[]>(() => {
        const { waiting, finished } = partitionTeamInvitations(invitations.rows, now);
        const segments: InvitationVirtualizedSegment[] = [];
        const addGroup = (group: InvitationVirtualizedSegment['group'], rows: readonly TeamInvitationRowV1[]) => {
            for (let start = 0; start < rows.length; start += INVITATION_CHUNK_SIZE) {
                const items = rows.slice(start, start + INVITATION_CHUNK_SIZE);
                segments.push({
                    key: `${group}:${items[0]!.id}`,
                    group,
                    items,
                    first: start === 0,
                    last: start + INVITATION_CHUNK_SIZE >= rows.length,
                });
            }
        };
        addGroup('waiting', waiting);
        addGroup('finished', finished);
        return segments;
    }, [invitations.rows, now]);

    /** What may be done to one row right now: the row's own answer, and this page's readiness. */
    const rowActions = (row: TeamInvitationRowV1) => {
        const presentation = resolveTeamInvitationPresentation(row, now);
        const canRevoke = presentation.canRevoke && context.canMutate;
        const canReissue = presentation.reissueMode !== 'none'
            && context.canMutate
            && (presentation.reissueMode !== 'email'
                || invitations.emailDelivery === 'available');
        const canChangeEmail = presentation.reissueMode === 'email'
            && context.canMutate
            && invitations.emailDelivery === 'available';
        return { presentation, canRevoke, canReissue, canChangeEmail, isActionable: canRevoke || canReissue };
    };

    /** Runs one row's action: the chooser a press opens, or the retry "Send again" asks for directly. */
    const act = async (row: TeamInvitationRowV1, preset: 'retry' | null) => {
        const { presentation, canRevoke, canReissue, canChangeEmail } = rowActions(row);
        if (rowActionInFlightRef.current) return;
        rowActionInFlightRef.current = true;
        try {
            // One press offers the actions this row
            // actually has, as explicit choices. The
            // chooser's body describes reissuing
            // whenever reissue is offered, so the one
            // irreversible choice states its own
            // consequence in its own confirmation
            // below — the same two step the Team logo
            // and member removals already use. "Send again" on an undelivered email is
            // that same retry, asked for directly.
            // Widened on purpose: the chooser's callbacks assign it, which control flow cannot see.
            let chosen = preset as 'revoke' | 'retry' | 'change_email' | null;
            if (chosen === null) {
                await Modal.alertAsync(
                    presentation.recipientLabel ?? t('teams.invitations.linkRow'),
                    canReissue ? t('teams.invitations.reissueNotice') : t('teams.invitations.revokeBody'),
                    [
                        ...(canReissue ? [{
                            text: t('teams.invitations.reissue'),
                            onPress: () => { chosen = 'retry'; },
                        }] : []),
                        ...(canChangeEmail ? [{
                            text: t('teams.invitations.deliveryChangeEmail'),
                            onPress: () => { chosen = 'change_email'; },
                        }] : []),
                        ...(canRevoke ? [{
                            text: t('teams.invitations.revoke'),
                            style: 'destructive' as const,
                            onPress: () => { chosen = 'revoke'; },
                        }] : []),
                        { text: t('common.cancel'), style: 'cancel' as const },
                    ],
                );
            }
            if (chosen === null) return;

            if (chosen === 'revoke' && !await Modal.confirm(
                t('teams.invitations.revokeTitle'),
                t('teams.invitations.revokeBody'),
                { confirmText: t('teams.invitations.revoke'), destructive: true },
            )) return;

            setBusy(true);
            setNotice(null);
            if (chosen === 'revoke') {
                let outcome: Awaited<ReturnType<typeof revokeTeamInvitation>>;
                try {
                    outcome = await revokeTeamInvitation({
                        scope: context.scope,
                        address: context.address,
                        invitationId: row.id,
                        // An approved revocation is the
                        // same revocation, so it is
                        // reported and re-read here
                        // rather than left unmentioned.
                        onApprovalSucceeded: () => {
                            publishNotice(t('teams.invitations.stateRevoked'));
                            void invitations.reload();
                        },
                        onApprovalFailed: () =>
                            publishNotice(t('teams.errors.generic')),
                    });
                } catch (cause) {
                    setBusy(false);
                    if (isTeamActionApprovalPendingError(cause)) {
                        context.requestApproval(cause.registration);
                    } else {
                        publishNotice(t('teams.errors.generic'));
                    }
                    return;
                }
                setBusy(false);
                if (outcome.kind === 'failed') {
                    // A revoke whose answer was lost may
                    // have taken effect. The shared
                    // vocabulary says so; the reload
                    // below shows what the Home holds.
                    publishNotice(teamMutationFailureLabel(outcome.failure));
                } else {
                    publishNotice(t('teams.invitations.stateRevoked'));
                }
                void invitations.reload();
                return;
            }

            // Retry sends `null`, which the Home reads as
            // "the same offer to the same person": it
            // preserves an existing recipient constraint
            // rather than widening it into a link. Only
            // Change email supplies a new address, so
            // the mask never has to be reproduced here.
            let recipientEmail: string | null = null;
            if (chosen === 'change_email') {
                const entered = await Modal.prompt(
                    t('teams.invitations.deliveryChangeEmail'),
                    t('teams.invitations.reissueNotice'),
                    {
                        placeholder: t('teams.invitations.emailPlaceholder'),
                        confirmText: t('teams.invitations.reissue'),
                        inputType: 'email-address',
                    },
                );
                const trimmed = entered?.trim() ?? '';
                if (trimmed.length < 3) {
                    setBusy(false);
                    return;
                }
                recipientEmail = trimmed;
            }

            let outcome: Awaited<ReturnType<typeof reissueTeamInvitation>>;
            const reissueIntent = JSON.stringify([
                row.id,
                chosen,
                recipientEmail,
            ]);
            const retryIdentity = reissueRequestIdentity.current?.intent === reissueIntent
                ? reissueRequestIdentity.current
                : Object.freeze({ intent: reissueIntent, requestKey: randomUUID() });
            reissueRequestIdentity.current = retryIdentity;
            try {
                outcome = await reissueTeamInvitation({
                    scope: context.scope,
                    address: context.address,
                    invitationId: row.id,
                    recipientEmail,
                    requestKey: retryIdentity.requestKey,
                    // Live-only custody: an explicit
                    // UI approval keeps this call
                    // pending and the replacement link
                    // returns here, never to anything
                    // durable.
                    signal: bearerLifetime.current.signal,
                });
            } catch {
                if (bearerLifetime.current.signal.aborted) return;
                setBusy(false);
                publishNotice(t('teams.errors.generic'));
                return;
            }
            setBusy(false);
            if (outcome.kind === 'failed') {
                publishNotice(teamMutationFailureLabel(outcome.failure));
                void invitations.reload();
            } else {
                settleReissue(outcome.value);
            }
        } finally {
            rowActionInFlightRef.current = false;
        }
    };

    // Adding happens in the collection: the Invitations section carries its "+", which opens the
    // one Invite people dialog with this Team chosen — the same invitation the Team's Overview and
    // Members "+" open (DR-06), so there is one way to invite rather than one per page.
    const inviteAction = canManage && context.canMutate ? (
        <SectionActionButton
            testID="team-invitations-create"
            icon="plus"
            title={t('teams.invitations.invite')}
            onPress={() => presentHomeInvitePeople({
                serverId: context.address.serverId,
                teamId: context.address.teamId,
            })}
        />
    ) : undefined;

    const date = (at: number) => formatWithCachedDateTimeFormatter(new Date(at), getPreferredLanguage(), { dateStyle: 'medium' });
    const firstSegmentKey = invitationSegments[0]?.key ?? null;

    return (
        <VirtualizedList
            testID="team-invitations-virtualized-list"
            data={canManage ? invitationSegments : []}
            keyExtractor={(segment) => segment.key}
            ListHeaderComponent={(
                <>
                    {props.header}
                    {!canManage ? (
                        <ItemGroup>
                            <SurfaceStateCard
                                testID="team-invitations-forbidden"
                                kind="denied"
                                size="line"
                                title={t('teams.denied.title')}
                            />
                        </ItemGroup>
                    ) : null}
                    {/* A reissued bearer is handed over exactly the way a freshly created
                        one is. Offering only Copy here would mean the same secret is
                        deliverable by QR on one screen and not on the other, for no
                        reason a manager could discover. */}
                    {canManage && freshJoinUrl ? (
                        <TeamLinkDelivery
                            url={freshJoinUrl}
                            testIDPrefix="team-invitations-fresh"
                            title={t('teams.invitations.linkRow')}
                            copyLabel={t('teams.invitations.copyLink')}
                            shareLabel={t('teams.invitations.shareLink')}
                            qrAccessibilityLabel={t('teams.invitations.qrLabel')}
                            description={t('teams.invitations.reissueNotice')}
                        />
                    ) : null}
                    {/* The list's known first section holds its rows while the first page is read. */}
                    {canManage && invitations.status === 'loading' && invitations.rows.length === 0 ? (
                        <ItemGroup title={t('teams.invitations.waitingSection')} action={inviteAction}>
                            <ItemLoadStateRows
                                testID="team-invitations-loading"
                                state={{ kind: 'loading' }}
                                rows={3}
                                accessibilityLabel={t('teams.loading')}
                            />
                        </ItemGroup>
                    ) : null}
                    {/* Nothing yet (lab `tsInvites-E`): what an invitation is for, the other way
                        in, and the one action that starts. */}
                    {canManage && invitations.rows.length === 0 && invitations.status === 'ready' ? (
                        <SurfaceStateCard
                            testID="team-invitations-empty"
                            kind="empty"
                            iconName="envelope"
                            title={t('teams.invitations.emptyTitle')}
                            reason={t('teams.invitations.emptyBody')}
                            action={context.canMutate ? {
                                label: t('homeGovernance.invite.action'),
                                testID: 'team-invitations-create',
                                onPress: () => presentHomeInvitePeople({
                                    serverId: context.address.serverId,
                                    teamId: context.address.teamId,
                                }),
                            } : undefined}
                        />
                    ) : null}
                </>
            )}
            renderItem={({ item: segment }) => (
                <ItemGroup
                    title={segment.first
                        ? t(segment.group === 'waiting' ? 'teams.invitations.waitingSection' : 'teams.invitations.finishedSection')
                        : undefined}
                    action={segment.key === firstSegmentKey ? inviteAction : undefined}
                    description={segment.first && segment.group === 'waiting'
                        ? notice ?? t('teams.invitations.bearerUnavailable')
                        : segment.key === firstSegmentKey ? notice ?? undefined : undefined}
                    virtualizedSegment={{ first: segment.first, last: segment.last }}
                >
                    {segment.items.map((row) => {
                        const { presentation, canReissue, isActionable } = rowActions(row);
                        const waiting = segment.group === 'waiting';
                        // Trouble carries its action in the row (lab `tsInvites-A`): an email
                        // that did not arrive offers "Send again" without opening the chooser.
                        const sendAgain = waiting && presentation.emailUndelivered && canReissue;
                        return (
                            <Item
                                key={row.id}
                                testID={`team-invitations-row:${row.id}`}
                                title={presentation.recipientLabel ?? t('teams.invitations.byLink')}
                                subtitle={(waiting
                                    ? [
                                        presentation.deliveryLabel,
                                        presentation.offerLabel,
                                        t('teams.invitations.expires', { when: date(row.expiresAt) }),
                                    ]
                                    : [presentation.stateLabel, presentation.offerLabel])
                                    .filter((part): part is string => part !== null)
                                    .join(' · ')}
                                subtitleLines={0}
                                // A finished invitation's one dated fact the row carries is when it
                                // expired; accepted and revoked rows publish no instant to show.
                                detail={presentation.state === 'expired' ? date(row.expiresAt) : undefined}
                                subtitleLeading={waiting && presentation.emailUndelivered
                                    ? <StatusDot size={6} color={theme.colors.state.warning.foreground} />
                                    : undefined}
                                accessoryLayout={sendAgain ? 'adaptive' : undefined}
                                rightElement={sendAgain ? (
                                    <RoundButton
                                        testID={`team-invitations-send-again:${row.id}`}
                                        size="small"
                                        display="secondary"
                                        title={t('teams.invitations.sendAgain')}
                                        disabled={busy}
                                        onPress={() => void act(row, 'retry')}
                                    />
                                ) : undefined}
                                disabled={isActionable && busy}
                                mode={isActionable ? 'interactive' : 'info'}
                                onPress={isActionable ? () => void act(row, null) : undefined}
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
            )}
            ListFooterComponent={canManage ? (
                <>
                    {invitations.error ? (
                        <AttentionBanner
                            testID="team-invitations-unavailable"
                            title={teamReadFailureLabel(invitations.error)}
                            action={invitations.error.retryable
                                ? { label: t('teams.unavailable.retry'), onPress: () => void invitations.reload(), testID: 'team-invitations-retry' }
                                : undefined}
                        />
                    ) : invitations.hasMore && invitations.rows.length > 0 ? (
                        <ItemGroup>
                            <Item
                                testID="team-invitations-load-more"
                                title={t('homeGovernance.loadMore')}
                                loading={invitations.status === 'loading_more'}
                                disabled={invitations.status === 'loading_more'}
                                onPress={() => void invitations.loadMore()}
                                showChevron={false}
                            />
                        </ItemGroup>
                    ) : null}
                </>
            ) : null}
            style={{
                flex: 1,
                backgroundColor: theme.colors.surface.base,
                ...(Platform.OS === 'web' ? { minHeight: 0 } : {}),
            }}
            contentContainerStyle={{ paddingBottom: Platform.OS === 'ios' ? 34 : 16 }}
            backendPreference="auto"
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={7}
            estimatedItemSize={120}
            maintainVisibleContentPosition
        />
    );
});

export const TeamInvitationsScreen = React.memo(function TeamInvitationsScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.tabs.invitations')}
            description={t('teams.pages.invitations')}
            presentation="virtualized-list"
        >
            {(context, header) => <InvitationsList context={context} header={header} />}
        </TeamSection>
    );
});
