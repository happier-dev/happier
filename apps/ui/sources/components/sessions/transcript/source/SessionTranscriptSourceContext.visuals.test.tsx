import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionForkVisualContextV1 } from '@happier-dev/protocol/sessions/board/forkVisualCopies';
import { TranscriptVisualContextProvider, useTranscriptVisualContext } from './SessionTranscriptSourceContext';

describe('transcript visual provenance', () => {
    it('keeps grouped child copies bound to each row original address without manufacturing a child context', () => {
        let observed: SessionForkVisualContextV1 | undefined;
        function Probe() { observed = useTranscriptVisualContext(); return null; }
        const origin = { v: 1, serverId: 'home-two', sessionId: 'parent-two', sourceMessageId: 'second', sourceSeq: 2 };
        const base = { sessionId: 'child', copies: [], originAddress: { serverId: 'home-one', sessionId: 'parent-one' } };
        renderToStaticMarkup(<TranscriptVisualContextProvider visualContext={base}>
            <TranscriptVisualContextProvider visualOriginV1={origin}><Probe /></TranscriptVisualContextProvider>
        </TranscriptVisualContextProvider>);
        expect(observed).toEqual({ sessionId: 'child', copies: [], originAddress: { serverId: 'home-two', sessionId: 'parent-two' } });
        expect(observed?.copies).toBe(base.copies);
        renderToStaticMarkup(<TranscriptVisualContextProvider visualContext={base} visualOriginV1={{ v: 2 }}><Probe /></TranscriptVisualContextProvider>);
        expect(observed).toBe(base);
        renderToStaticMarkup(<TranscriptVisualContextProvider visualOriginV1={origin}><Probe /></TranscriptVisualContextProvider>);
        expect(observed).toBeUndefined();
    });
});
