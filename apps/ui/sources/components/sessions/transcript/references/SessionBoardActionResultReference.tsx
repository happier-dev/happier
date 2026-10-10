import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { useSessionCompanionController } from '@/components/sessions/companion/state/useSessionCompanionController';
import {
    buildSessionPresentationNoticeKeyPrefix,
    showSessionBoardItemInCompanion,
} from '@/components/sessions/companion/presentation/sessionCompanionPresentationAdapter';
import {
    useSessionCompanionRevealPort,
    type SessionCompanionRevealPort,
} from '@/components/sessions/companion/presentation/SessionCompanionRevealPort';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resolveSessionBoardItemTitle } from '@/components/sessions/board/sessionBoardItemPresentation';
import { SessionWidgetHost } from '@/components/sessions/board/SessionWidgetHost';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { resolveSessionBoardExecutableCurrentness } from '@/sync/domains/session/board';
import { useSessionSurfaceItem } from '@/sync/domains/session/board/useSessionSurfaceItem';
import { resolveSessionForkVisualReferenceTargetV1, type SessionForkVisualContextV1 } from '@happier-dev/protocol/sessions/board/forkVisualCopies';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';

import {
    resolveTranscriptSessionBoardItemReference,
    type TranscriptSessionBoardItemReference,
} from './transcriptSessionBoardItemReference';

/**
 * A reference, never a placement or a second content store. The exact-address
 * Session record owner supplies content independently of the Board. A mounted
 * shell may supply presentation/execution policy, but never admits this read.
 */

const INLINE_HEIGHT_BOUNDS = Object.freeze({ min: 72, max: 320 });

const stylesheet = StyleSheet.create(() => ({
    root: { gap: 8, paddingTop: 8 },
    actions: { flexDirection: 'row', flexWrap: 'wrap' },
}));

export const SessionBoardActionResultReference = React.memo(function SessionBoardActionResultReference(
    props: Readonly<{
        tool: ToolCall;
        sessionId?: string;
        /** The row's captured Home. Absent means no reference; never an ambient Home. */
        serverId?: string | null;
        contentDemand?: boolean;
        visualContext?: SessionForkVisualContextV1;
    }>,
): React.ReactElement | null {
    const address = React.useMemo(
        () => normalizeSessionAddress(props.serverId ?? null, props.sessionId ?? null),
        [props.serverId, props.sessionId],
    );
    const reference = React.useMemo(() => resolveTranscriptSessionBoardItemReference({
        toolName: props.tool.name,
        state: props.tool.state,
        input: props.tool.input,
        result: props.tool.result,
        address: props.visualContext?.originAddress ?? address,
    }), [address, props.visualContext?.originAddress, props.tool.input, props.tool.name, props.tool.result, props.tool.state]);

    // Only a row that truthfully acknowledged a Board item subscribes to anything.
    if (!reference || !address) return null;
    const childAddress = props.visualContext && address
        ? { serverId: address.serverId, sessionId: props.visualContext.sessionId } : null;
    const inherited = childAddress && (reference.address.serverId !== childAddress.serverId
        || reference.address.sessionId !== childAddress.sessionId);
    const target = inherited && props.visualContext ? resolveSessionForkVisualReferenceTargetV1({
        reference, childAddress, copies: props.visualContext.copies,
    }) : null;
    if (target?.status === 'not_copied') return (
        <View style={stylesheet.root} testID={`transcript-board-item-${reference.itemId}`}>
            <SurfaceStateCard testID={`transcript-board-item-${reference.itemId}-not-copied`}
                kind="unavailable" title={t('sessionBoard.item.notCopied.title')}
                reason={t('sessionBoard.item.notCopied.reason')} accessibilitySemantics="status" />
        </View>
    );
    if (!inherited && reference.itemDestination === 'board') return null;
    const resolved = target?.status === 'copied' ? { ...reference, address: target.address, itemId: target.itemId } : reference;
    return <MountedSessionBoardReference key={`${resolved.address.serverId}:${resolved.address.sessionId}:${resolved.itemId}`}
        reference={resolved} contentDemand={props.contentDemand !== false} />;
});

