import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent, type ViewProps } from 'react-native';
import Animated from 'react-native-reanimated';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import { SessionAccessEditor } from '@/components/sessions/access/SessionAccessEditor';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import type { SessionAccessEditorController } from '@/components/sessions/access/sessionAccessEditorTypes';
import { UnboundSessionHomeScopeCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import { useLiveSessionAccessEditorController } from '@/components/sessions/access/useLiveSessionAccessEditorController';
import { SessionResponsibilitySection } from '@/components/sessions/responsibility/SessionResponsibilitySection';
import { useSessionResponsibilityController } from '@/components/sessions/responsibility/useSessionResponsibilityController';
import { useSessionResponsibilityPickerHost } from '@/components/sessions/responsibility/useSessionResponsibilityPickerHost';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById, readServerProfileHomeName } from '@/sync/domains/server/serverProfiles';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';
import { SessionPresenceSection } from './SessionPresenceSection';
import { SessionPublicLinkSection, useSessionCollaborationPublicLink, type SessionCollaborationPublicLink } from './SessionPublicLinkSection';
import { SessionConversationsBody } from '@/components/sessions/conversations/SessionConversationsBody';
import { useSessionConversationsAvailability } from '@/components/sessions/conversations/useSessionConversationsAvailability';
import { restoreFocusToBestTarget } from '@/keyboard/focusReturn';
import { useExternalSessionSharingAvailability, type ExternalSessionSharingAvailability } from '@/components/sessions/external/sharing/useExternalSessionSharingAvailability';
import {
    consumeSessionCollaborationIntent,
    normalizeSessionCollaborationFocusTarget,
    readSessionCollaborationIntent,
    subscribeSessionCollaborationIntent,
    type SessionCollaborationFocusTarget,
    type SessionCollaborationIntent,
} from './sessionCollaborationIntent';
import { useConsumeSessionCollaborationRouteFocus } from './useOpenSessionCollaboration';
import { useExactSessionSnapshot, type ExactSessionSnapshotState } from './useExactSessionSnapshot';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { SessionExternalSharingAvailabilitySection } from './SessionExternalSharingAvailabilitySection';
import { SessionCollaborationAccessCard, projectSessionCollaborationAccessCard } from './SessionCollaborationAccessCard';
import { SessionShareMorphFrame, useShareMorph, useShareMorphCoveredStyle, type ShareMorphRect } from './SessionShareMorph';

const WebInertView = View as React.ComponentType<ViewProps & Readonly<{ inert?: boolean }>>;

const styles = StyleSheet.create((theme) => ({
    surface: { flex: 1, minHeight: 0, minWidth: 0 },
    column: { flex: 1, minHeight: 0, minWidth: 0, paddingTop: 4 },
    // Only the conversations flex, so their list stays the one scroller and the
    // present line, Responsible and the access card stay put around it.
    body: { flex: 1, minHeight: 0, minWidth: 0 },
    responsible: { paddingVertical: 2 },
    panel: { flex: 1, minHeight: 0, minWidth: 0 },
    panelHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10, paddingLeft: 16, paddingRight: 8 },
    panelTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        lineHeight: 20,
        color: theme.colors.text.primary,
        flex: 1,
    },
    panelBody: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingTop: 2,
        paddingBottom: 8,
    },
    accessBody: { flex: 1, minHeight: 0, minWidth: 0 },
    spacer: { flex: 1 },
    publicLink: { paddingTop: 4 },
}));

/** Hosts supply geometry; each domain child retains its own state and failure boundary. */
export function SessionCollaborationSurface({ target }: Readonly<{ target: SessionAddress }>): React.ReactElement {
    const resolution = useServerCredentialAccountScopeResolution(target.serverId);
    return (
        <View style={styles.surface} testID="session-collaboration-surface">
            {resolution.kind === 'bound' ? (
                <SessionCollaborationAccountContent
                    key={`${serverAccountScopeKeySuffix(resolution.scope)}:${sessionAddressKey({ serverId: resolution.scope.serverId, sessionId: target.sessionId })}`}
                    scope={resolution.scope}
                    sessionId={target.sessionId}
                />
            ) : (
                <UnboundSessionHomeScopeCard resolution={resolution} serverId={target.serverId} testIDPrefix="session-collaboration" />
            )}
        </View>
    );
}

