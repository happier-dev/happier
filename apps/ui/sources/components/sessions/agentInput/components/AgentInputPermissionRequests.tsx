import * as React from 'react';
import { Platform, ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import { useCurrentUiContextLocalCommands, type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { ApprovalPromptCard } from '@/components/tools/shell/approvals/ApprovalPromptCard';
import { ApprovalPromptRoomContext, resolveApprovalPromptTrayMaxHeight, shareApprovalPromptRoom, type ApprovalPromptCardHeights, type ApprovalPromptRoom } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { Typography } from '@/constants/Typography';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';
import type { Metadata } from '@happier-dev/session-core/state';
import type { OpenApprovalAttentionArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { t } from '@/text';

type AttentionRequest =
    | Readonly<{ kind: 'permission'; request: PendingPermissionRequest }>
    | Readonly<{ kind: 'question'; request: PendingPermissionRequest }>
    | Readonly<{ kind: 'approval'; request: OpenApprovalAttentionArtifactForSession }>;

const NO_ATTENTION_REQUESTS: readonly AttentionRequest[] = Object.freeze([]);
const NO_PENDING_REQUESTS: readonly PendingPermissionRequest[] = Object.freeze([]);
const NO_COMMANDS: readonly CurrentUiContextLocalCommand[] = Object.freeze([]);
const EARLIER_FAILURES_COMMAND = 'earlierFailures';

/** A request still waiting for the person's decision; the rest are settled failures kept until dismissed. */
function isPendingAttentionRequest(request: AttentionRequest): boolean {
    return request.kind !== 'approval' || request.request.approval.status === 'open';
}

function getAttentionRequestKey(request: AttentionRequest): string {
    switch (request.kind) {
        case 'permission':
            return request.request.id;
        case 'question':
            return `question:${request.request.id}`;
        case 'approval':
            return `approval:${request.request.artifact.id}`;
    }
}

// The tray's own spacing, which the requests' shared height leaves room for so the cards fit without a scroll.
const TRAY_BOTTOM_INSET_PX = 2;
const TRAY_DIVIDER_PX = 1;

const stylesheet = StyleSheet.create((theme) => ({
    permissionRequestsContainer: {
        // Cancel out AgentInput's `unifiedPanel` padding so this block can go edge-to-edge.
        marginHorizontal: -8,
        // Cancel out the panel's top padding so the chrome reaches the top edge.
        marginTop: -2,
    },
    permissionRequestTitle: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'semiBold'),
    },
    chrome: {
        borderTopLeftRadius: Platform.select({ default: 16, android: 20 }),
        borderTopRightRadius: Platform.select({ default: 16, android: 20 }),
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        overflow: 'hidden',
    },
    pager: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        paddingLeft: theme.space.s16,
        paddingRight: theme.space.s8,
        paddingVertical: theme.space.s4,
        borderTopWidth: TRAY_DIVIDER_PX,
        borderTopColor: theme.colors.border.default,
    },
    pagerPosition: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    divider: {
        height: TRAY_DIVIDER_PX,
        backgroundColor: theme.colors.border.default,
        opacity: 1,
    },
    // Folded failures sit above the pending requests on screen but after them in reading and focus order.
    pendingFirst: {
        flexDirection: 'column-reverse',
    },
    earlierFailures: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 32,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s4,
        borderBottomWidth: TRAY_DIVIDER_PX,
        borderBottomColor: theme.colors.border.default,
    },
    earlierFailuresPressed: {
        opacity: 0.6,
    },
    earlierFailuresLabel: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
    },
    earlierFailuresToggle: {
        color: theme.colors.text.primary,
    },
}));

