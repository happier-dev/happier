import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

import { useMessage } from '@/sync/domains/state/storage';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
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

export const ChatListMessageRow = React.memo(function ChatListMessageRow(props: {
    sessionId: string;
    messageId: string;
    messageOverride?: Message | null;
    originSessionId?: string;
    isReadOnlyContext?: boolean;
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
    rollbackAction?: TranscriptRollbackAction | null;
    rollbackRanges: readonly SessionRollbackRangeV1[];
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    messagePins: readonly PersistedSessionMessagePinV1[];
    onToggleMessagePin: (pin: PersistedSessionMessagePinV1) => void;
} & Partial<TranscriptSessionCommonProps>) {
    const originSessionId = props.originSessionId ?? props.sessionId;
    const committedMessage = useMessage(originSessionId, props.messageId);
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
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
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
            activeThinkingMessageId={props.activeThinkingMessageId}
            thinkingExpanded={isThinking ? props.resolveThinkingExpanded(message.id) : undefined}
            onThinkingExpandedChange={isThinking ? (next) => props.setThinkingExpanded(message.id, next) : undefined}
            interaction={readOnlyInteraction}
            rollbackAction={props.rollbackAction ?? null}
            historical={historical}
            approvalRequests={props.approvalRequests}
            messagePins={props.messagePins}
            onToggleMessagePin={props.onToggleMessagePin}
            onToggleToolPin={props.onToggleMessagePin}
        />
    );
    return (
        <View testID={`${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.messageId}`}>
            <View testID={`transcript-message-${props.messageId}`}>
                {messageView}
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
    const reservedMinHeight = reservation?.minHeight;
    const shellStyle = React.useMemo(() => (
        reservedMinHeight === undefined ? undefined : { minHeight: reservedMinHeight }
    ), [reservedMinHeight]);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event?.nativeEvent?.layout?.height;
        if (typeof height === 'number' && Number.isFinite(height)) {
            const heightPx = Math.max(1, Math.trunc(height));
            props.reconciler.recordMeasuredHeight({ signature: props.signature, heightPx });
            props.onRowMeasured?.({
                itemId: props.itemId,
                rowKind: props.signature.kind,
                heightPx,
            });
        }
    }, [props.reconciler, props.itemId, props.onRowMeasured, props.signature]);

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
    const handleChildRowLayoutMutation = React.useCallback((mutation: TranscriptRowLayoutMutation) => {
        props.onRowLayoutMutation?.({
            itemId: props.itemId,
            mutation,
            rowKind: props.signature.kind,
        });
    }, [props.itemId, props.onRowLayoutMutation, props.signature.kind]);

    return (
        <TranscriptRowLayoutMutationProvider value={handleChildRowLayoutMutation}>
            <View
                testID={`${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${props.itemId}`}
                style={shellStyle}
                onLayout={handleLayout}
            >
                {props.children}
            </View>
        </TranscriptRowLayoutMutationProvider>
    );
});