type PaneRefs = Readonly<{
    responsibleAnchor: React.RefObject<React.ElementRef<typeof View> | null>;
    accessAnchor: React.RefObject<React.ElementRef<typeof View> | null>;
    publicLinkAnchor: React.RefCallback<React.ElementRef<typeof View>>;
    panelAnchor: React.RefObject<React.ElementRef<typeof View> | null>;
    card: React.RefObject<React.ElementRef<typeof Pressable> | null>;
}>;

/**
 * The Collaboration pane, conversations-first (lab `collab` C1): the present in one line, one
 * Responsible row, the conversations filling the pane, and one access card pinned at the foot. The
 * card grows in place into the Share panel (SH), which holds the people with their levels and the
 * public link itself; ⌄ or Esc folds it back. Access is set up once and conversations are used all
 * day, so there is no mode switch between them.
 */
function SessionCollaborationAccountContent(props: Readonly<{ scope: ServerAccountScope; sessionId: string }>) {
    const availability = useSessionCollaborationAvailability(props.scope.serverId);
    const conversationsEnabled = useSessionConversationsAvailability(props.scope.serverId);
    const target = React.useMemo(() => ({ serverId: props.scope.serverId, sessionId: props.sessionId }), [props.scope.serverId, props.sessionId]);
    const routeParams = useLocalSearchParams<{ collaborationFocus?: string | string[] }>();
    const routeFocus = normalizeSessionCollaborationFocusTarget(routeParams.collaborationFocus);
    const consumeRouteFocus = useConsumeSessionCollaborationRouteFocus();
    const pendingIntent = React.useSyncExternalStore(
        React.useCallback((listener) => subscribeSessionCollaborationIntent(target, listener), [target]),
        React.useCallback(() => readSessionCollaborationIntent(target), [target]),
        () => null,
    );
    const initialFocus = React.useRef(routeFocus ?? pendingIntent?.focusTarget ?? null).current;
    // The same one-shot intent, kept for the Share panel: the handing-off
    // compact editor is unmounted by the time this surface renders, so the
    // query it carried is read here and applied once by the destination's own
    // controller. Identity is the frozen intent itself, so a later handoff for
    // the same text still applies and a re-render never re-applies one.
    const [handoff, setHandoff] = React.useState<SessionCollaborationIntent | null>(() => pendingIntent);
    const [shareOpen, setShareOpen] = React.useState(() => initialFocus === 'access' || initialFocus === 'publicLink');
    // The panel is built on first open and then retained, so its search and scroll survive a fold.
    const [shareVisited, setShareVisited] = React.useState(shareOpen);
    const [openRowRequest, setOpenRowRequest] = React.useState<Readonly<{ key: string }> | undefined>(
        () => initialFocus === 'publicLink' ? { key: 'public-link' } : undefined,
    );
    const publicLinkAnchor = React.useRef<React.ElementRef<typeof View>>(null);
    const appliedIntentId = React.useRef(0);
    const appliedRouteFocus = React.useRef<SessionCollaborationFocusTarget | null>(null);
    const focusHandle = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingFocusAnchor = React.useRef<React.RefObject<React.ElementRef<typeof View> | React.ElementRef<typeof Pressable> | null> | null>(null);

    const scheduleFocus = React.useCallback((anchor: React.RefObject<React.ElementRef<typeof View> | React.ElementRef<typeof Pressable> | null>) => {
        if (focusHandle.current !== null) clearTimeout(focusHandle.current);
        pendingFocusAnchor.current = anchor;
        focusHandle.current = setTimeout(() => {
            focusHandle.current = null;
            if (!anchor.current) return;
            pendingFocusAnchor.current = null;
            restoreFocusToBestTarget({ current: anchor.current });
        }, 0);
    }, []);
    const attachPublicLinkAnchor = React.useCallback((node: React.ElementRef<typeof View> | null) => {
        publicLinkAnchor.current = node;
        // Exact-Home hydration can mount this row after the one-shot focus tick.
        // Resume that same requested move when its target becomes available.
        if (node && pendingFocusAnchor.current === publicLinkAnchor) scheduleFocus(publicLinkAnchor);
    }, [scheduleFocus]);
    const refs: PaneRefs = {
        responsibleAnchor: React.useRef<React.ElementRef<typeof View>>(null),
        accessAnchor: React.useRef<React.ElementRef<typeof View>>(null),
        publicLinkAnchor: attachPublicLinkAnchor,
        panelAnchor: React.useRef<React.ElementRef<typeof View>>(null),
        card: React.useRef<React.ElementRef<typeof Pressable>>(null),
    };

    const openShare = React.useCallback(() => {
        setShareVisited(true);
        setShareOpen(true);
    }, []);
    const closeShare = React.useCallback(() => {
        setShareOpen(false);
        // Folding back returns the person to the card it grew from.
        scheduleFocus(refs.card);
    }, [refs.card, scheduleFocus]);
    const openShareFromCard = React.useCallback(() => {
        openShare();
        scheduleFocus(refs.panelAnchor);
    }, [openShare, refs.panelAnchor, scheduleFocus]);

    const applyFocus = React.useCallback((focusTarget: SessionCollaborationFocusTarget) => {
        // A superseding intent always cancels the pending move; an ordinary `top`
        // entry schedules nothing, because only an explicit Access/Responsible/
        // Public Link request may take focus from the caller.
        if (focusHandle.current !== null) clearTimeout(focusHandle.current);
        focusHandle.current = null;
        pendingFocusAnchor.current = null;
        if (focusTarget === 'access' || focusTarget === 'publicLink') {
            openShare();
            if (focusTarget === 'publicLink') setOpenRowRequest({ key: 'public-link' });
            scheduleFocus(focusTarget === 'publicLink' ? publicLinkAnchor : refs.accessAnchor);
            return;
        }
        if (focusTarget === 'responsible') {
            setShareOpen(false);
            scheduleFocus(refs.responsibleAnchor);
        }
    }, [openShare, refs.accessAnchor, refs.responsibleAnchor, scheduleFocus]);

    React.useEffect(() => () => {
        if (focusHandle.current !== null) clearTimeout(focusHandle.current);
        focusHandle.current = null;
        pendingFocusAnchor.current = null;
    }, []);

    React.useEffect(() => {
        if (!pendingIntent || pendingIntent.intentId <= appliedIntentId.current) return;
        appliedIntentId.current = pendingIntent.intentId;
        const consumed = consumeSessionCollaborationIntent(target);
        if (!consumed) return;
        setHandoff(consumed);
        applyFocus(consumed.focusTarget);
    }, [applyFocus, pendingIntent, target]);

    React.useEffect(() => {
        if (!routeFocus) {
            // The canonical one-shot route mailbox has been consumed. Forget
            // only the previous handled value so a later caller may issue the
            // same exact focus request while this retained surface stays mounted.
            appliedRouteFocus.current = null;
            return;
        }
        if (routeFocus === appliedRouteFocus.current) return;
        appliedRouteFocus.current = routeFocus;
        applyFocus(routeFocus);
        // Consumed exactly like the in-process intent: the key requested this one
        // move, so it is cleared at the canonical navigation owner and cannot
        // re-apply itself on a later remount, Back, or revisit of this Session.
        consumeRouteFocus();
    }, [applyFocus, consumeRouteFocus, routeFocus]);

    // Responsibility's one controller and one responsive presentation owner are
    // created here, not in the row, because the compact host pushes its step in
    // place of this surface's body. A row-owned host could only ever open an
    // overlay above the surface it belongs to.
    const responsibilityController = useSessionResponsibilityController(props.sessionId, props.scope);
    const responsibilityPickerHost = useSessionResponsibilityPickerHost({
        sessionId: props.sessionId,
        scope: props.scope,
        actingAccountId: props.scope.accountId,
        controller: responsibilityController,
        editable: responsibilityController.availability === 'editable',
        // A Home that stops projecting responsibility, or a target that is back to
        // first load, no longer has a row to pick for: dismiss rather than leave a
        // step over a section that is not rendered.
        available: availability === 'available'
            && (responsibilityController.availability === 'editable' || responsibilityController.availability === 'read_only'),
    });

    // One exact snapshot and one publication controller for the whole pane: the access card and
    // the Share panel read the same publication, and the panel's sections share one authority.
    const snapshot = useExactSessionSnapshot(props.scope, props.sessionId);
    const session = snapshot.session;
    const externalAvailability = useExternalSessionSharingAvailability({
        serverId: props.scope.serverId,
        sessionId: props.sessionId,
        session,
        accountScopeKey: serverAccountScopeKeySuffix(props.scope),
    });
    const publicLink = useSessionCollaborationPublicLink({
        scope: props.scope,
        sessionId: props.sessionId,
        session,
        availability: externalAvailability,
        authorityCurrent: snapshot.kind === 'ready',
    });
    const homeProfile = getServerProfileById(props.scope.serverId);
    const homeName = (homeProfile ? readServerProfileHomeName(homeProfile) : null) ?? t('common.home');
    const pane = {
        scope: props.scope,
        sessionId: props.sessionId,
        target,
        refs,
        shareOpen,
        shareVisited,
        openShare: openShareFromCard,
        closeShare,
        conversationsEnabled,
        responsibility: (
            <View ref={refs.responsibleAnchor} tabIndex={-1} style={styles.responsible} testID="session-collaboration-responsible-anchor">
                <SessionResponsibilitySection controller={responsibilityController} pickerHost={responsibilityPickerHost} />
            </View>
        ),
        snapshot,
        externalAvailability,
        publicLink,
        homeName,
        handoff,
        responsibleAccountId: responsibilityController.responsibleAccountId ?? null,
        openRowRequest,
    } as const;
    return (
        <View style={styles.surface}>
            {/*
              * The compact Responsibility step replaces this body instead of
              * floating above it, and the body stays mounted but inert so
              * conversations scroll, the Share panel's drafts and focus survive the step.
              */}
            <RetainedPanelSurface
                isActive={!responsibilityPickerHost.compactStepOpen}
                testID="session-collaboration-main-panel"
            >
                {availability === 'available'
                    ? <SessionCollaborationNamedAccessPane {...pane} />
                    : <SessionCollaborationPane {...pane} access={null} namedAccess={false} />}
            </RetainedPanelSurface>
            {responsibilityPickerHost.compactStep}
        </View>
    );
}

