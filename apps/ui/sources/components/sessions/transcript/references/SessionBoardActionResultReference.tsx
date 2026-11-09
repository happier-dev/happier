import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { useSessionCompanionController } from '@/components/sessions/companion/state/useSessionCompanionController';
import { buildSessionPresentationNoticeKeyPrefix } from '@/components/sessions/companion/presentation/sessionCompanionPresentationAdapter';
import { showSessionCompanionItem } from '@/components/sessions/companion/presentation/sessionCompanionHumanAction';
import {
    useSessionCompanionRevealPort,
    type SessionCompanionRevealPort,
} from '@/components/sessions/companion/presentation/SessionCompanionRevealPort';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resolveSessionBoardItemTitle } from '@/components/sessions/board/sessionBoardItemPresentation';
import { SESSION_BOARD_SEMANTIC_HEIGHTS } from '@/components/sessions/board/sessionBoardItemHeight';
import { SessionWidgetHost } from '@/components/sessions/board/SessionWidgetHost';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { useSessionVisualPresentationActive } from '@/components/sessions/board/useSessionVisualPresentationActive';
import { useSessionSurfaceItem } from '@/sync/domains/session/board/useSessionSurfaceItem';
import { resolveSessionForkVisualReferenceTargetV1, type SessionForkVisualContextV1 } from '@happier-dev/protocol/sessions/board/forkVisualCopies';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { storage } from '@/sync/domains/state/storage';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { useTranscriptRowSeq } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';
import type { SessionVisualNetworkChoice } from '@/components/sessions/board/sessionBoardVisualNetwork';
import { runAcknowledgedWidgetSetupCommand } from '@/components/widgets/surface/widgetSurfaceSetup';

import {
    resolveTranscriptSessionBoardItemReference,
    type TranscriptSessionBoardItemReference,
} from './transcriptSessionBoardItemReference';

/**
 * A reference, never a placement or a second content store. The exact-address
 * Session record owner supplies content independently of the Board. A mounted
 * shell may supply presentation/execution policy, but never admits this read.
 */

