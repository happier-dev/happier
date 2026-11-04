import * as React from 'react';

import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';

import type { RecordingAuthoring } from './useRecordingAuthoring';
import { useRecordingFrameAnnotator } from './useRecordingAuthoring';
import type { RecordingFrameSession } from './useRecordingEditor';

/**
 * One paused frame's annotator. It renders nothing: it is keyed by frame, and hands the annotator up to the
 * window's palette and canvas, which outlive it. The tool and colour carry over to the next frame.
 */
export function RecordingFrameSessionLeaf(props: Readonly<{
    authoring: RecordingAuthoring;
    sourceTimeMs: number;
    source: ImageAnnotationSource;
    previous: RecordingFrameSession | null;
    onSession: (session: RecordingFrameSession) => void;
    onCommitError: (failed: boolean) => void;
    onToolChosen: () => void;
}>) {
    const { onCommitError, onSession, onToolChosen, previous } = props;
    const handle = useRecordingFrameAnnotator({
        authoring: props.authoring,
        sourceTimeMs: props.sourceTimeMs,
        source: props.source,
        onCommitError: () => onCommitError(true),
    });
    const inherited = React.useRef(previous);
    React.useLayoutEffect(() => {
        const { tool, style } = inherited.current?.annotator.store.getState() ?? handle.annotator.store.getState();
        handle.annotator.store.setState({ tool, style });
        onSession(handle);
        return handle.annotator.store.subscribe((state, before) => {
            if (state.tool !== before.tool) onToolChosen();
        });
        // One leaf, one frame: the host keys it. `flush` and `retry` are stable for one annotator.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handle.annotator]);
    return null;
}
