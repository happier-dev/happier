import * as React from 'react';
import type { SessionTranscriptSource } from './types';

const SessionTranscriptSourceContext = React.createContext<SessionTranscriptSource | null>(null);

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
