import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { projectFollowPolicyEditorV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';
import type { FollowSourceRelationV1, SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { resolveFollowDeliveryV1, type FollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { projectAccountSessionFollowPolicyEditor } from '@/components/sessions/follow/accountSessionFollowController';
import { AccountSessionFollowControl } from '@/components/sessions/follow/AccountSessionFollowControl';
import type { AccountSessionFollowEditorParts } from '@/components/sessions/follow/AccountSessionFollowEditor';
import { SessionFollowSourcesEditor } from '@/components/sessions/follow/SessionFollowSourcesEditor';
import { FollowSessionMark } from '@/components/sessions/follow/FollowSessionMark';
import { FollowEditorPage } from '@/components/sessions/follow/FollowEditorPage';
import { FollowEditorPanel } from '@/components/sessions/follow/FollowEditorPanel';
import { openFollowNotificationSettings } from '@/components/sessions/follow/openFollowNotificationSettings';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { useIsTablet } from '@/utils/platform/responsive';
import { useAccountSessionFollowController } from '@/components/sessions/follow/useAccountSessionFollowController';
import { useSessionFollowers } from '@/components/sessions/follow/useSessionFollowers';
import { useSessionFollowing } from '@/components/sessions/follow/useSessionFollowing';
import { describeSessionFollowLevel } from '@/components/sessions/follow/sessionFollowLevelCopy';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PaneSectionHeader } from '@/components/ui/lists/PaneSectionHeader';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { useSessionListRowsByServerId } from '@/sync/domains/state/storage';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';

type FollowPreset = 'everything' | 'important' | 'quiet' | 'custom';

/** The rows' identity mark, in the leading column every pane row shares (a person, a session, people). */
function FollowerMark(props: Readonly<{ name: IconName }>) {
    const { theme } = useUnistyles();
    return <Icon name={props.name} size={18} color={theme.colors.text.secondary} />;
}

/** A person's level in one line: the level, then what it means for them (Settings → Coordination's words). */
function describePersonLevel(preset: FollowPreset): string {
    const meaning = preset === 'everything' ? t('settingsCoordination.levelEverythingHint')
        : preset === 'important' ? t('settingsCoordination.levelImportantHint')
            : preset === 'quiet' ? t('settingsCoordination.levelQuietHint') : null;
    return joinHappierFacts(t(`session.follow.policy.${preset}`), meaning);
}

type SessionFollowerRelation = Readonly<{
    relation: 'manager' | 'follower';
    policy: SessionFollowSourceV1['policy'];
    deliveryState: SessionFollowSourceV1['deliveryState'];
}>;

type SessionFollowerDelivery = Readonly<{
    delivery: 'wake' | 'next_turn' | 'off';
    via: readonly SessionFollowerRelation['relation'][];
}>;

const followerEvents = {
    needsYouDecision: { kind: 'needs_you', type: 'decision' },
    needsYouApproval: { kind: 'needs_you', type: 'approval' },
    needsYouBlocked: { kind: 'needs_you', type: 'blocked' },
    needsYouContinue: { kind: 'needs_you', type: 'decision', mode: 'continue' },
    finished: { kind: 'finished' },
    failedOrStopped: { kind: 'failed_or_stopped' },
    stalled: { kind: 'stalled' },
    updatePosted: { kind: 'update_posted' },
    personWrote: { kind: 'person_wrote' },
    goalChanged: { kind: 'goal_changed' },
    message: { kind: 'message' },
} as const satisfies Record<string, FollowEventV1>;

/** Ask for an actual event, including its needs-you type, mode and handler. */
export function projectFollowerDelivery(follower: Pick<SessionFollower, 'relations'>, event: FollowEventV1): SessionFollowerDelivery {
    const decision = resolveFollowDeliveryV1({ policies: follower.relations.map((relation) => relation.policy), event });
    return {
        delivery: decision.session.wake ? 'wake' : decision.session.nextTurn ? 'next_turn' : 'off',
        // The canonical resolver's selected flag always projects to one session channel.
        via: follower.relations.filter((relation) => resolveFollowDeliveryV1({ policies: [relation.policy], event }).selected)
            .map((relation) => relation.relation),
    };
}

export type SessionFollower = Readonly<{
    sessionId: string;
    manager: boolean;
    relations: readonly SessionFollowerRelation[];
    /** Policy intent, before receiver availability or source access is applied. */
    effective: Readonly<{ [K in keyof typeof followerEvents]: SessionFollowerDelivery }>;
}>;

/**
 * Who follows, from the reverse read: one row per following session (a receiver can hold both a
 * follower and a manager relation), the people census (which counts you when your own follow is
 * active) and the other people. Unknown stays null, never zero.
 */
export function projectSessionFollowerCensus(projection: Readonly<{
    sources: readonly FollowSourceRelationV1[];
    follows: readonly unknown[];
    peopleCount?: number;
}> | null): Readonly<{ sessions: readonly SessionFollower[] | null; peopleCount: number | null; otherPeople: number | null }> {
    if (!projection) return { sessions: null, peopleCount: null, otherPeople: null };
    const byReceiver = new Map<string, { sessionId: string; relations: SessionFollowerRelation[] }>();
    for (const source of projection.sources) {
        // This is the reverse census for one Session source. Other source kinds
        // share Follow's list transport but are not followers of this Session.
        if (!('sourceSessionId' in source)) continue;
        const current = byReceiver.get(source.destinationSessionId)
            ?? { sessionId: source.destinationSessionId, relations: [] };
        current.relations.push({ relation: source.relation ?? 'follower', policy: source.policy, deliveryState: source.deliveryState });
        byReceiver.set(source.destinationSessionId, current);
    }
    const peopleCount = projection.peopleCount ?? null;
    return {
        sessions: [...byReceiver.values()].map(({ sessionId, relations }) => {
            const decision = (event: FollowEventV1) => projectFollowerDelivery({ relations }, event);
            return {
                sessionId,
                manager: relations.some((relation) => relation.relation === 'manager'),
                relations,
                effective: {
                    needsYouDecision: decision(followerEvents.needsYouDecision),
                    needsYouApproval: decision(followerEvents.needsYouApproval),
                    needsYouBlocked: decision(followerEvents.needsYouBlocked),
                    needsYouContinue: decision(followerEvents.needsYouContinue),
                    finished: decision(followerEvents.finished),
                    failedOrStopped: decision(followerEvents.failedOrStopped),
                    stalled: decision(followerEvents.stalled),
                    updatePosted: decision(followerEvents.updatePosted),
                    personWrote: decision(followerEvents.personWrote),
                    goalChanged: decision(followerEvents.goalChanged),
                    message: decision(followerEvents.message),
                },
            };
        }),
        peopleCount,
        otherPeople: peopleCount === null ? null : Math.max(0, peopleCount - (projection.follows.length > 0 ? 1 : 0)),
    };
}

export type SessionPeopleFollowDirection = 'followers' | 'following';

/**
 * Who hears about this session and what it hears about, read once for People's summary rows and the sheet they
 * open: the Followers census from the authoritative reverse read (`useSessionFollowers`), the Following census
 * (`useSessionFollowing`) and your own level (the Follow editor's one controller). Unknown stays null, never zero.
 */
export function useSessionPeopleFollow(target: SessionAddress) {
    const featureEnabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: target.serverId });
    const enabled = Boolean(target.serverId?.trim()) && featureEnabled;
    const followers = useSessionFollowers(target, enabled);
    const census = React.useMemo(() => projectSessionFollowerCensus(followers.projection), [followers.projection]);
    const following = useSessionFollowing(target, enabled);
    const { state: you } = useAccountSessionFollowController(target, enabled);
    const youLevel = React.useMemo((): FollowPreset | 'none' | null => {
        if (!you.projection) return null;
        const editor = projectAccountSessionFollowPolicyEditor(you);
        return editor.following && editor.model ? editor.model.preset as FollowPreset : 'none';
    }, [you]);
    return {
        enabled,
        census,
        followersLoading: followers.loading,
        // A failed reverse read is unknown, never "nobody else": the sheet says so and offers the owner's re-read.
        followersError: followers.error,
        refreshFollowers: followers.refresh,
        following,
        youLevel,
        youLoading: you.loading,
    };
}