type PaneProps = Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    target: SessionAddress;
    refs: PaneRefs;
    shareOpen: boolean;
    shareVisited: boolean;
    openShare: () => void;
    closeShare: () => void;
    conversationsEnabled: boolean;
    responsibility: React.ReactElement;
    snapshot: ExactSessionSnapshotState;
    externalAvailability: ExternalSessionSharingAvailability;
    publicLink: SessionCollaborationPublicLink;
    homeName: string;
    /** The one-shot intent this surface consumed, carried for its typed query. */
    handoff: SessionCollaborationIntent | null;
    /** Tagged on that person's access row in the Share panel. */
    responsibleAccountId: string | null;
    openRowRequest?: Readonly<{ key: string }>;
}>;

/**
 * Named access is supported: its one live controller is mounted here, for the card's summary
 * and the Share panel's editor alike.
 */
function SessionCollaborationNamedAccessPane(props: PaneProps) {
    const session = props.snapshot.session;
    const access = useLiveSessionAccessEditorController({
        scope: props.scope,
        sessionId: props.sessionId,
        metadataLayoutVersion: session ? readSessionMetadataLayoutVersion(session.metadataLayoutVersion) : null,
    });
    // The controller stays the single owner of the query; this only replays the
    // one-shot handoff into it, after the controller's own scope reset has run.
    const setQuery = access.actions.setQuery;
    const handoff = props.handoff;
    React.useEffect(() => {
        if (handoff?.query === undefined) return;
        setQuery(handoff.query);
    }, [handoff, setQuery]);
    return <SessionCollaborationPane {...props} access={access} namedAccess />;
}