function MountedSessionBoardReference(props: Readonly<{
    reference: TranscriptSessionBoardItemReference;
    contentDemand: boolean;
}>): React.ReactElement | null {
    const styles = stylesheet;
    const { address, itemId } = props.reference;
    // Exact-address: a mounted controller for a different Home or Session answers
    // `null`, so the same local Session id on two Homes can never cross here.
    const mounted = useMountedSessionBoardController(address);
    const companionReveal = useSessionCompanionRevealPort(address);
    const binding = useSessionSurfaceItem({ ...address, itemId, enabled: props.contentDemand });
    const [retainedHeight, setRetainedHeight] = React.useState(INLINE_HEIGHT_BOUNDS.min);
    const onLayout = React.useCallback((event: Readonly<{ nativeEvent: { layout: { height: number } } }>) => {
        const height = event.nativeEvent.layout.height;
        if (height > 0) setRetainedHeight(previous => previous === height ? previous : height);
    }, []);

    const pluginRuntime = mounted?.pluginRuntime;
    const callerHostedHtmlRuntime = mounted?.callerHostedHtmlRuntime ?? null;
    const resolveSourceAvailability = mounted?.controller.resolveSourceAvailability;
    // Dispose the body and observation while retaining its last measured slot.
    // The incumbent row visibility owner decides demand; this is not a viewport.
    if (!props.contentDemand) return <View style={[styles.root, { height: retainedHeight }]}
        testID={`transcript-board-item-${itemId}`} />;

    if (binding.status === 'unavailable') {
        const retryable = binding.reason === 'offline'
            || binding.reason === 'server_error'
            || binding.reason === 'invalid_response';
        return (
            <View style={styles.root} onLayout={onLayout} testID={`transcript-board-item-${itemId}`}>
                <SurfaceStateCard
                    testID={`transcript-board-item-${itemId}-unavailable`}
                    kind="unavailable"
                    title={t('sessionBoard.board.unavailable.title')}
                    reason={t('sessionBoard.board.unavailable.reason')}
                    diagnosticCode={binding.reason}
                    accessibilitySemantics="status"
                    {...(retryable && binding.refresh
                        ? { action: { label: t('common.retry'), onPress: binding.refresh } }
                        : {})}
                />
            </View>
        );
    }

    const item = binding.item;
    if (item.state.kind === 'ready' && item.state.item.destination === 'board') return null;
    const title = resolveSessionBoardItemTitle(item.state);
    const currentness = resolveSessionBoardExecutableCurrentness({
        capabilities: { readTranscript: true, editSessionRecords: false },
        reachability: binding.reachability, freshness: binding.freshness,
        itemsById: new Map([[itemId, item]]),
    }, item, pluginRuntime);

    return (
        <View style={styles.root} onLayout={onLayout} testID={`transcript-board-item-${itemId}`}>
            {companionReveal ? (
                <MountedInlineBoardWidget
                    address={address}
                    itemId={itemId}
                    revealPort={companionReveal}
                    addAvailable={binding.reachability === 'reachable'}
                    widgetProps={{
                        sessionId: address.sessionId,
                        serverId: address.serverId,
                        item,
                        host: 'inlineTranscript',
                        primaryHost: mounted?.resolvePrimaryHost(itemId) ?? null,
                        density: 'compact',
                        canEdit: false,
                        executableCurrentness: currentness,
                        heightBounds: INLINE_HEIGHT_BOUNDS,
                        resolveSourceAvailability,
                        ...(pluginRuntime ? { pluginRuntime } : {}),
                        ...(callerHostedHtmlRuntime ? { callerHostedHtmlRuntime } : {}),
                        testID: `transcript-board-widget-${itemId}`,
                    }}
                />
            ) : (
                <SessionWidgetHost
                    sessionId={address.sessionId}
                    serverId={address.serverId}
                    item={item}
                    host="inlineTranscript"
                    primaryHost={mounted?.resolvePrimaryHost(itemId) ?? null}
                    density="compact"
                    canEdit={false}
                    executableCurrentness={currentness}
                    heightBounds={INLINE_HEIGHT_BOUNDS}
                    resolveSourceAvailability={resolveSourceAvailability}
                    {...(pluginRuntime ? { pluginRuntime } : {})}
                    {...(callerHostedHtmlRuntime ? { callerHostedHtmlRuntime } : {})}
                    testID={`transcript-board-widget-${itemId}`}
                />
            )}
            {companionReveal ? (
                <View style={styles.actions}>
                    <RoundButton
                        size="small"
                        display="inverted"
                        testID={`transcript-board-item-${itemId}-open`}
                        title={t('sessionBoard.inline.openBoard')}
                        accessibilityLabel={t('sessionBoard.inline.openBoardA11y', { title })}
                        onPress={() => companionReveal.revealBoardItem(itemId)}
                    />
                </View>
            ) : null}
        </View>
    );
}

function MountedInlineBoardWidget(props: Readonly<{
    address: TranscriptSessionBoardItemReference['address'];
    itemId: string;
    revealPort: SessionCompanionRevealPort;
    addAvailable: boolean;
    widgetProps: React.ComponentProps<typeof SessionWidgetHost>;
}>): React.ReactElement {
    const companion = useSessionCompanionController({
        sessionId: props.address.sessionId,
        serverId: props.address.serverId,
        openFullSurface: props.revealPort.openFullSurface,
    });
    const noticeKeyPrefix = React.useMemo(
        () => buildSessionPresentationNoticeKeyPrefix(props.address, props.address.sessionId),
        [props.address],
    );
    const addToCompanion = React.useCallback(() => {
        showSessionBoardItemInCompanion({
            companion,
            publishNotice: publishPresentationNotice,
            noticeKeyPrefix,
            itemId: props.itemId,
            revealAfterMutation: props.revealPort.revealAfterMutation,
        });
    }, [companion, noticeKeyPrefix, props.itemId, props.revealPort]);

    return (
        <SessionWidgetHost
            {...props.widgetProps}
            {...(props.addAvailable && companion.availability === 'ready'
                ? { onAddToCompanion: addToCompanion }
                : {})}
        />
    );
}
