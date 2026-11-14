import * as React from 'react';
import { Platform, View } from 'react-native';
import { measureWindowBounds, type WindowBounds } from '@/components/ui/treeDragDrop';
import { RetainedPresentationGeometryRefreshContext, RetainedPresentationViewportContext } from '@/components/ui/presentation/retainedPresentationSlots';

import { MarkdownCodeBlockWrapStateProvider } from '@/components/markdown/MarkdownCodeBlockWrapState';
import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardFloatingInset';
import { JumpToBottomButton } from '@/components/sessions/transcript/scroll/JumpToBottomButton';

import { resolveTranscriptListRenderer } from './renderer/resolveTranscriptListRenderer';
import type {
    TranscriptListShellProps,
    TranscriptListShellRef,
    TranscriptRendererAtEndState,
} from './renderer/types';

export type {
    TranscriptListShellPlatformInteractionProps,
    TranscriptListShellProps,
    TranscriptListShellRef,
    TranscriptRendererAtEndState,
} from './renderer/types';

const TRANSCRIPT_LIST_SHELL_STYLE = { flex: 1, minHeight: 0 } as const;

function TranscriptListShellInner<TItem>(
    props: TranscriptListShellProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const renderer = resolveTranscriptListRenderer();
    const Renderer = renderer.Component;
    const rendererRef = React.useRef<TranscriptListShellRef<TItem> | null>(null);
    const viewportRef = React.useRef<View | null>(null);
    const refreshRetainedGeometry = React.useContext(RetainedPresentationGeometryRefreshContext);
    const retainedViewport = React.useMemo(() => ({
        measure: (publish: (rect: WindowBounds | null) => void) => {
            void measureWindowBounds(viewportRef.current).then(publish);
        },
    }), []);
    const hostOnScroll = props.onScroll;
    const onScroll = React.useCallback<NonNullable<typeof hostOnScroll>>((event, movement) => {
        hostOnScroll?.(event, movement);
        if (Platform.OS !== 'web') refreshRetainedGeometry?.();
    }, [hostOnScroll, refreshRetainedGeometry]);
    const hostOnLayout = props.onLayout;
    const onLayout = React.useCallback<NonNullable<typeof hostOnLayout>>((event) => {
        hostOnLayout?.(event);
        if (Platform.OS !== 'web') refreshRetainedGeometry?.();
    }, [hostOnLayout, refreshRetainedGeometry]);
    const commitRendererRef = React.useCallback((node: TranscriptListShellRef<TItem> | null) => {
        rendererRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
    }, [ref]);
    // Bounded transcripts have no outer jump lifecycle; their existing renderer owns the
    // mounted target. The main transcript supplies its full explicit-jump owner instead.
    const revealNativeItem = React.useCallback((placement: Readonly<{ index: number; itemOffsetPx: number }>) => {
        const target = rendererRef.current;
        if (!target) return;
        const release = target.beginExplicitJumpTakeover?.(Symbol('transcript-native-item-reveal'));
        try {
            void target.scrollToIndex({ index: placement.index, viewOffset: placement.itemOffsetPx, animated: false });
        } finally {
            release?.();
        }
    }, []);
    // A conversation frame (a Discussion) has no outer jump owner: the shell shows the transcript's own
    // jump-to-bottom from the renderer's at-end facts. The main transcript passes its richer affordance.
    const conversation = props.frame.capability.kind === 'conversation';
    const [awayFromEnd, setAwayFromEnd] = React.useState(false);
    const hostAtEndChange = props.onRendererAtEndChange;
    const onRendererAtEndChange = React.useCallback((state: TranscriptRendererAtEndState, context: Parameters<NonNullable<typeof hostAtEndChange>>[1]) => {
        setAwayFromEnd(!state.isAtEnd && !state.isNearEnd);
        hostAtEndChange?.(state, context);
    }, [hostAtEndChange]);
    const jumpToEnd = React.useCallback(() => {
        void rendererRef.current?.scrollToEnd?.({ animated: true });
    }, []);
    const jumpToBottom = props.jumpToBottom !== undefined ? props.jumpToBottom
        : conversation && awayFromEnd ? { count: 0, onPress: jumpToEnd } : null;

    return (
        <MarkdownCodeBlockWrapStateProvider>
            <RetainedPresentationViewportContext.Provider value={retainedViewport}>
            <View ref={viewportRef} collapsable={false} style={TRANSCRIPT_LIST_SHELL_STYLE}>
                <Renderer
                    ref={commitRendererRef}
                    {...props}
                    onScroll={onScroll}
                    onLayout={onLayout}
                    onRevealNativeItem={props.onRevealNativeItem ?? revealNativeItem}
                    {...(conversation ? { onRendererAtEndChange } : {})}
                />
                {props.olderLoadOverlay ?? null}
                {props.catchUpOverlay ?? null}
                {jumpToBottom ? (
                    <ComposerKeyboardFloatingInset
                        testID="transcript-jump-to-bottom-keyboard-offset"
                        baseBottom={12}
                        hideUnderComposerOverlay
                        style={{ position: 'absolute', right: 12 }}
                    >
                        <JumpToBottomButton
                            testID="transcript-jump-to-bottom"
                            count={jumpToBottom.count}
                            onPress={jumpToBottom.onPress}
                            presentation={jumpToBottom.presentation}
                        />
                    </ComposerKeyboardFloatingInset>
                ) : null}
            </View>
            </RetainedPresentationViewportContext.Provider>
        </MarkdownCodeBlockWrapStateProvider>
    );
}

export const TranscriptListShell = React.forwardRef(TranscriptListShellInner) as <TItem>(
    props: TranscriptListShellProps<TItem> & React.RefAttributes<TranscriptListShellRef<TItem>>,
) => React.ReactElement;