export type SessionPeopleFollow = ReturnType<typeof useSessionPeopleFollow>;
/** A one-shot request to open People's Follow sheet in one direction; each new object is one request. */
export type SessionPeopleFollowOpenRequest = Readonly<{ direction: SessionPeopleFollowDirection }>;

/** Followers in one line: your own level, then how many sessions and other people (never who) also follow it. */
function describeFollowersSummary(people: SessionPeopleFollow): string | null {
    if (people.followersError !== null && !people.census.sessions) return t('errors.unknownError');
    const you = people.youLevel === null ? null : joinHappierFacts(t('session.collaboration.pane.followersYou'),
        people.youLevel === 'none' ? t('session.follow.level.none') : t(`session.follow.policy.${people.youLevel}`));
    const { sessions, otherPeople } = people.census;
    const facts = joinHappierFacts(
        you,
        sessions && sessions.length > 0 ? t('session.collaboration.pane.followersSessions', { count: sessions.length }) : null,
        otherPeople ? t('session.collaboration.pane.followersPeople', { count: otherPeople }) : null,
    );
    return facts.length > 0 ? facts : null;
}

/** Following in one line: its rules, then the Sessions it follows; nothing yet says what belongs there. */
function describeFollowingSummary(people: SessionPeopleFollow): string | null {
    const projection = people.following.projection;
    if (people.following.error !== null && !projection) return t('errors.unknownError');
    if (!projection) return null;
    const sessions = projection.sources.filter((source) => 'sourceSessionId' in source).length;
    if (projection.rules.length === 0 && projection.sources.length === 0) return t('session.follow.sources.empty');
    return joinHappierFacts(
        projection.rules.length > 0 ? t('session.collaboration.pane.followingRules', { count: projection.rules.length }) : null,
        sessions > 0 ? t('session.collaboration.pane.followersSessions', { count: sessions }) : null,
    );
}

