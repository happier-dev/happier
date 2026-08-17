import * as React from 'react';

import type { AgentId } from '@/agents/registry/registryCore';

import {
    EMPTY_SESSION_TRANSCRIPT_AGENT_ATTRIBUTION_INDEX,
    resolveHistoricalAgentIdAtSeq,
    type SessionTranscriptAgentAttributionIndex,
} from './sessionTranscriptAgentAttribution';

/**
 * Transcript-scoped: the divider boundary index, built once at the transcript
 * root. Rows never rebuild it.
 */
const SessionTranscriptAgentAttributionIndexContext =
    React.createContext<SessionTranscriptAgentAttributionIndex>(
        EMPTY_SESSION_TRANSCRIPT_AGENT_ATTRIBUTION_INDEX,
    );

/**
 * Row-scoped: the sequence of the transcript row currently rendering. Tool rows
 * publish it once; every consumer beneath them reads it instead of receiving a
 * seq prop through six intermediate components. `null` means "no row identity
 * here", which resolves neutral.
 */
const TranscriptRowSeqContext = React.createContext<number | null>(null);

export const SessionTranscriptAgentAttributionProvider =
    SessionTranscriptAgentAttributionIndexContext.Provider;

export const TranscriptRowSeqProvider = TranscriptRowSeqContext.Provider;

export function useSessionTranscriptAgentAttributionIndex(): SessionTranscriptAgentAttributionIndex {
    return React.useContext(SessionTranscriptAgentAttributionIndexContext);
}

/**
 * The single reader every historical consumer uses.
 *
 * Returns the Agent that produced the current row, or `null` when there is no
 * divider evidence — a Session that never switched, a row with no sequence, or
 * a surface outside the transcript. `null` keeps the caller's existing
 * live-metadata behavior, so nothing regresses for the unswitched majority.
 *
 * Pass `seq` explicitly at a surface that owns the row sequence but does not
 * sit under a {@link TranscriptRowSeqProvider}.
 */
export function useHistoricalTranscriptAgentId(seq?: number | null): AgentId | null {
    const index = React.useContext(SessionTranscriptAgentAttributionIndexContext);
    const rowSeq = React.useContext(TranscriptRowSeqContext);
    const effectiveSeq = seq === undefined ? rowSeq : seq;
    return React.useMemo(
        () => resolveHistoricalAgentIdAtSeq(index, effectiveSeq),
        [index, effectiveSeq],
    );
}
