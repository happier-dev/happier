import * as React from 'react';
import { Platform, View } from 'react-native';
import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import { ChatFooter } from '@/components/sessions/transcript/ChatFooter';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    TRANSCRIPT_TOP_GUTTER_PX,
} from '@/components/sessions/transcript/_constants';
import { orientTranscriptListItems } from '@/components/sessions/transcript/listOrientation';
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
    registerWebTranscriptKeyboardOwner,
    type WebTranscriptKeyboardVerticalDirection,
} from '@/components/sessions/transcript/viewport/lifecycle/webTranscriptKeyboardOwner';
import type {
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';
import {
    ExternalSessionOperationSharedCard,
} from '@/components/sessions/external/progress/ExternalSessionOperationSharedCard';
import {
    readExternalSessionOperationPresentationFromMetadata,
} from '@/components/sessions/transcript/items/externalSessionOperationMetadata';

type TranscriptInteraction = {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    disableToolNavigation?: boolean;
};

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
}) => {
    return (
        <View>
            {props.externalSessionOperationPresentation ? (
                <ExternalSessionOperationSharedCard
                    presentation={props.externalSessionOperationPresentation}
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
    sessionId: string;
    datasetKey: string;
    metadata: Metadata | null;
    messages: Message[];
    interaction: TranscriptInteraction;
    bottomNotice?: TranscriptBottomNotice | null;
    isLoaded?: boolean;
}) => {
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
    const { motionConfig } = useTranscriptMotionConfig();
    const webDomObservation = React.useMemo(() => createWebDomScrollObservation(), []);
    const {
        listRef,
        prepareRowLayoutMutation,
    } = useRendererOwnedTranscriptRowLayoutMutation<Message>();
    const forkCommon = React.useMemo(
        () => deriveTranscriptForkCommonForInteraction(transcriptSessionCommon.fork, props.interaction),
        [props.interaction, transcriptSessionCommon.fork],
    );
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const externalSessionOperationPresentation = React.useMemo(
        () => readExternalSessionOperationPresentationFromMetadata(
            props.metadata,
        ),
        [props.metadata],
    );
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
    const listData = React.useMemo(() => {
        if (shellFrame.dataOrder === 'newest-first') {
            return [...props.messages].reverse();
        }
        return orientTranscriptListItems(props.messages, 'standard');
    }, [props.messages, shellFrame.dataOrder]);
    const shellEdgeSlots = React.useMemo(() => resolveTranscriptListShellEdgeSlots({
        frame: shellFrame,
        visualTopNode: <ListHeader isLoading={props.isLoaded === false} />,
        visualBottomNode: (
            <ListFooter
                bottomNotice={props.bottomNotice ?? null}
                externalSessionOperationPresentation={
                    externalSessionOperationPresentation
                }
            />
        ),
    }), [
        externalSessionOperationPresentation,
        props.bottomNotice,
        props.isLoaded,
        shellFrame,
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
                sessionId={props.sessionId}
                interaction={props.interaction}
                forkCommon={forkCommon}
                messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                toolChromeCommon={transcriptSessionCommon.toolChrome}
                toolRouteCommon={transcriptSessionCommon.toolRoute}
                thinkingExpanded={controlledThinking ? resolveThinkingExpanded(item.id) : undefined}
                onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(item.id, next) : undefined}
            />
        );
    }, [
        props.interaction,
        props.metadata,
        props.sessionId,
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
                />
            </TranscriptRowLayoutMutationProvider>
        </TranscriptMotionProvider>
    );
});
