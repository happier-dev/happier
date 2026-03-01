import * as React from 'react';

import { createTranscriptFreshnessGate } from './transcriptFreshnessGate';
import { TranscriptMotionContext, type TranscriptMotionConfig } from './TranscriptMotionContext';

export const TranscriptMotionProvider = React.memo(function TranscriptMotionProvider(props: {
    sessionKey: string;
    config: TranscriptMotionConfig;
    children: React.ReactNode;
}) {
    const gate = React.useMemo(() => {
        return createTranscriptFreshnessGate({
            freshnessMs: props.config.freshnessMs,
            getNowMs: () => Date.now(),
        });
    }, [props.config.freshnessMs, props.sessionKey]);

    const value = React.useMemo(() => ({ gate, config: props.config }), [gate, props.config]);

    return (
        <TranscriptMotionContext.Provider value={value}>
            {props.children}
        </TranscriptMotionContext.Provider>
    );
});
