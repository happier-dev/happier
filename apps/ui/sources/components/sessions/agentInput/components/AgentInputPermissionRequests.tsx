import * as React from 'react';
import { Platform, ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
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
    | Readonly<{ kind: 'approval'; request: OpenApprovalAttentionArtifactForSession }>;

function getAttentionRequestKey(request: AttentionRequest): string {
    switch (request.kind) {
        case 'permission':
            return request.request.id;
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
}));

export const AgentInputPermissionRequests = React.memo(function AgentInputPermissionRequests(props: Readonly<{
    sessionId: string;
    permissionRequests: readonly PendingPermissionRequest[];
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
    const approvalRequests = props.approvalRequests ?? [];
    const attentionRequests = React.useMemo<AttentionRequest[]>(() => [
        ...permissionRequests.map((request) => ({ kind: 'permission' as const, request })),
        ...approvalRequests.map((request) => ({ kind: 'approval' as const, request })),
    ], [approvalRequests, permissionRequests]);
    // The request on screen when one shows at a time. Deciding it shows the one that takes its place.
    const [current, setCurrent] = React.useState<Readonly<{ key: string; index: number }> | null>(null);
    const oneAtATime = props.presentation === 'oneAtATime' && attentionRequests.length > 1;
    const currentIndex = (() => {
        if (!oneAtATime || !current) return 0;
        const held = attentionRequests.findIndex((item) => getAttentionRequestKey(item) === current.key);
        return held >= 0 ? held : Math.min(current.index, attentionRequests.length - 1);
    })();
    const shownRequests = oneAtATime ? attentionRequests.slice(currentIndex, currentIndex + 1) : attentionRequests;
    const showRequestAt = React.useCallback((index: number) => {
        const item = attentionRequests[index];
        if (item) setCurrent({ key: getAttentionRequestKey(item), index });
    }, [attentionRequests]);
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
        return resolveApprovalPromptTrayMaxHeight({
            preferredPx: props.maxHeightPx, decisionsPx, ceilingPx: props.maxHeightCeilingPx ?? null,
        });
    }, [cardHeights, props.maxHeightCeilingPx, props.maxHeightPx, shownRequests.length]);
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

    if (attentionRequests.length === 0) {
        return null;
    }

    return (
        <View style={styles.permissionRequestsContainer}>
            <View testID="agentInput.permissionRequests.chrome" style={styles.chrome}>
                <View style={{ position: 'relative' }}>
                    <ScrollView
                        testID="agentInput.permissionRequests.scroll"
                        style={scrollStyle}
                        contentContainerStyle={{ paddingBottom: TRAY_BOTTOM_INSET_PX }}
                        nestedScrollEnabled={true}
                        scrollEventThrottle={16}
                        showsVerticalScrollIndicator={false}
                        onContentSizeChange={props.onContentSizeChange}
                        onLayout={props.onLayout}
                        onScroll={props.onScroll}
                    >
                        {/* The requests share the tray: each card's facts scroll and its decision stays in view. */}
                        <ApprovalPromptRoomContext.Provider value={room}>
                        <View style={{ paddingTop: 0 }}>
                            {shownRequests.map((item, index) => (
                                <React.Fragment key={getAttentionRequestKey(item)}>
                                    {index > 0 ? (
                                        <View
                                            testID={`agentInput.permissionRequests.divider:${getAttentionRequestKey(item)}`}
                                            style={styles.divider}
                                        />
                                    ) : null}
                                    {item.kind === 'permission' ? (
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
                            ))}
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
                {/* The pager sits at the tray foot, which stays put while cards of different heights page above it. */}
                {oneAtATime ? (
                    <View testID="agentInput.permissionRequests.pager" style={styles.pager}>
                        <Text variant="meta" emphasis="medium" style={styles.pagerPosition} numberOfLines={1}>
                            {t('approvals.trayPosition', { index: currentIndex + 1, total: attentionRequests.length })}
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
                            disabled={currentIndex === attentionRequests.length - 1}
                            onPress={() => showRequestAt(currentIndex + 1)}
                        />
                    </View>
                ) : null}
            </View>
        </View>
    );
});