function SessionCollaborationPane(props: PaneProps & Readonly<{ access: SessionAccessEditorController | null; namedAccess: boolean }>) {
    const { refs, publicLink } = props;
    const morph = useShareMorph(props.shareOpen);
    const coveredStyle = useShareMorphCoveredStyle(morph.clock, morph.coveredEnd);
    const [container, setContainer] = React.useState<Readonly<{ w: number; h: number }> | null>(null);
    const [origin, setOrigin] = React.useState<ShareMorphRect | null>(null);
    const onContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setContainer((current) => current?.w === width && current.h === height ? current : { w: width, h: height });
    }, []);
    const onCardLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { x, y, width, height } = event.nativeEvent.layout;
        setOrigin((current) => current?.x === x && current.y === y && current.w === width && current.h === height
            ? current
            : { x, y, w: width, h: height });
    }, []);
    const publicLinkOn = publicLink.publicShare !== null;
    const card = projectSessionCollaborationAccessCard({ model: props.access?.model ?? null, publicLinkOn });
    const canCreateLink = publicLink.enabled && publicLink.canManage;
    // "Just you": a Session its manager has not shared yet invites sharing where the conversations would be.
    const emptyInvite = React.useMemo(() => card.notShared ? {
        testID: 'session-collaboration-invite',
        title: t('session.collaboration.pane.justYouTitle'),
        reason: t('session.collaboration.pane.justYouBody', { home: props.homeName }),
        action: { label: t('session.collaboration.pane.share'), onPress: props.openShare },
        note: canCreateLink ? t('session.collaboration.pane.justYouNote') : undefined,
    } : undefined, [canCreateLink, card.notShared, props.homeName, props.openShare]);
    const showCard = props.namedAccess || publicLinkOn;
    const hidden = props.shareOpen;
    return (
        <View style={styles.surface} onLayout={onContainerLayout}>
            <Animated.View style={[styles.column, coveredStyle]}>
                <WebInertView
                    testID="session-collaboration-main-column"
                    style={styles.column}
                    pointerEvents={hidden ? 'none' : 'auto'}
                    inert={hidden ? true : undefined}
                    aria-hidden={hidden || undefined}
                    accessibilityElementsHidden={hidden}
                    importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
                >
                    <SessionPresenceSection serverId={props.scope.serverId} sessionId={props.sessionId} />
                    <View style={styles.body}>
                        {!props.namedAccess ? (
                            <SurfaceStateCard
                                testID="session-collaboration-sharing-off"
                                kind="unavailable"
                                iconName="users"
                                title={t('session.collaboration.pane.sharingOffTitle', { home: props.homeName })}
                                reason={canCreateLink ? t('session.collaboration.pane.sharingOffBody') : t('session.collaboration.pane.sharingOffPrivateBody')}
                                action={canCreateLink && !publicLinkOn ? { label: t('session.sharing.createPublicLink'), onPress: props.openShare } : undefined}
                            />
                        ) : props.conversationsEnabled ? (
                            <SessionConversationsBody scope={props.scope} address={props.target} emptyInvite={emptyInvite} />
                        ) : null}
                    </View>
                    {/* User ruling 2026-09-29: who has access and Responsible are one block at the foot. */}
                    {showCard ? (
                        <View onLayout={onCardLayout} testID="session-collaboration-foot">
                            <SessionCollaborationAccessCard ref={refs.card} card={card} expanded={props.shareOpen} onPress={props.openShare}>
                                {props.namedAccess ? props.responsibility : null}
                            </SessionCollaborationAccessCard>
                        </View>
                    ) : null}
                </WebInertView>
            </Animated.View>
            {props.shareVisited ? (
                <SessionShareMorphFrame
                    testID="session-collaboration-share-panel"
                    open={props.shareOpen}
                    morph={morph}
                    origin={showCard ? origin : null}
                    container={container}
                    onRequestClose={props.closeShare}
                >
                    <SessionCollaborationSharePanel {...props} />
                </SessionShareMorphFrame>
            ) : null}
        </View>
    );
}