export const AgentInputPermissionRequests = React.memo(function AgentInputPermissionRequests(props: Readonly<{
    sessionId: string;
    serverId?: string;
    permissionRequests: readonly PendingPermissionRequest[];
    questionRequests?: readonly PendingPermissionRequest[];
    approvalRequests?: readonly OpenApprovalAttentionArtifactForSession[];
    permissionLocationsById: ReadonlyMap<string, PermissionToolCallMessageLocation | null>;
    approvalLocationsByArtifactId?: ReadonlyMap<string, PermissionToolCallMessageLocation | null>;
    metadata: Metadata | null;
    canApprovePermissions: boolean;
    disabledReason?: TranscriptPermissionDisabledReason;
    maxHeightPx: number;
    /** The room the rest of the composer leaves; the tray grows into it to keep its decisions whole. Null until measured. */
    maxHeightCeilingPx?: number | null;
    /**
     * `shared` (wide layouts): every request shares the tray so each decision is in view at once.
     * `oneAtATime` (a phone): the tray shows the first request whole, with a pager to the others, so a stack
     * of requests never takes the screen from the transcript nor slips a card under the input.
     */
    presentation?: 'shared' | 'oneAtATime';
    onContentSizeChange: (width: number, height: number) => void;
    onLayout: (event: LayoutChangeEvent) => void;
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    fadeVisibility?: Readonly<{ top?: boolean; bottom?: boolean }>;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const permissionRequests = props.disabledReason === 'inactive' ? [] : props.permissionRequests;
    const questionRequests = props.disabledReason === 'inactive' ? NO_PENDING_REQUESTS : props.questionRequests ?? NO_PENDING_REQUESTS;
    const approvalRequests = props.approvalRequests ?? [];
    const attentionRequests = React.useMemo<AttentionRequest[]>(() => [
        ...questionRequests.map((request) => ({ kind: 'question' as const, request })),
        ...permissionRequests.map((request) => ({ kind: 'permission' as const, request })),
        ...approvalRequests.map((request) => ({ kind: 'approval' as const, request })),
    ], [approvalRequests, permissionRequests, questionRequests]);
    // A pending request is the one thing the person must act on. While one waits, the failures settled before it
    // fold into one quiet row so its decision has the tray; they stay in the transcript where they happened, and
    // the tray lists them only when the person asks. With nothing pending, the failures are the tray, as before.
    const { pendingRequests, foldedFailures } = React.useMemo(() => {
        const pending = attentionRequests.filter(isPendingAttentionRequest);
        if (pending.length === 0 || pending.length === attentionRequests.length) {
            return { pendingRequests: attentionRequests, foldedFailures: NO_ATTENTION_REQUESTS };
        }
        return { pendingRequests: pending, foldedFailures: attentionRequests.filter((item) => !isPendingAttentionRequest(item)) };
    }, [attentionRequests]);
    // Shown for the requests now pending; a new request folds them again.
    const pendingKey = pendingRequests.map(getAttentionRequestKey).join('|');
    const [failuresShownFor, setFailuresShownFor] = React.useState<string | null>(null);
    const failuresShown = foldedFailures.length > 0 && failuresShownFor === pendingKey;
    const earlierFailuresLabel = t('approvals.earlierFailures', { count: foldedFailures.length });
    // Showing the failures puts them above the pending request; the tray then scrolls back to the request once,
    // so its decision stays in view in a short tray. Later layouts leave the person's own scroll alone.
    const trayScrollRef = React.useRef<ScrollView>(null);
    const revealPendingOnLayout = React.useRef(false);
    // The folded failures' disclosure is the composer's current-context command, so an agent can show or hide them as
    // the row does; the row's press runs the same command. Transient view state only: it decides no approval.
    const earlierFailuresCommands = useCurrentUiContextLocalCommands(React.useMemo(() => foldedFailures.length === 0 ? NO_COMMANDS : [{
        key: EARLIER_FAILURES_COMMAND,
        title: earlierFailuresLabel,
        description: 'composer.attentionRequests.earlierFailures: show ({ shown: true }) or hide ({ shown: false }) the earlier failed actions folded above the pending request.',
        invoke: (input) => {
            if (!isJsonObject(input) || typeof input.shown !== 'boolean') return false;
            revealPendingOnLayout.current = input.shown;
            setFailuresShownFor(input.shown ? pendingKey : null);
        },
    }], [earlierFailuresLabel, foldedFailures.length, pendingKey]), { contextKey: 'composer.attentionRequests', unbound: 'local' });
    const shownFailures = failuresShown ? foldedFailures : NO_ATTENTION_REQUESTS;
    // The request on screen when one shows at a time. Deciding it shows the one that takes its place.
    const [current, setCurrent] = React.useState<Readonly<{ key: string; index: number }> | null>(null);
    const oneAtATime = props.presentation === 'oneAtATime' && pendingRequests.length > 1;
    const currentIndex = (() => {
        if (!oneAtATime || !current) return 0;
        const held = pendingRequests.findIndex((item) => getAttentionRequestKey(item) === current.key);
        return held >= 0 ? held : Math.min(current.index, pendingRequests.length - 1);
    })();
    const shownPending = oneAtATime ? pendingRequests.slice(currentIndex, currentIndex + 1) : pendingRequests;
    const shownRequests = shownFailures.length > 0 ? [...shownPending, ...shownFailures] : shownPending;
    const showRequestAt = React.useCallback((index: number) => {
        const item = pendingRequests[index];
        if (item) setCurrent({ key: getAttentionRequestKey(item), index });
    }, [pendingRequests]);
    // The folded row takes its own height from the room the composer leaves the tray.
    const [earlierFailuresRowPx, setEarlierFailuresRowPx] = React.useState(0);
    const foldRowPx = foldedFailures.length > 0 ? earlierFailuresRowPx : 0;
    const onEarlierFailuresLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = Math.ceil(event.nativeEvent.layout.height);
        setEarlierFailuresRowPx((previous) => previous === height ? previous : height);
    }, []);
    // The requests share the tray: each card reports the height it wants, and the room is divided so every
    // card's decision is in view at once (the shortest keep their height; the rest split what is left).
    const [cardHeights, setCardHeights] = React.useState<ReadonlyMap<string, ApprovalPromptCardHeights>>(() => new Map());
    // The tray grows to hold every shown card's head and decision whole, within what the composer leaves.
    const trayMaxHeightPx = React.useMemo(() => {
        let decisionsPx: number | null = null;
        if (cardHeights.size === shownRequests.length && shownRequests.length > 0) {
            decisionsPx = TRAY_BOTTOM_INSET_PX + (shownRequests.length - 1) * TRAY_DIVIDER_PX;
            for (const [, card] of cardHeights) decisionsPx += card.minimum;
        }
        const ceilingPx = props.maxHeightCeilingPx ?? null;
        return resolveApprovalPromptTrayMaxHeight({
            preferredPx: Math.max(0, props.maxHeightPx - foldRowPx), decisionsPx,
            ceilingPx: ceilingPx === null ? null : Math.max(0, ceilingPx - foldRowPx),
        });
    }, [cardHeights, foldRowPx, props.maxHeightCeilingPx, props.maxHeightPx, shownRequests.length]);
    const scrollStyle = React.useMemo(() => ({ maxHeight: trayMaxHeightPx }), [trayMaxHeightPx]);
    const reportCardHeights = React.useCallback((cardId: string, heights: ApprovalPromptCardHeights | null) => setCardHeights((current) => {
        const previous = current.get(cardId);
        if (heights === null ? !previous : previous?.natural === heights.natural && previous.minimum === heights.minimum) return current;
        const next = new Map(current);
        if (heights === null) next.delete(cardId); else next.set(cardId, heights);
        return next;
    }), []);
    const room = React.useMemo<ApprovalPromptRoom>(() => {
        const available = trayMaxHeightPx - TRAY_BOTTOM_INSET_PX - (shownRequests.length - 1) * TRAY_DIVIDER_PX;
        // Until every card has reported, each gets an even part, so no decision starts out of view.
        const bounds = cardHeights.size === shownRequests.length ? shareApprovalPromptRoom(available, cardHeights) : new Map<string, number>();
        return {
            boundFor: (cardId) => bounds.get(cardId) ?? Math.floor(available / Math.max(1, shownRequests.length)),
            report: reportCardHeights,
        };
    }, [shownRequests.length, cardHeights, trayMaxHeightPx, reportCardHeights]);

    const onTrayContentSizeChange = (width: number, height: number) => {
        props.onContentSizeChange(width, height);
        // Each card reports its height after it mounts and the tray re-lays out; scroll once that has settled.
        if (!revealPendingOnLayout.current || cardHeights.size !== shownRequests.length) return;
        revealPendingOnLayout.current = false;
        trayScrollRef.current?.scrollToEnd({ animated: false });
    };

    if (attentionRequests.length === 0) {
        return null;
    }

    const renderRequest = (item: AttentionRequest, dividerAbove: boolean) => (
        <React.Fragment key={getAttentionRequestKey(item)}>
            {dividerAbove ? (
                <View
                    testID={`agentInput.permissionRequests.divider:${getAttentionRequestKey(item)}`}
                    style={styles.divider}
                />
            ) : null}
            {item.kind === 'question' ? (
                <UserActionPromptCard
                    chrome="inline"
                    request={item.request}
                    location={props.permissionLocationsById.get(item.request.id) ?? null}
                    sessionId={props.sessionId}
                    serverId={props.serverId}
                    metadata={props.metadata}
                    canApprovePermissions={props.canApprovePermissions}
                    disabledReason={props.disabledReason}
                />
            ) : item.kind === 'permission' ? (
                <PermissionPromptCard
                    chrome="inline"
                    request={item.request}
                    location={props.permissionLocationsById.get(item.request.id) ?? null}
                    sessionId={props.sessionId}
                    metadata={props.metadata}
                    canApprovePermissions={props.canApprovePermissions}
                    disabledReason={props.disabledReason}
                />
            ) : (
                <ApprovalPromptCard
                    chrome="inline"
                    artifact={item.request.artifact}
                    approval={item.request.approval}
                    location={props.approvalLocationsByArtifactId?.get(item.request.artifact.id) ?? null}
                    sessionId={props.sessionId}
                    metadata={props.metadata}
                    canApprovePermissions={props.canApprovePermissions}
                    disabledReason={props.disabledReason}
                />
            )}
        </React.Fragment>
    );
    const earlierFailuresToggle = failuresShown ? t('common.hide') : t('approvals.earlierFailuresShow');

    return (
        <View style={styles.permissionRequestsContainer}>
            <View testID="agentInput.permissionRequests.chrome" style={styles.chrome}>
                <View style={foldedFailures.length > 0 ? styles.pendingFirst : null}>
                <View style={{ position: 'relative' }}>
                    <ScrollView
                        ref={trayScrollRef}
                        testID="agentInput.permissionRequests.scroll"
                        style={scrollStyle}
                        contentContainerStyle={{ paddingBottom: TRAY_BOTTOM_INSET_PX }}
                        nestedScrollEnabled={true}
                        scrollEventThrottle={16}
                        showsVerticalScrollIndicator={false}
                        onContentSizeChange={onTrayContentSizeChange}
                        onLayout={props.onLayout}
                        onScroll={props.onScroll}
                    >
                        {/* The requests share the tray: each card's facts scroll and its decision stays in view. */}
                        <ApprovalPromptRoomContext.Provider value={room}>
                        <View style={shownFailures.length > 0 ? styles.pendingFirst : null}>
                            <View>{shownPending.map((item, index) => renderRequest(item, index > 0))}</View>
                            {/* Shown failures read after the pending requests and sit above them, each listed once. */}
                            {shownFailures.length > 0 ? (
                                <View>
                                    {shownFailures.map((item, index) => renderRequest(item, index > 0))}
                                    <View style={styles.divider} />
                                </View>
                            ) : null}
                        </View>
                        </ApprovalPromptRoomContext.Provider>
                    </ScrollView>

                    <ScrollEdgeFades
                        color={theme.colors.surface.elevated}
                        edges={{
                            top: props.fadeVisibility?.top === true,
                            bottom: props.fadeVisibility?.bottom === true,
                        }}
                    />
                    <ScrollEdgeIndicators
                        color={theme.colors.text.secondary}
                        edges={{
                            top: props.fadeVisibility?.top === true,
                            bottom: props.fadeVisibility?.bottom === true,
                        }}
                    />
                </View>
                {foldedFailures.length > 0 ? (
                    <View onLayout={onEarlierFailuresLayout}>
                        <HappierPressable
                            testID="agentInput.permissionRequests.earlierFailures"
                            accessibilityRole="button"
                            accessibilityLabel={`${earlierFailuresLabel}, ${earlierFailuresToggle}`}
                            expanded={failuresShown}
                            onPress={() => { void earlierFailuresCommands.invoke(EARLIER_FAILURES_COMMAND, { shown: !failuresShown }); }}
                            style={({ pressed }: { pressed: boolean }) => [styles.earlierFailures, pressed ? styles.earlierFailuresPressed : null]}
                        >
                            <Icon name="warning-circle" size={14} color={theme.colors.text.secondary} />
                            <Text variant="meta" style={styles.earlierFailuresLabel} numberOfLines={1}>{earlierFailuresLabel}</Text>
                            <Text variant="meta" emphasis="medium" style={styles.earlierFailuresToggle}>{earlierFailuresToggle}</Text>
                        </HappierPressable>
                    </View>
                ) : null}
                </View>
                {/* The pager sits at the tray foot, which stays put while cards of different heights page above it. */}
                {oneAtATime ? (
                    <View testID="agentInput.permissionRequests.pager" style={styles.pager}>
                        <Text variant="meta" emphasis="medium" style={styles.pagerPosition} numberOfLines={1}>
                            {t('approvals.trayPosition', { index: currentIndex + 1, total: pendingRequests.length })}
                        </Text>
                        <IconButton
                            testID="agentInput.permissionRequests.previous"
                            accessibilityLabel={t('common.previous')}
                            iconName="caret-left"
                            variant="plain"
                            size={24}
                            interactiveTargetGapPx={4}
                            disabled={currentIndex === 0}
                            onPress={() => showRequestAt(currentIndex - 1)}
                        />
                        <IconButton
                            testID="agentInput.permissionRequests.next"
                            accessibilityLabel={t('common.next')}
                            iconName="caret-right"
                            variant="plain"
                            size={24}
                            interactiveTargetGapPx={4}
                            disabled={currentIndex === pendingRequests.length - 1}
                            onPress={() => showRequestAt(currentIndex + 1)}
                        />
                    </View>
                ) : null}
            </View>
        </View>
    );
});
