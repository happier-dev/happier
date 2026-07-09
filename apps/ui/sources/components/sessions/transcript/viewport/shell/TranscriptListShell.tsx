import * as React from 'react';
import { View } from 'react-native';

import { resolveTranscriptListRenderer } from './renderer/resolveTranscriptListRenderer';
import type {
    TranscriptListShellProps,
    TranscriptListShellRef,
} from './renderer/types';

export type {
    TranscriptListShellPlatformInteractionProps,
    TranscriptListShellProps,
    TranscriptListShellRef,
} from './renderer/types';

const TRANSCRIPT_LIST_SHELL_STYLE = { flex: 1, minHeight: 0 } as const;

function TranscriptListShellInner<TItem>(
    props: TranscriptListShellProps<TItem>,
    ref: React.ForwardedRef<TranscriptListShellRef<TItem>>,
): React.ReactElement {
    const renderer = resolveTranscriptListRenderer({
        frame: props.frame,
        transcriptLegendListSpikeSurface: props.transcriptLegendListSpikeSurface,
    });
    const Renderer = renderer.Component;

    return (
        <View style={TRANSCRIPT_LIST_SHELL_STYLE}>
            <Renderer
                ref={ref}
                {...props}
            />
            {props.olderLoadOverlay ?? null}
            {props.catchUpOverlay ?? null}
        </View>
    );
}

export const TranscriptListShell = React.forwardRef(TranscriptListShellInner) as <TItem>(
    props: TranscriptListShellProps<TItem> & React.RefAttributes<TranscriptListShellRef<TItem>>,
) => React.ReactElement;
