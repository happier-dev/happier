import * as React from 'react';
import { findNodeHandle, Platform, View } from 'react-native';
import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import { ChatFooter } from '@/components/sessions/transcript/ChatFooter';
import type { Message } from "@happier-dev/session-core/messages";
import type { Metadata } from '@happier-dev/session-core/state';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    TRANSCRIPT_TOP_GUTTER_PX,
} from '@/components/sessions/transcript/_constants';
import {
    mapTranscriptListIndexBetweenOrders,
    orientTranscriptListItems,
} from '@/components/sessions/transcript/listOrientation';
import { OlderLoadProgressOverlay } from '@/components/sessions/transcript/OlderLoadProgressOverlay';
import { OlderLoadRetryOverlay } from '@/components/sessions/transcript/OlderLoadRetryOverlay';
import {
    useTranscriptShellOlderPagination,
} from '@/components/sessions/transcript/pagination/useTranscriptShellOlderPagination';
import { deriveTranscriptForkCommonForInteraction, useTranscriptSessionCommon } from '@/components/sessions/transcript/transcriptSessionCommon';
import { useOptionalTranscriptSelectionState } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { TranscriptListShell } from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import { resolveReadOnlyTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import { resolveTranscriptListShellEdgeSlots } from '@/components/sessions/transcript/viewport/shell/transcriptListShellEdgeSlots';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { useTranscriptMotionConfig } from '@/components/sessions/transcript/motion/useTranscriptMotionConfig';
import { TranscriptRowLayoutMutationProvider } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { useRendererOwnedTranscriptRowLayoutMutation } from '@/components/sessions/transcript/viewport/shell/useRendererOwnedTranscriptRowLayoutMutation';
import {
    focusRegisteredWebTranscriptKeyboardViewport,
    registerWebTranscriptKeyboardOwner,
    type WebTranscriptKeyboardVerticalDirection,
} from '@/components/sessions/transcript/viewport/lifecycle/webTranscriptKeyboardOwner';
import { focusNativeAccessibilityTarget } from '@/keyboard/focusReturn';
import type {
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol/sessions/external/operationV1';
import {
    ExternalSessionOperationSharedCard,
} from '@/components/sessions/external/progress/ExternalSessionOperationSharedCard';
import {
    readExternalSessionOperationPresentationFromMetadata,
} from '@/components/sessions/transcript/items/externalSessionOperationMetadata';
import {
    useExternalSessionOperationTranscriptDismissal,
} from '@/components/sessions/transcript/items/useExternalSessionOperationTranscriptDismissal';
import type {
    ExternalSessionOperationActionRef,
} from '@/components/sessions/external/progress/ExternalImportProgressCard';
import { useSessionTranscriptSource } from './source/SessionTranscriptSourceContext';

export type TranscriptBottomNotice = {
    title: string;
    body: string;
};

const EMPTY_THINKING_EXPANSION_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

const ListHeader = React.memo((props: { isLoading?: boolean }) => {
    return (
        <View>
            {props.isLoading ? (
                <View style={{ paddingVertical: 12 }}>
                    <ActivitySpinner size="small" />
                </View>
            ) : null}
            <View style={{ height: TRANSCRIPT_TOP_GUTTER_PX }} />
        </View>
    );
});

const ListFooter = React.memo((props: {
    bottomNotice?: TranscriptBottomNotice | null;
    externalSessionOperationPresentation:
        ExternalSessionOperationSharedPresentationV1 | null;
    onDismissExternalSessionOperation:
        (actionRef: ExternalSessionOperationActionRef) => void;
}) => {
    return (
        <View>
            {props.externalSessionOperationPresentation ? (
                <ExternalSessionOperationSharedCard
                    presentation={props.externalSessionOperationPresentation}
                    onDismiss={props.onDismissExternalSessionOperation}
                />
            ) : null}
            <ChatFooter
                notice={props.bottomNotice ?? null}
                controlledByUser={false}
            />
        </View>
    );
});

export const TranscriptList = React.memo((props: {
    datasetKey: string;
    metadata: Metadata | null;
    messages: Message[];
    bottomNotice?: TranscriptBottomNotice | null;
}) => {
    const source = useSessionTranscriptSource();
    const sessionId = source.sessionId;
    const interaction = source.useInteraction();
    const historyState = source.history.useState();
    const transcriptSessionCommon = useTranscriptSessionCommon();
    const { motionConfig } = useTranscriptMotionConfig();
    const webDomObservation = React.useMemo(() => createWebDomScrollObservation(), []);
    const {
        listRef,
        prepareRowLayoutMutation,
    } = useRendererOwnedTranscriptRowLayoutMutation<Message>();
    const transcriptViewportFocusRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const forkCommon = React.useMemo(
        () => deriveTranscriptForkCommonForInteraction(transcriptSessionCommon.fork, interaction),
        [interaction, transcriptSessionCommon.fork],
    );
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const externalSessionOperationPresentation = React.useMemo(
        () => readExternalSessionOperationPresentationFromMetadata(
            props.metadata,
        ),
        [props.metadata],
    );
    const {
        dismissal: externalSessionOperationDismissal,
        onDismiss: onDismissExternalSessionOperation,
    } = useExternalSessionOperationTranscriptDismissal({
        sessionId: sessionId,
        presentation: externalSessionOperationPresentation,
    });
    const visibleExternalSessionOperationPresentation =
        externalSessionOperationPresentation
        && externalSessionOperationDismissal?.sessionId === sessionId
        && externalSessionOperationDismissal.operationId
            === externalSessionOperationPresentation.operationId
        && externalSessionOperationDismissal.revision
            === externalSessionOperationPresentation.revision
            ? null
            : externalSessionOperationPresentation;
    const sessionThinkingDisplayMode = transcriptSessionCommon.messageDisplay.sessionThinkingDisplayMode;
    const sessionThinkingInlinePresentation = transcriptSessionCommon.messageDisplay.sessionThinkingInlinePresentation;
    const shellFrame = React.useMemo(() => resolveReadOnlyTranscriptListShellFrame({
        accessKind: 'public',
        bottomNoticeVisible: props.bottomNotice != null,
        platformOS: Platform.OS,
    }), [props.bottomNotice]);
    const resolveWebKeyboardScroller = React.useCallback((): HTMLElement | null => {
        const rendererNode = listRef.current?.getScrollableNode?.();
        return typeof HTMLElement !== 'undefined' && rendererNode instanceof HTMLElement
            ? rendererNode
            : null;
    }, []);
    const returnFocusToTranscriptViewport = React.useCallback(() => {
        if (Platform.OS === 'web') {
            const scroller = resolveWebKeyboardScroller();
            if (scroller && typeof document !== 'undefined') {
                focusRegisteredWebTranscriptKeyboardViewport({ document, scroller });
            }
            return;
        }
        const nativeTarget = findNodeHandle(transcriptViewportFocusRef.current);
        if (typeof nativeTarget === 'number') {
            focusNativeAccessibilityTarget(nativeTarget);
        }
    }, [resolveWebKeyboardScroller]);
    const recordWebKeyboardViewportInput = React.useCallback((
        verticalDirection: WebTranscriptKeyboardVerticalDirection,
    ): void => {
        listRef.current?.notifyViewportInput?.({ kind: 'keyboard', verticalDirection });
    }, []);
    React.useEffect(() => {
        if (shellFrame.platform !== 'web' || typeof document === 'undefined') return;
        return registerWebTranscriptKeyboardOwner({
            document,
            onViewportKeyboardInput: recordWebKeyboardViewportInput,
            resolveScroller: resolveWebKeyboardScroller,
        });
    }, [
        recordWebKeyboardViewportInput,
        resolveWebKeyboardScroller,
        shellFrame.platform,
    ]);
    const pendingExternalSessionOperationDismissalRef = React.useRef<Readonly<{
        operationId: string;
        revision: number;
        sessionId: string;
    }> | null>(null);
    const dismissExternalSessionOperationWithFocus = React.useCallback((
        actionRef: ExternalSessionOperationActionRef,
    ) => {
        pendingExternalSessionOperationDismissalRef.current = {
            ...actionRef,
            sessionId: sessionId,
        };
        onDismissExternalSessionOperation(actionRef);
    }, [onDismissExternalSessionOperation, sessionId]);
    React.useLayoutEffect(() => {
        const pendingDismissal = pendingExternalSessionOperationDismissalRef.current;
        if (pendingDismissal === null) return;
        if (pendingDismissal.sessionId !== sessionId) {
            pendingExternalSessionOperationDismissalRef.current = null;
            return;
        }
        if (visibleExternalSessionOperationPresentation !== null) {
            if (
                visibleExternalSessionOperationPresentation.operationId
                    !== pendingDismissal.operationId
                || visibleExternalSessionOperationPresentation.revision
                    !== pendingDismissal.revision
            ) {
                pendingExternalSessionOperationDismissalRef.current = null;
            }
            return;
        }
        pendingExternalSessionOperationDismissalRef.current = null;
        returnFocusToTranscriptViewport();
    }, [
        sessionId,
        returnFocusToTranscriptViewport,
        visibleExternalSessionOperationPresentation,
    ]);
    const listData = React.useMemo(() => {
        if (shellFrame.dataOrder === 'newest-first') {
            return [...props.messages].reverse();
        }
        return orientTranscriptListItems(props.messages, 'standard');
    }, [props.messages, shellFrame.dataOrder]);
    const listOrientation = shellFrame.dataOrder === 'newest-first' ? 'inverted' : 'standard';
    const messageCountRef = React.useRef(props.messages.length);
    messageCountRef.current = props.messages.length;
    const olderPagination = useTranscriptShellOlderPagination({
        datasetKey: props.datasetKey,
        dataOrder: shellFrame.dataOrder,
        listRef,
        loadOlder: source.history.loadOlder ?? undefined,
        readCanonicalItemCount: () => messageCountRef.current,
        readRenderedItemCount: () => messageCountRef.current,
        readSourceIndexForRenderedIndex: (renderedIndex: number) =>
            mapTranscriptListIndexBetweenOrders(
                renderedIndex,
                messageCountRef.current,
                listOrientation,
            ),
        sessionId: sessionId,
    });
    const shellEdgeSlots = React.useMemo(() => resolveTranscriptListShellEdgeSlots({
        frame: shellFrame,
        visualTopNode: <ListHeader isLoading={historyState.isLoaded === false} />,
        visualBottomNode: (
            <ListFooter
                bottomNotice={props.bottomNotice ?? null}
                externalSessionOperationPresentation={
                    visibleExternalSessionOperationPresentation
                }
                onDismissExternalSessionOperation={
                    dismissExternalSessionOperationWithFocus
                }
            />
        ),
    }), [
        dismissExternalSessionOperationWithFocus,
        props.bottomNotice,
        historyState.isLoaded,
        shellFrame,
        visibleExternalSessionOperationPresentation,
    ]);

    const thinkingDefaultExpanded =
        sessionThinkingDisplayMode === 'inline' && sessionThinkingInlinePresentation === 'full';
    const [thinkingExpansionState, setThinkingExpansionState] = React.useState<Readonly<{
        datasetKey: string;
        values: ReadonlyMap<string, boolean>;
    }>>(() => ({
        datasetKey: props.datasetKey,
        values: EMPTY_THINKING_EXPANSION_OVERRIDES,
    }));
    const thinkingExpandedByMessageId = thinkingExpansionState.datasetKey === props.datasetKey
        ? thinkingExpansionState.values
        : EMPTY_THINKING_EXPANSION_OVERRIDES;
    const resolveThinkingExpanded = React.useCallback((messageId: string): boolean => {
        return thinkingExpandedByMessageId.get(messageId) ?? thinkingDefaultExpanded;
    }, [thinkingDefaultExpanded, thinkingExpandedByMessageId]);
    const setThinkingExpanded = React.useCallback((messageId: string, expanded: boolean) => {
        if (resolveThinkingExpanded(messageId) !== expanded) {
            prepareRowLayoutMutation({
                reason: expanded ? 'expand' : 'collapse',
                sourceId: messageId,
            });
        }
        setThinkingExpansionState((prev) => {
            const prevValues = prev.datasetKey === props.datasetKey
                ? prev.values
                : EMPTY_THINKING_EXPANSION_OVERRIDES;
            const prevValue = prevValues.get(messageId);
            if (prev.datasetKey === props.datasetKey && prevValue === expanded) return prev;
            const next = new Map(prevValues);
            if (expanded === thinkingDefaultExpanded) {
                next.delete(messageId);
            } else {
                next.set(messageId, expanded);
            }
            return {
                datasetKey: props.datasetKey,
                values: next,
            };
        });
    }, [
        prepareRowLayoutMutation,
        props.datasetKey,
        resolveThinkingExpanded,
        thinkingDefaultExpanded,
    ]);

    const keyExtractor = React.useCallback((item: Message) => item.id, []);
    const getItemType = React.useCallback((item: Message): string => item.kind, []);
    const renderItem = React.useCallback(({ item }: { item: Message }) => {
        const controlledThinking =
            item.kind === 'agent-text' &&
            item.isThinking === true &&
            sessionThinkingDisplayMode === 'inline';
        return (
            <MessageViewWithSessionCommon
                message={item}
                metadata={props.metadata}
                sessionId={sessionId}
                interaction={interaction}
                forkCommon={forkCommon}
                messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                toolChromeCommon={transcriptSessionCommon.toolChrome}
                toolRouteCommon={transcriptSessionCommon.toolRoute}
                thinkingExpanded={controlledThinking ? resolveThinkingExpanded(item.id) : undefined}
                onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(item.id, next) : undefined}
            />
        );
    }, [
        interaction,
        props.metadata,
        sessionId,
        resolveThinkingExpanded,
        sessionThinkingDisplayMode,
        setThinkingExpanded,
        forkCommon,
        transcriptSessionCommon.messageDisplay,
        transcriptSessionCommon.toolChrome,
        transcriptSessionCommon.toolRoute,
    ]);

    return (
        <TranscriptMotionProvider key={props.datasetKey} sessionKey={props.datasetKey} config={motionConfig}>
            <TranscriptRowLayoutMutationProvider value={prepareRowLayoutMutation}>
                <View ref={transcriptViewportFocusRef} style={{ flex: 1 }}>
                    <TranscriptListShell<Message>
                        key={props.datasetKey}
                        ref={listRef}
                        dataKey={props.datasetKey}
                        data={listData}
                        extraData={transcriptMessageSelection.selectionVersion}
                        frame={shellFrame}
                        webDomObservation={webDomObservation}
                        keyExtractor={keyExtractor}
                        getItemType={getItemType}
                        renderItem={renderItem}
                        header={shellEdgeSlots.listHeaderNode}
                        footer={shellEdgeSlots.listFooterNode}
                        {...olderPagination.shellProps}
                        olderLoadOverlay={
                            olderPagination.isLoadingOlder
                                ? <OlderLoadProgressOverlay />
                                : olderPagination.loadFailed
                                    ? <OlderLoadRetryOverlay onRetry={olderPagination.retryLoad} />
                                    : null
                        }
                    />
                </View>
            </TranscriptRowLayoutMutationProvider>
        </TranscriptMotionProvider>
    );
});