/**
 * Share this session: the people who have access with their levels (the canonical access editor,
 * with its directory search, owner and encrypted-access line), then the public link itself. Built
 * from the same controllers the card summarizes.
 */
function SessionCollaborationSharePanel(props: PaneProps & Readonly<{ access: SessionAccessEditorController | null; namedAccess: boolean }>) {
    const { refs, snapshot } = props;
    const link = props.publicLink;
    const publicLink = link.enabled && (link.canManage ? props.externalAvailability.sharingPresentation.shareable : snapshot.session !== null) ? {
        stateLabel: !link.canManage ? t('common.unavailable') : link.publicShare !== null ? t('common.on')
            : link.hasLoaded ? t('common.off') : t('common.loading'),
        renderContent: () => <View ref={refs.publicLinkAnchor} tabIndex={-1} testID="session-collaboration-public-link-anchor">
            <SessionPublicLinkSection link={link} hasSession={snapshot.session !== null}
                shareable={props.externalAvailability.sharingPresentation.shareable} presentation="inline" />
        </View>,
    } : undefined;
    return (
        <View style={styles.panel} ref={refs.panelAnchor} tabIndex={-1} accessibilityLabel={t('session.collaboration.pane.shareTitle')}>
            <View style={styles.panelHeader}>
                <Text accessibilityRole="header" style={styles.panelTitle}>{t('session.collaboration.pane.shareTitle')}</Text>
                <IconButton
                    testID="session-collaboration-share-collapse"
                    iconName="caret-down"
                    variant="plain"
                    size={28}
                    iconSize={15}
                    accessibilityLabel={t('session.collaboration.pane.collapse')}
                    tooltip={t('session.collaboration.pane.collapse')}
                    onPress={props.closeShare}
                />
            </View>
            {props.namedAccess ? (
                <Text style={styles.panelBody}>{t('session.collaboration.pane.shareBody', { home: props.homeName })}</Text>
            ) : null}
            <SessionExternalSharingAvailabilitySection
                snapshot={snapshot}
                availability={snapshot.kind === 'ready' ? props.externalAvailability : null}
            />
            {props.access ? (
                <View ref={refs.accessAnchor} tabIndex={-1} style={styles.accessBody} testID="session-collaboration-access-body">
                    <SessionAccessEditor {...props.access} presentation="full" responsibleAccountId={props.responsibleAccountId}
                        publicLink={publicLink} openRowRequest={props.openRowRequest}
                        linkPath={buildScopedSessionRouteHref({ sessionId: props.sessionId })} testID="session-access-editor:collaboration" />
                </View>
            ) : null}
            {!props.access ? <View ref={refs.publicLinkAnchor} tabIndex={-1} style={styles.publicLink} testID="session-collaboration-public-link-anchor">
                <SessionPublicLinkSection
                    link={props.publicLink}
                    hasSession={snapshot.session !== null}
                    shareable={props.externalAvailability.sharingPresentation.shareable}
                />
            </View> : null}
            {props.access ? null : <View style={styles.spacer} />}
        </View>
    );
}
