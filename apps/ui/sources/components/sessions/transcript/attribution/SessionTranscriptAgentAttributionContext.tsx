import * as React from 'react';

import type { AgentId } from '@/agents/registry/registryCore';
import type { Message } from '@/sync/domains/messages/messageTypes';

import {
    buildSessionTranscriptAgentAttributionIndex,
    createSessionTranscriptAgentAttributionBoundarySignature,
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

/**
 * Builds the transcript-root context only when the ordered divider boundaries
 * change. A streamed row still replaces the message map, but cannot make every
 * historical-attribution consumer re-render unless it changes those boundaries.
 */
export function useSessionTranscriptAgentAttributionIndexForMessages(
    messagesById: Readonly<Record<string, Message>>,
): SessionTranscriptAgentAttributionIndex {
    const messages = React.useMemo(() => Object.values(messagesById), [messagesById]);
    const boundarySignature = React.useMemo(
        () => createSessionTranscriptAgentAttributionBoundarySignature(messages),
        [messages],
    );
    // `boundarySignature` contains every output-relevant part of `messages`.
    // Rebuilding for a fresh message-map identity would republish the Context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return React.useMemo(
        () => buildSessionTranscriptAgentAttributionIndex(messages),
        [boundarySignature],
    );
}

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
