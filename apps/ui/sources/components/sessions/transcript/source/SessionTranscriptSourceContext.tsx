import * as React from 'react';
import { SessionForkVisualOriginV1Schema, type SessionForkVisualContextV1 } from '@happier-dev/protocol/sessions/board/forkVisualCopies';
import type { SessionTranscriptSource } from './types';

const SessionTranscriptSourceContext = React.createContext<SessionTranscriptSource | null>(null);
const TranscriptVisualContext = React.createContext<SessionForkVisualContextV1 | undefined>(undefined);

export function useTranscriptVisualContext(): SessionForkVisualContextV1 | undefined {
    return React.useContext(TranscriptVisualContext);
}

export function TranscriptVisualContextProvider(props: Readonly<{
    visualContext?: SessionForkVisualContextV1;
    visualOriginV1?: unknown;
    children: React.ReactNode;
}>) {
    const inherited = useTranscriptVisualContext();
    const base = props.visualContext ?? inherited;
    const value = React.useMemo(() => {
        const origin = SessionForkVisualOriginV1Schema.safeParse(props.visualOriginV1);
        return base && origin.success ? { ...base, originAddress: { serverId: origin.data.serverId, sessionId: origin.data.sessionId } } : base;
    }, [base, props.visualOriginV1]);
    return <TranscriptVisualContext.Provider value={value}>{props.children}</TranscriptVisualContext.Provider>;
}

export class SessionTranscriptSourceMissingError extends Error {
    constructor() {
        super('Session presentation requires a SessionTranscriptSourceProvider');
        this.name = 'SessionTranscriptSourceMissingError';
    }
}

export function SessionTranscriptSourceProvider(props: Readonly<{ source: SessionTranscriptSource; children: React.ReactNode }>) {
    return <SessionTranscriptSourceContext.Provider key={`${props.source.kind}:${props.source.serverId ?? ''}:${props.source.sessionId}`} value={props.source}>{props.children}</SessionTranscriptSourceContext.Provider>;
}

export function useSessionTranscriptSource(): SessionTranscriptSource {
    const source = React.useContext(SessionTranscriptSourceContext);
    if (!source) throw new SessionTranscriptSourceMissingError();
    return source;
}

/** The transcript source when this presentation sits in a transcript; a Run page renders without one. */
export function useOptionalSessionTranscriptSource(): SessionTranscriptSource | null {
    return React.useContext(SessionTranscriptSourceContext);
}
