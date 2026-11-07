import * as React from 'react';

import { useStreamingTextSmoothing } from './useStreamingTextSmoothing';

/** Reveal frames belong to text; the surrounding row only consumes streaming transitions. */
export function StreamingTextContent(props: Readonly<{
    enabled: boolean;
    targetText: string;
    settleDelayMs: number;
    onStreamingChange: (streaming: boolean) => void;
    children: (streaming: ReturnType<typeof useStreamingTextSmoothing>) => React.ReactNode;
}>) {
    const streaming = useStreamingTextSmoothing(props);
    React.useLayoutEffect(() => {
        props.onStreamingChange(streaming.isStreaming);
    }, [props.onStreamingChange, streaming.isStreaming]);
    return props.children(streaming);
}