/**
 * Who hears about this session, and what it hears about (C1 §6.1 R12): two summary rows under the
 * Discussions, Followers then Following, each opening the same Follow sheet in its direction, where the rows,
 * rules and their panels are. The sheet floats from its row on a wide window and is a pushed page on a phone.
 * The pane header says both in one line (lab P1-CP: "Follows 2 rules · 1 session", then "3 people · 2 sessions
 * follow it"), from the same censuses.
 */
export const SessionPeopleFollowSections = React.memo(function SessionPeopleFollowSections(props: Readonly<{
    target: SessionAddress;
    session: Session | null;
    /** Attached to the Following row: the sheet floats from it and focus returns to it. */
    followingAnchorRef?: React.RefObject<View | null>;
    /**
     * A one-shot request to open a direction's sheet ("Edit what it follows" opens Following). Each new request object
     * opens it once; ordinary People navigation passes none and the sheet stays closed.
     */
    openRequest?: SessionPeopleFollowOpenRequest | null;
    /** Returns custody to the stable route owner before this remountable child opens the request. */
    onOpenRequestAccepted?: (request: SessionPeopleFollowOpenRequest) => boolean;
}>) {
    const people = useSessionPeopleFollow(props.target);
    const { census, following } = people;
    const { sessions, peopleCount } = census;
    const machineId = props.session ? (readSessionOwnerMetadataView(props.session)?.machineId ?? null) : null;
    const router = useRouter();
    const anchored = useIsTablet();
    const [openDirection, setOpenDirection] = React.useState<SessionPeopleFollowDirection | null>(null);
    const followersAnchorRef = React.useRef<View>(null);
    const ownFollowingAnchorRef = React.useRef<View>(null);
    const followingAnchorRef = props.followingAnchorRef ?? ownFollowingAnchorRef;
    const followersTriggerRef = React.useRef<React.ComponentRef<typeof Pressable>>(null);
    const followingTriggerRef = React.useRef<React.ComponentRef<typeof Pressable>>(null);

    const followingProjection = following.projection;
    const headerLine = React.useMemo(() => {
        // What it follows: its rules, then the Sessions it follows by name (other source kinds stay in the list).
        const ruleCount = followingProjection?.rules.length ?? 0;
        const followedSessions = followingProjection?.sources.filter((source) => 'sourceSessionId' in source).length ?? 0;
        const follows = joinHappierFacts(
            ruleCount > 0 ? t('session.collaboration.pane.followingRules', { count: ruleCount }) : null,
            followedSessions > 0 ? t('session.collaboration.pane.followersSessions', { count: followedSessions }) : null,
        );
        const sessionCount = sessions?.length ?? 0;
        const peopleTotal = peopleCount ?? 0;
        const followedBy = sessions && sessionCount + peopleTotal > 0
            ? t('session.collaboration.pane.followedBy', {
                facts: joinHappierFacts(
                    peopleTotal > 0 ? t('session.collaboration.pane.followersPeople', { count: peopleTotal }) : null,
                    sessionCount > 0 ? t('session.collaboration.pane.followersSessions', { count: sessionCount }) : null,
                ),
                count: sessionCount + peopleTotal,
            })
            : null;
        const segments = [follows ? t('session.collaboration.pane.follows', { facts: follows }) : null, followedBy]
            .filter((segment): segment is string => segment !== null);
        return segments.length > 0 ? { segments } : null;
    }, [followingProjection, peopleCount, sessions]);
    usePaneHeaderSlotContent(React.useMemo(() => ({ line: headerLine }), [headerLine]));

    const close = React.useCallback(() => setOpenDirection(null), []);
    const { target } = props;
    const open = React.useCallback((direction: SessionPeopleFollowDirection) => {
        if (anchored) { setOpenDirection(direction); return; }
        router.push(buildScopedSessionRouteHref({
            ...target,
            suffix: '/follow-people',
            query: { direction },
        }) as Href);
    }, [anchored, router, target]);
    const handledRequest = React.useRef<SessionPeopleFollowOpenRequest | null>(null);
    const request = props.openRequest ?? null;
    React.useEffect(() => {
        // Applied once Following is known to be offered here, so a request never pushes a page that can't render.
        if (!request || !people.enabled || handledRequest.current === request) return;
        handledRequest.current = request;
        if (props.onOpenRequestAccepted?.(request) === false) return;
        open(request.direction);
    }, [open, people.enabled, props.onOpenRequestAccepted, request]);
    if (!people.enabled) return null;
    const followersSummary = describeFollowersSummary(people);
    const followingSummary = describeFollowingSummary(people);
    return (
        <View style={styles.section}>
            {/* Its own heading: the summaries are who hears about it and what it hears, not part of the section above. */}
            <PaneSectionHeader title={t('sessionPages.info.follow')} />
            <View ref={followersAnchorRef} collapsable={false}>
                <Item pressableRef={followersTriggerRef} testID="session-people-followers-summary" density="compact" showDivider={false}
                    icon={<FollowerMark name="users" />}
                    title={t('session.collaboration.pane.followersTitle')}
                    subtitle={followersSummary ?? undefined}
                    subtitleLines={2}
                    loading={followersSummary === null && (people.followersLoading || people.youLoading)}
                    onPress={() => open('followers')} />
            </View>
            <View ref={followingAnchorRef} tabIndex={-1} collapsable={false} testID="session-people-following">
                <Item pressableRef={followingTriggerRef} testID="session-people-following-summary" density="compact" showDivider={false}
                    icon={<FollowerMark name="bell" />}
                    title={t('session.follow.sources.title')}
                    subtitle={followingSummary ?? undefined}
                    subtitleLines={2}
                    loading={followingSummary === null && following.loading}
                    onPress={() => open('following')} />
            </View>
            {openDirection ? (
                <SessionPeopleFollowSheet target={props.target} machineId={machineId} direction={openDirection} people={people}
                    host={{
                        kind: 'panel',
                        anchorRef: openDirection === 'followers' ? followersAnchorRef : followingAnchorRef,
                        focusReturnRef: openDirection === 'followers' ? followersTriggerRef : followingTriggerRef,
                        onClose: close,
                    }} />
            ) : null}
        </View>
    );
});

