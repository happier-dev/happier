import * as React from 'react';
import { Platform, View } from 'react-native';
import { MessageViewWithSessionCommon } from '@/components/sessions/transcript/MessageView';
import { ChatFooter } from '@/components/sessions/transcript/ChatFooter';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    TRANSCRIPT_TOP_GUTTER_PX,
} from '@/components/sessions/transcript/_constants';
import { useTranscriptSessionCommon } from '@/components/sessions/transcript/transcriptSessionCommon';
import { useOptionalTranscriptSelectionState } from '@/components/sessions/transcript/messageSelection/TranscriptMessageSelectionContext';
import { TranscriptListShell } from '@/components/sessions/transcript/viewport/shell/TranscriptListShell';
import {
    resolveTranscriptListRendererBinding,
    resolveTranscriptListRendererSelection,
} from '@/components/sessions/transcript/viewport/shell/renderer/resolveTranscriptListRenderer';
import { resolveReadOnlyTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { deriveTranscriptForkCommonForInteraction } from '@/components/sessions/transcript/transcriptSessionCommon';
import { TranscriptMotionProvider } from '@/components/sessions/transcript/motion/TranscriptMotionProvider';
import { useTranscriptMotionConfig } from '@/components/sessions/transcript/motion/useTranscriptMotionConfig';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { TranscriptRowLayoutMutationProvider } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import { useRendererOwnedTranscriptRowLayoutMutation } from '@/components/sessions/transcript/viewport/shell/useRendererOwnedTranscriptRowLayoutMutation';
import {
    registerWebTranscriptKeyboardOwner,
    type WebTranscriptKeyboardVerticalDirection,
} from '@/components/sessions/transcript/viewport/lifecycle/webTranscriptKeyboardOwner';

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

const ListFooter = React.memo((props: { bottomNotice?: TranscriptBottomNotice | null }) => {
    return <ChatFooter notice={props.bottomNotice ?? null} controlledByUser={false} />;
});

const PUBLIC_READ_ONLY_TRANSCRIPT_INTERACTION = deriveTranscriptInteraction({
    kind: 'public',
    disableToolNavigation: true,
});

export const TranscriptList = React.memo((props: {
    sessionId: string;
    datasetKey: string;
    metadata: Metadata | null;
    messages: Message[];
    bottomNotice?: TranscriptBottomNotice | null;
    isLoaded?: boolean;
}) => {
    const { motionConfig } = useTranscriptMotionConfig();
    const syncTuning = sync.getSyncTuning();
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);
    const publicForkCommon = React.useMemo(
        () => deriveTranscriptForkCommonForInteraction(
            transcriptSessionCommon.fork,
            PUBLIC_READ_ONLY_TRANSCRIPT_INTERACTION,
        ),
        [transcriptSessionCommon.fork],
    );
    const transcriptMessageSelection = useOptionalTranscriptSelectionState();
    const webDomObservation = React.useMemo(() => createWebDomScrollObservation(), []);
    const {
        listRef,
        prepareRowLayoutMutation,
    } = useRendererOwnedTranscriptRowLayoutMutation<Message>();
    const sessionThinkingDisplayMode = transcriptSessionCommon.messageDisplay.sessionThinkingDisplayMode;
    const sessionThinkingInlinePresentation = transcriptSessionCommon.messageDisplay.sessionThinkingInlinePresentation;
    const rendererSelection = React.useMemo(() => resolveTranscriptListRendererSelection({
        platformOS: Platform.OS,
        transcriptLegendListSpikeSurface: syncTuning.transcriptLegendListSpikeSurface,
    }), [syncTuning.transcriptLegendListSpikeSurface]);
    const rendererBinding = React.useMemo(() => resolveTranscriptListRendererBinding({
        frame: resolveReadOnlyTranscriptListShellFrame({
            accessKind: 'public',
            bottomNoticeVisible: props.bottomNotice != null,
            platformOS: Platform.OS,
            rendererKind: rendererSelection.renderer.kind,
        }),
        selection: rendererSelection,
    }), [props.bottomNotice, rendererSelection]);
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
        if (rendererBinding.frame.platform !== 'web' || typeof document === 'undefined') return;
        return registerWebTranscriptKeyboardOwner({
            document,
            onViewportKeyboardInput: recordWebKeyboardViewportInput,
            resolveScroller: resolveWebKeyboardScroller,
        });
    }, [
        recordWebKeyboardViewportInput,
        rendererBinding.frame.platform,
        resolveWebKeyboardScroller,
    ]);
    const listData = React.useMemo(() => {
        if (rendererBinding.frame.dataOrder === 'newest-first') {
            // Inverted lists expect newest-first input.
            return [...props.messages].reverse();
        }
        return props.messages;
    }, [props.messages, rendererBinding.frame.dataOrder]);

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
                interaction={PUBLIC_READ_ONLY_TRANSCRIPT_INTERACTION}
                forkCommon={publicForkCommon}
                messageDisplayCommon={transcriptSessionCommon.messageDisplay}
                toolChromeCommon={transcriptSessionCommon.toolChrome}
                toolRouteCommon={transcriptSessionCommon.toolRoute}
                thinkingExpanded={controlledThinking ? resolveThinkingExpanded(item.id) : undefined}
                onThinkingExpandedChange={controlledThinking ? (next) => setThinkingExpanded(item.id, next) : undefined}
            />
        );
    }, [
        props.metadata,
        props.sessionId,
        resolveThinkingExpanded,
        sessionThinkingDisplayMode,
        setThinkingExpanded,
        publicForkCommon,
        transcriptSessionCommon.messageDisplay,
        transcriptSessionCommon.toolChrome,
        transcriptSessionCommon.toolRoute,
    ]);

    const transcriptListExtraData = React.useMemo(() => ({
        selectionVersion: transcriptMessageSelection.selectionVersion,
        thinkingExpandedByMessageId,
    }), [thinkingExpandedByMessageId, transcriptMessageSelection.selectionVersion]);

    return (
        <TranscriptMotionProvider key={props.datasetKey} sessionKey={props.datasetKey} config={motionConfig}>
            <TranscriptRowLayoutMutationProvider value={prepareRowLayoutMutation}>
                <TranscriptListShell<Message>
                    key={props.datasetKey}
                    ref={listRef}
                    data={listData}
                    dataKey={props.datasetKey}
                    extraData={transcriptListExtraData}
                    keyExtractor={keyExtractor}
                    getItemType={getItemType}
                    renderItem={renderItem}
                    rendererBinding={rendererBinding}
                    webDomObservation={webDomObservation}
                    header={<ListHeader isLoading={props.isLoaded === false} />}
                    footer={<ListFooter bottomNotice={props.bottomNotice ?? null} />}
                />
            </TranscriptRowLayoutMutationProvider>
        </TranscriptMotionProvider>
    );
});