const stylesheet = StyleSheet.create(() => ({
    root: { paddingTop: 8 },
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
    const inherited = childAddress && (!areServerProfileIdentifiersEquivalent(reference.address.serverId, childAddress.serverId)
        || reference.address.sessionId !== childAddress.sessionId);
    const target = inherited && props.visualContext ? resolveSessionForkVisualReferenceTargetV1({
        reference, childAddress, copies: props.visualContext.copies, resolveServerScopeId: resolveServerProfileScopeIdForIdentifier,
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
    return <MountedSessionBoardReference key={JSON.stringify([resolved.address.serverId, resolved.address.sessionId, resolved.itemId])}
        reference={resolved} contentDemand={props.contentDemand !== false} />;
});

/**
 * The live occurrence for an already-recognized reference. An approved Ask call reaches it through
 * its approval card with the same reference the Allowed call resolves, so both read as one visual.
 */
export const SessionBoardItemReferenceOccurrence = React.memo(function SessionBoardItemReferenceOccurrence(props: Readonly<{
    reference: TranscriptSessionBoardItemReference;
    contentDemand?: boolean;
}>): React.ReactElement | null {
    if (props.reference.itemDestination === 'board') return null;
    const { address, itemId } = props.reference;
    return <MountedSessionBoardReference key={JSON.stringify([address.serverId, address.sessionId, itemId])}
        reference={props.reference} contentDemand={props.contentDemand !== false} />;
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
    const presented = useSessionVisualPresentationActive();
    const contentDemand = props.contentDemand && presented;
    const binding = useSessionSurfaceItem({ ...address, itemId, enabled: contentDemand });
    // Before this reply was ever measured its footprint is the smallest declared size.
    const repository = getSyncSingleton().readSessionSystemRecordObservation(address)?.repository;
    const measurements = repository?.readSurfaceItemMeasurements(address, itemId);
    const savedHeight = measurements?.reply;
    const [intrinsicHeight, setIntrinsicHeight] = React.useState<number | undefined>(measurements?.['intrinsic:inlineTranscript']);
    const [retainedHeight, setRetainedHeight] = React.useState<number>(savedHeight ?? SESSION_BOARD_SEMANTIC_HEIGHTS.compact);
    const [reservedHeight, setReservedHeight] = React.useState<number | undefined>(savedHeight);
    const reportLayoutMutation = useTranscriptRowLayoutMutation();
    const onIntrinsicHeightChange = React.useCallback((height: number) => {
        repository?.reportSurfaceItemMeasurement(address, itemId, 'intrinsic:inlineTranscript', height);
        setIntrinsicHeight(height);
        setReservedHeight(undefined);
        reportLayoutMutation({ reason: 'content-change', sourceId: `visual:${itemId}` });
    }, [address, itemId, reportLayoutMutation, repository]);
    const onLayout = React.useCallback((event: Readonly<{ nativeEvent: { layout: { height: number } } }>) => {
        const height = event.nativeEvent.layout.height;
        if (Number.isFinite(height) && height > 0) {
            setRetainedHeight(previous => previous === height ? previous : height);
            repository?.reportSurfaceItemMeasurement(address, itemId, 'reply', height);
        }
    }, [address, itemId, repository]);

    const pluginRuntime = mounted?.pluginRuntime;
    const callerHostedHtmlRuntime = mounted?.callerHostedHtmlRuntime ?? null;
    const resolveSourceAvailability = mounted?.controller.resolveSourceAvailability;
    const occurrence = React.useId();
    const transcriptSeq = useTranscriptRowSeq();
    const readyItem = binding.status !== 'unavailable' && binding.item.state.kind === 'ready'
        ? binding.item.state.item : null;
    const candidate = contentDemand && readyItem !== null && readyItem.destination !== 'board';
    const reportInlineTranscriptDemand = mounted?.reportInlineTranscriptDemand;
    React.useEffect(() => (
        candidate && reportInlineTranscriptDemand ? reportInlineTranscriptDemand(itemId, occurrence, transcriptSeq) : undefined
    ), [candidate, itemId, occurrence, reportInlineTranscriptDemand, transcriptSeq]);
    // Pin, Edit, Network access and Delete on this reply read the Session's Board facts (placement,
    // edit capability, revisions); the reply demands that inventory only while its menu or a flow is open.
    const acquireBoardContent = mounted?.acquireContent;
    // Whether this viewer may edit is the Session's own access fact, the same one the Board's facts carry, so the
    // menu can hold the editor rows in place (disabled) while those facts load instead of inserting them later.
    const viewerMayEdit = storage(state => {
        const session = state.sessions[address.sessionId];
        return session?.access?.capabilities.editSessionRecords === true
            && areServerProfileIdentifiersEquivalent(session.serverId, address.serverId);
    });
    const bodyActive = mounted ? mounted.resolveInlineTranscriptOccurrence(itemId) === occurrence : true;
    // Dispose the body and observation while retaining its last measured slot.
    // The incumbent row visibility owner decides demand; this is not a viewport.
    if (!contentDemand) return <View style={[styles.root, { height: retainedHeight }]}
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
    // The panel is the item's own expanded destination, opened through the Session presentation
    // owner: the full body has room there and may scroll; the reply never does.
    const openInPanel = companionReveal ? (
        <IconButton
            testID={`transcript-board-item-${itemId}-open`}
            iconName="arrows-out"
            variant="plain"
            accessibilityLabel={t('sessionBoard.inline.openPanelA11y', { title })}
            tooltip={t('sessionBoard.inline.openPanel')}
            onPress={() => {
                companionReveal.revealBoardItem(itemId);
            }}
        />
    ) : null;
    // Other occurrences of this item offer "Show here" through the same presentation Action.
    const showHere = companionReveal?.showItemInChat && !bodyActive
        ? () => companionReveal.showItemInChat?.(itemId, occurrence)
        : undefined;
    // Pin is the Board layout owner's existing `item.pin` command on this same item. It is offered
    // only while no Board view places the item; Unpin stays on the Board card that shows it.
    const boardController = mounted?.controller;
    const placedOnBoard = boardController?.snapshot?.views
        .some(view => view.placements.some(placement => placement.itemId === itemId)) ?? false;
    const pinToBoard = boardController && !placedOnBoard && boardController.supports('item.pin')
        ? () => { void boardController.run({ kind: 'item.pin', itemId }); }
        : undefined;
    // The reply is an occurrence of the shared item, so an editor changes or deletes it from here through the
    // same Board commands (AUDIT-B B-01); the editor itself lives in the Board panel, which Edit opens.
    const canEditItem = boardController?.snapshot?.canEdit === true;
    const removeItem = boardController && canEditItem && boardController.supports('item.remove')
        ? () => { void boardController.run({ kind: 'item.remove', itemId }); }
        : undefined;
    const setNetwork = boardController && canEditItem && boardController.supports('item.network')
        ? (network: SessionVisualNetworkChoice) => runAcknowledgedWidgetSetupCommand(
            () => boardController.run({ kind: 'item.network', itemId, network }),
            t('sessionBoard.item.network.failed'),
        )
        : undefined;
    const boardFactsPending = viewerMayEdit && boardController !== undefined
        && (boardController.snapshot?.loading ?? 'initial') === 'initial';
    const editItem = boardController && canEditItem && companionReveal && boardController.supportsItemEdit(itemId)
        ? () => { companionReveal.revealBoardItem(itemId); void boardController.run({ kind: 'item.edit', itemId }); }
        : undefined;
    const widgetProps: React.ComponentProps<typeof SessionWidgetHost> = {
        sessionId: address.sessionId,
        serverId: address.serverId,
        item,
        host: 'inlineTranscript',
        bodyActive,
        density: 'compact',
        frame: 'reply',
        canEdit: canEditItem,
        onIntrinsicHeightChange,
        reportedHeight: intrinsicHeight,
        resolveSourceAvailability,
        ...(openInPanel ? { headerAccessory: openInPanel } : {}),
        ...(showHere ? { onOpenHere: showHere, openActionLabel: t('sessionBoard.inline.showHere') } : {}),
        ...(pinToBoard ? { onPinToBoard: pinToBoard } : {}),
        ...(boardFactsPending ? { boardFactsPending } : {}),
        ...(editItem ? { onEdit: editItem } : {}),
        ...(setNetwork ? { onSetNetwork: setNetwork } : {}),
        ...(removeItem ? { onRemove: removeItem } : {}),
        ...(acquireBoardContent ? { acquireMenuContent: acquireBoardContent } : {}),
        ...(pluginRuntime ? { pluginRuntime } : {}),
        ...(callerHostedHtmlRuntime ? { callerHostedHtmlRuntime } : {}),
        testID: `transcript-board-widget-${itemId}`,
    };

    return (
        <View style={[styles.root, { minHeight: reservedHeight }]} onLayout={onLayout} testID={`transcript-board-item-${itemId}`}>
            {companionReveal ? (
                <MountedInlineBoardWidget
                    address={address}
                    itemId={itemId}
                    revealPort={companionReveal}
                    addAvailable={binding.reachability === 'reachable'}
                    widgetProps={widgetProps}
                />
            ) : (
                <SessionWidgetHost {...widgetProps} />
            )}
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
        return showSessionCompanionItem({
            address: props.address,
            companion,
            publishNotice: publishPresentationNotice,
            noticeKeyPrefix,
            item: { kind: 'widget', widgetId: props.itemId },
            revealAfterMutation: props.revealPort.revealAfterMutation,
        });
    }, [companion, noticeKeyPrefix, props.address, props.itemId, props.revealPort]);

    return (
        <SessionWidgetHost
            {...props.widgetProps}
            {...(props.addAvailable && companion.availability === 'ready'
                ? { onAddToCompanion: addToCompanion }
                : {})}
        />
    );
}
