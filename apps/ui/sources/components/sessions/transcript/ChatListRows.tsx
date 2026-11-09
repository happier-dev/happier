import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { TranscriptOriginSourceProvider, useTranscriptMessage } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import type { Metadata } from '@happier-dev/session-core/state';
import type { Message } from "@happier-dev/session-core/messages";
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { PersistedSessionMessagePinV1 } from "@happier-dev/session-core/pins";
import { MessageView, MessageViewWithSessionCommon } from './MessageView';
import { deriveReadOnlyTranscriptInteraction } from '@/components/sessions/transcript/forkContext/deriveReadOnlyTranscriptInteraction';
import {
    hasTranscriptSessionCommonProps,
    type TranscriptSessionCommonProps,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import {
    isMessageRolledBack,
    type SessionRollbackRangeV1,
    type TranscriptRollbackAction,
} from '@/sync/domains/sessionRollback/rollbackUiSupport';
import {
    buildTranscriptItemHeightSignatureKey,
    type TranscriptItemHeightValiditySignature,
} from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import {
    isStructuralSignatureDelta,
    type TranscriptMeasurementReconciler,
} from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import {
    TranscriptRowLayoutMutationProvider,
    type TranscriptRowLayoutMutation,
} from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { resolveTranscriptRowShellHeight } from '@/components/sessions/transcript/measurement/resolveTranscriptRowShellHeight';
import {
    TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX,
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
} from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { TranscriptEventEmphasisByMessageId } from '@/components/sessions/transcript/events/transcriptEventEmphasis';
import type { SessionForkVisualContextV1 } from '@happier-dev/protocol/sessions/board/forkVisualCopies';

export const ChatListMessageRow = React.memo(function ChatListMessageRow(props: {
    sessionId: string;
    messageId: string;
    messageOverride?: Message | null;
    originSessionId?: string;
    isReadOnlyContext?: boolean;
    visualContext?: SessionForkVisualContextV1;
    // Resolved at row render time (not materialized by the list renderItem): streaming
    // deltas mutate the message in place and only bump the revision, and the memoized
    // MessageView below re-renders on revision change. `useMessage` re-renders this row
    // per revision bump; reading through the getter here keeps the value fresh.
    getMessageRevisionById?: (messageId: string) => number | null;
    metadata: Metadata | null;
    activeThinkingMessageId: string | null;
    resolveThinkingExpanded: (messageId: string) => boolean;
    setThinkingExpanded: (messageId: string, expanded: boolean) => void;
    interaction: TranscriptInteraction;
    eventEmphasisByMessageId?: TranscriptEventEmphasisByMessageId;
    /** Set on the worker update that opens a context-only wake: how many updates woke the session. */
    hostWakeCount?: number;
    rollbackAction?: TranscriptRollbackAction | null;
    rollbackRanges: readonly SessionRollbackRangeV1[];
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    messagePins: readonly PersistedSessionMessagePinV1[];
    onToggleMessagePin: (pin: PersistedSessionMessagePinV1) => void;
    /** The row host's spacing adjustment, applied to the row's own outer box instead of a wrapper. */
    style?: StyleProp<ViewStyle>;
} & Partial<TranscriptSessionCommonProps>) {
    const originSessionId = props.originSessionId ?? props.sessionId;
    const committedMessage = useTranscriptMessage(props.messageId, originSessionId);
    const message = props.messageOverride ?? committedMessage;
    const messageRevision = props.getMessageRevisionById?.(props.messageId) ?? null;
    if (!message) return null;

    const isThinking = message.kind === 'agent-text' && message.isThinking === true;
    const readOnlyInteraction = deriveReadOnlyTranscriptInteraction(props.interaction, props.isReadOnlyContext === true);
    const historical = isMessageRolledBack({ message, rollbackRanges: props.rollbackRanges });
    const canUseParentCommon = originSessionId === props.sessionId && hasTranscriptSessionCommonProps(props);
    const messageView = canUseParentCommon ? (
        <MessageViewWithSessionCommon
            message={message}
            messageRevision={messageRevision}
            metadata={props.metadata}
            sessionId={originSessionId}
            serverId={props.toolChromeCommon?.serverId}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
            eventEmphasis={props.eventEmphasisByMessageId?.[message.id]}
            hostWakeCount={props.hostWakeCount}
            approvalRequests={props.approvalRequests}
            messagePins={props.messagePins}
            onToggleMessagePin={props.onToggleMessagePin}
            onToggleToolPin={props.onToggleMessagePin}
            forkCommon={props.forkCommon}
            messageDisplayCommon={props.messageDisplayCommon}
            toolChromeCommon={props.toolChromeCommon}
            toolRouteCommon={props.toolRouteCommon}
        />
    ) : (
        <MessageView
            message={message}
            messageRevision={messageRevision}
            metadata={props.metadata}
            sessionId={originSessionId}
            serverId={props.toolChromeCommon?.serverId}
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
            eventEmphasis={props.eventEmphasisByMessageId?.[message.id]}
            hostWakeCount={props.hostWakeCount}
            approvalRequests={props.approvalRequests}
            messagePins={props.messagePins}
            onToggleMessagePin={props.onToggleMessagePin}
            onToggleToolPin={props.onToggleMessagePin}
        />
    );
    return (
        <View testID={`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.messageId}`} style={props.style}>
            <View testID={`transcript-message-${props.messageId}`}>
                <TranscriptOriginSourceProvider originSessionId={originSessionId} readOnly={props.isReadOnlyContext === true} visualContext={props.visualContext}>
                    {messageView}
                </TranscriptOriginSourceProvider>
            </View>
        </View>
    );
});

export const TranscriptRowShell = React.memo(function TranscriptRowShell(props: Readonly<{
    reconciler: TranscriptMeasurementReconciler;
    children: React.ReactNode;
    itemId: string;
    onRowLayoutMutation?: (params: Readonly<{
        itemId: string;
        mutation: TranscriptRowLayoutMutation;
        rowKind: string;
    }>) => void;
    onRowMeasured?: (params: Readonly<{ itemId: string; rowKind: string; heightPx: number }>) => void;
    signature: TranscriptItemHeightValiditySignature;
}>) {
    const signatureKey = React.useMemo(
        () => buildTranscriptItemHeightSignatureKey(props.signature),
        [props.signature],
    );
    const lastSignatureKeyRef = React.useRef(signatureKey);
    const lastSignatureRef = React.useRef(props.signature);
    const previousSignatureForReservation =
        lastSignatureKeyRef.current === signatureKey ? undefined : lastSignatureRef.current;
    const reservation = resolveTranscriptRowShellHeight({
        previousSignature: previousSignatureForReservation,
        reconciler: props.reconciler,
        signature: props.signature,
    });
    // Row-local collapsibles change the painted height without changing the row signature. Once a
    // local mutation occurs, the mounted row's natural content is authoritative and all subsequent
    // layouts are ignored for reservation purposes until the row remounts in its collapsed state.
    const [hasRowLocalLayoutMutation, setHasRowLocalLayoutMutation] = React.useState(false);
    const [hasContentLayoutMutation, setHasContentLayoutMutation] = React.useState(false);
    // The signature whose reservation the reconciler corrected from natural content (see
    // `handleContentLayout`): reserving it again would only repaint the stale gap.
    const [contradictedSignatureKey, setContradictedSignatureKey] = React.useState<string | null>(null);
    const latestSignatureRef = React.useRef(props.signature);
    latestSignatureRef.current = props.signature;
    const reservedMinHeight = hasRowLocalLayoutMutation || hasContentLayoutMutation || contradictedSignatureKey === signatureKey
        ? undefined
        : reservation?.minHeight;
    const shellStyle = React.useMemo(() => (
        reservedMinHeight === undefined ? undefined : { minHeight: reservedMinHeight }
    ), [reservedMinHeight]);

    // The shell's `minHeight` is applied to the very node this layout would measure, so the shell can
    // only read its own reservation back: recording it would make a stale cached height permanent. The
    // row's measurement is its natural content, taken from the child wrapper below.
    const [naturalLayout, setNaturalLayout] = React.useState<Readonly<{ heightPx: number }> | null>(null);
    const handleContentLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event?.nativeEvent?.layout?.height;
        if (typeof height === 'number' && Number.isFinite(height)) setNaturalLayout({ heightPx: Math.max(1, Math.trunc(height)) });
    }, []);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event?.nativeEvent?.layout?.height;
        if (typeof height === 'number' && Number.isFinite(height)) {
            setHasContentLayoutMutation(false);
            props.onRowMeasured?.({
                itemId: props.itemId,
                rowKind: props.signature.kind,
                heightPx: Math.max(1, Math.trunc(height)),
            });
        }
    }, [props.itemId, props.onRowMeasured, props.signature.kind]);

    React.useLayoutEffect(() => {
        if (lastSignatureKeyRef.current === signatureKey) return;
        const previousSignature = lastSignatureRef.current;
        lastSignatureKeyRef.current = signatureKey;
        lastSignatureRef.current = props.signature;
        if (isStructuralSignatureDelta(previousSignature, props.signature)) {
            props.reconciler.resetReservationForStructuralChange({
                itemId: props.itemId,
                signature: props.signature,
            });
        }
        props.onRowLayoutMutation?.({
            itemId: props.itemId,
            mutation: {
                reason: 'signature-change',
                sourceId: props.itemId,
                previousSignature,
                nextSignature: props.signature,
            },
            rowKind: props.signature.kind,
        });
    }, [props.onRowLayoutMutation, props.reconciler, props.itemId, signatureKey, props.signature]);
    // A layout is committed from here, under the signature current with it, rather than from the layout
    // callback: a resize lays rows out before the width bucket in their signature moves, and a callback
    // would file the new width's height under the old one. A signature change alone commits nothing, as
    // the content may not have been laid out at the new geometry yet; the next real layout does.
    const committedNaturalLayoutRef = React.useRef<typeof naturalLayout>(null);
    React.useLayoutEffect(() => {
        const layoutArrived = committedNaturalLayoutRef.current !== naturalLayout;
        committedNaturalLayoutRef.current = naturalLayout;
        if (naturalLayout === null || hasRowLocalLayoutMutation) return;
        if (layoutArrived) {
            props.reconciler.recordMeasuredHeight({ signature: props.signature, heightPx: naturalLayout.heightPx });
        }
        // Natural content refutes a taller exact cache entry. Also release a floor the measurement
        // owner just corrected downward after a structural reset. Content need not emit another
        // layout, so apply that correction in this commit too. Legitimate peak holds stay owned
        // by the reconciler; the shell does not independently decide when they end.
        if (reservation && naturalLayout.heightPx < reservation.minHeight
            && (reservation.kind === 'exact'
                || props.reconciler.resolveReservation(props.signature)?.minHeight === naturalLayout.heightPx)) {
            setContradictedSignatureKey(signatureKey);
        }
    }, [hasRowLocalLayoutMutation, naturalLayout, props.reconciler, props.signature, reservation, signatureKey]);
    const handleChildRowLayoutMutation = React.useCallback((mutation: TranscriptRowLayoutMutation) => {
        if (mutation.reason === 'collapse' || mutation.reason === 'content-change') {
            props.reconciler.resetReservationForStructuralChange({
                itemId: props.itemId,
                signature: latestSignatureRef.current,
                invalidateExact: mutation.reason === 'content-change' || !hasRowLocalLayoutMutation,
            });
        }
        if (mutation.reason === 'content-change') setHasContentLayoutMutation(true);
        else setHasRowLocalLayoutMutation(true);
        props.onRowLayoutMutation?.({
            itemId: props.itemId,
            mutation,
            rowKind: props.signature.kind,
        });
    }, [hasRowLocalLayoutMutation, props.itemId, props.onRowLayoutMutation, props.reconciler, props.signature.kind]);

    return (
        <TranscriptRowLayoutMutationProvider value={handleChildRowLayoutMutation}>
            <View
                testID={`${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.itemId}`}
                style={shellStyle}
                onLayout={handleLayout}
            >
                <View testID={`transcript-row-content-${props.itemId}`} onLayout={handleContentLayout}>
                    {props.children}
                </View>
            </View>
        </TranscriptRowLayoutMutationProvider>
    );
});