type FollowSheetParts = AccountSessionFollowEditorParts;
type FollowSheetStep =
    | Readonly<{ kind: 'you' }>
    | Readonly<{ kind: 'follower'; follower: SessionFollower; title: string }>
    | Readonly<{ kind: 'source'; sourceKey: string }>;

/**
 * People's Follow sheet in one direction (C1 §6.1): Followers (you, the sessions that follow it, how many other
 * people) or Following (its sources and rules, and Add). It is the shared Follow host: the anchored panel on a
 * wide window, where a row's own panel replaces the list in place with a way Back (no panel over a panel), and the
 * pushed page on a phone, where a row pushes its own page as everywhere else.
 */
export function SessionPeopleFollowSheet(props: Readonly<{
    target: SessionAddress;
    machineId: string | null;
    direction: SessionPeopleFollowDirection;
    people: SessionPeopleFollow;
    host:
        | Readonly<{
            kind: 'panel';
            anchorRef: React.RefObject<View | null>;
            focusReturnRef: React.RefObject<React.ComponentRef<typeof Pressable> | null>;
            onClose(): void;
        }>
        | Readonly<{ kind: 'page'; onClose(): void }>;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { host, people, target } = props;
    const panel = host.kind === 'panel' ? host : null;
    const [step, setStep] = React.useState<FollowSheetStep | null>(null);
    const back = React.useCallback(() => setStep(null), []);

    const frame = (parts: FollowSheetParts, stepBack?: () => void) => panel ? (
        <FollowEditorPanel anchorRef={panel.anchorRef} focusReturnRef={panel.focusReturnRef} onRequestClose={panel.onClose}
            testID="session-people-follow-sheet" accessibilityLabel={parts.title}
            title={parts.title} subtitle={parts.subtitle} mark={parts.mark} footer={parts.footer}>
            {stepBack ? <Item testID="session-people-follow-sheet-back" showChevron={false} showDivider={false}
                icon={<Icon name="caret-left" size={18} color={theme.colors.text.secondary} />}
                title={t('common.back')} onPress={stepBack} /> : null}
            {parts.body}
        </FollowEditorPanel>
    ) : (
        <FollowEditorPage title={parts.title} subtitle={parts.subtitle} footer={parts.footer} footerTestID="session-people-follow-sheet-footer">
            {parts.body}
        </FollowEditorPage>
    );

    if (panel && step?.kind === 'you') {
        return <AccountSessionFollowControl address={target} onClose={back}
            onOpenNotificationSettings={() => {
                panel.onClose();
                void openFollowNotificationSettings({ serverId: target.serverId, navigate: () => router.push('/settings/notifications') });
            }}
            frame={(parts) => frame(parts, back)} />;
    }
    if (panel && step?.kind === 'follower') {
        return <SessionFollowerPanel target={target} follower={step.follower} title={step.title} onClose={back}
            frame={(parts) => frame(parts, back)} />;
    }
    if (panel && step?.kind === 'source') {
        return <SessionFollowSourcesEditor destination={{ id: target.sessionId }} serverId={target.serverId}
            destinationMachineId={props.machineId} following={people.following}
            page={{ sourceKey: step.sourceKey, onClose: back, frame: (parts) => frame(parts, back) }} />;
    }

    const followers = props.direction === 'followers';
    const footer = <SectionButtonRow trailing={<RoundButton testID="session-people-follow-sheet-done" title={t('common.done')} onPress={host.onClose} />}>
        {null}
    </SectionButtonRow>;
    const body = followers ? (
        <ItemGroup>
            <SessionPeopleYouRow level={people.youLevel} loading={people.youLoading}
                onPress={() => {
                    if (panel) { setStep({ kind: 'you' }); return; }
                    router.push(buildScopedSessionRouteHref({ ...target, suffix: '/follow' }) as Href);
                }} />
            {people.census.sessions ? (
                <SessionFollowerRows target={target} followers={people.census.sessions}
                    onOpen={(follower, title) => {
                        if (panel) { setStep({ kind: 'follower', follower, title }); return; }
                        router.push(buildScopedSessionRouteHref({
                            sessionId: follower.sessionId,
                            serverId: target.serverId,
                            suffix: '/follow-source',
                            query: { source: target.sessionId },
                        }) as Href);
                    }} />
            ) : people.followersLoading && people.followersError === null
                ? <Item title={t('common.loading')} loading showChevron={false} mode="info" /> : null}
            {people.census.otherPeople ? (
                // The census counts the other people and never names them: plain information, no promised list.
                <Item testID="session-people-followers-people" mode="info"
                    icon={<FollowerMark name="users" />}
                    title={t('session.collaboration.pane.followersPeople', { count: people.census.otherPeople })}
                    subtitle={t('session.collaboration.pane.followersPeopleNote')} />
            ) : null}
            {/* The Following list's own failed-read row: last-known followers stay, Retry re-reads. */}
            {people.followersError !== null ? (
                <Item testID="session-people-followers-error" title={t('errors.unknownError')} detail={t('common.retry')}
                    accessibilityLiveRegion="polite" onPress={people.refreshFollowers} />
            ) : null}
        </ItemGroup>
    ) : (
        <SessionFollowSourcesEditor destination={{ id: target.sessionId }} serverId={target.serverId}
            destinationMachineId={props.machineId} following={people.following}
            sheet={{ onOpenSource: panel ? (sourceKey) => setStep({ kind: 'source', sourceKey }) : undefined }} />
    );
    // With only the You row listed, the summary would repeat that row word for word (LABPARITY-ACCEPT-F fix 8).
    const followersListIsYouAlone = (people.census.sessions?.length ?? 0) === 0 && !people.census.otherPeople;
    return frame({
        title: followers ? t('session.collaboration.pane.followersTitle') : t('session.follow.sources.title'),
        // One message per state: a failed read is said by the list's own Retry row, not again in the header, and a list
        // of one row already says what the summary would.
        subtitle: (followers
            ? (people.followersError !== null && !people.census.sessions) || followersListIsYouAlone ? null : describeFollowersSummary(people)
            : (people.following.error !== null && !people.following.projection ? null : describeFollowingSummary(people))) ?? '',
        mark: <FollowerMark name={followers ? 'users' : 'bell'} />,
        body,
        footer,
    });
}

/**
 * A follower row's one line. One relation says its level and what that wakes. A receiver that is both its manager
 * and an ordinary follower stays one row: who it is, that it also follows, and the union the Home delivers
 * (wake, next turn, or no events selected), never just one relation's level.
 */
export function describeSessionFollower(follower: Pick<SessionFollower, 'manager' | 'relations' | 'effective'>): string {
    const manager = follower.manager ? t('session.collaboration.pane.followersManager') : null;
    const [only] = follower.relations;
    if (only && follower.relations.length === 1) {
        return joinHappierFacts(manager, describeSessionFollowLevel(projectFollowPolicyEditorV1(only.policy).preset as FollowPreset));
    }
    const deliveries = Object.values(follower.effective);
    const meaning = deliveries.some((event) => event.delivery === 'wake')
        ? t('session.collaboration.pane.followersEffectiveWake')
        : deliveries.some((event) => event.delivery === 'next_turn')
            ? t('session.collaboration.pane.followersEffectiveNextTurn')
            : t('session.collaboration.pane.followersEffectiveOff');
    return joinHappierFacts(
        manager,
        t('session.collaboration.pane.followersAlsoFollows'),
        meaning,
    );
}

/**
 * The sessions that follow this one, named through the batched title projection. A row opens the same Follow
 * panel as the follower's own Following row (lab P2-S), never the follower Session: the sheet steps to it in
 * place on a wide window and pushes it on a phone.
 */
function SessionFollowerRows(props: Readonly<{
    target: SessionAddress;
    followers: readonly SessionFollower[];
    onOpen(follower: SessionFollower, title: string): void;
}>) {
    const addresses = React.useMemo(() => props.followers.map((follower) => ({ sessionId: follower.sessionId, serverId: props.target.serverId })),
        [props.target.serverId, props.followers]);
    const titles = useSessionDisplayTitles(addresses);
    const rows = readSessionListRowsForServerId(useSessionListRowsByServerId(), props.target.serverId);
    return <>
        {props.followers.map((follower, index) => {
            const title = titles[index] ?? t('session.untitled');
            return <Item key={follower.sessionId} testID={`session-people-follower-session-${follower.sessionId}`}
                title={title}
                icon={<FollowSessionMark session={rows?.[follower.sessionId] ?? null} serverId={props.target.serverId} rowGlyph />}
                subtitle={describeSessionFollower(follower)} subtitleLines={2} onPress={() => props.onOpen(follower, title)} />;
        })}
    </>;
}

/**
 * "<follower> follows this": why, and how much it hears, edited through the follower's own editor and writers for
 * this one source. A receiver that hears only as this session's manager has no ordinary follow to edit here, so its
 * panel says where that is changed.
 */
function SessionFollowerPanel(props: Readonly<{
    target: SessionAddress;
    follower: SessionFollower;
    title: string;
    onClose(): void;
    frame(parts: FollowSheetParts): React.ReactNode;
}>) {
    const why = describeSessionFollower(props.follower);
    const heading = { title: t('session.follow.sources.followsThis', { title: props.title }), subtitle: why, mark: <FollowerMark name="stack" /> };
    const ordinary = props.follower.relations.some((relation) => relation.relation === 'follower');
    if (!ordinary) {
        return <>{props.frame({
            ...heading,
            body: <Item density="compact" showDivider={false} showChevron={false} mode="info" titleLines={0}
                title={t('session.follow.sources.managerOnly')} />,
            footer: <SectionButtonRow trailing={<RoundButton title={t('common.done')} onPress={props.onClose} />}>{null}</SectionButtonRow>,
        })}</>;
    }
    return <SessionFollowSourcesEditor destination={{ id: props.follower.sessionId }} serverId={props.target.serverId}
        destinationMachineId={null}
        page={{ sourceKey: props.target.sessionId, onClose: props.onClose, frame: (parts) => props.frame({ ...parts, ...heading }) }} />;
}

/** Your own level and what it means; it opens the same Follow editor the session header does. */
function SessionPeopleYouRow(props: Readonly<{ level: FollowPreset | 'none' | null; loading: boolean; onPress(): void }>) {
    const level = props.level === null ? null : props.level === 'none' ? t('session.follow.level.none') : describePersonLevel(props.level);
    return <Item testID="session-people-follower-you"
        icon={<FollowerMark name="user-circle" />}
        title={t('session.collaboration.pane.followersYou')}
        subtitle={level ?? undefined}
        subtitleLines={2}
        loading={level === null && props.loading}
        onPress={props.onPress} />;
}

const styles = StyleSheet.create((theme) => ({
    section: { paddingTop: theme.space.s12 },
}));
