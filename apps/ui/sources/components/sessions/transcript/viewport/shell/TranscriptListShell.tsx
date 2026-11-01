import * as React from 'react';
import { View } from 'react-native';

import { MarkdownCodeBlockWrapStateProvider } from '@/components/markdown/MarkdownCodeBlockWrapState';

import type {
    TranscriptListShellProps,
    TranscriptListShellRef,
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
    const {
        catchUpOverlay,
        olderLoadOverlay,
        rendererBinding,
        ...rendererProps
    } = props;
    const Renderer = rendererBinding.renderer.Component;

    return (
        <MarkdownCodeBlockWrapStateProvider>
            <View style={TRANSCRIPT_LIST_SHELL_STYLE}>
                <Renderer
                    ref={ref}
                    {...rendererProps}
                    frame={rendererBinding.frame}
                />
                {olderLoadOverlay ?? null}
                {catchUpOverlay ?? null}
            </View>
        </MarkdownCodeBlockWrapStateProvider>
    );
}

export const TranscriptListShell = React.forwardRef(TranscriptListShellInner) as <TItem>(
    props: TranscriptListShellProps<TItem> & React.RefAttributes<TranscriptListShellRef<TItem>>,
) => React.ReactElement;
