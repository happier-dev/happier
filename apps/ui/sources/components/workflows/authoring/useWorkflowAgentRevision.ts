import * as React from 'react';
import { storage } from '@/sync/domains/state/storageStore';
import type { Message } from '@happier-dev/session-core/messages';
import type { WorkflowAgentRevision } from '@/sync/domains/workflows/workflowAgentRevision';
import { isTranscriptWorkflowDefinitionWrite, visitChangedTranscriptWorkflowDefinitionReferences } from '@/components/sessions/transcript/references/transcriptWorkflowDefinitionReference';
import { subscribeSessionMessageChanges, type SessionMessageChanges } from '@/sync/store/sessionMessageChanges';

/** A narrow acknowledgement read from the canonical Session rows, not another revision store. */
export function useWorkflowAgentRevision(sessionId: string | null, definitionId: string | null, sourceKey: string): WorkflowAgentRevision | null {
    const captureOpening = () => {
        const state = storage.getState();
        const inFlight = new Set<string>();
        const visit = (message: Message) => {
            if (message.kind !== 'tool-call') return;
            if (message.tool.state === 'running' && isTranscriptWorkflowDefinitionWrite(message.tool)) inFlight.add(message.id);
            for (const child of message.children) visit(child);
        };
        const openingRows = sessionId === null ? null : state.sessionMessages[sessionId]?.messagesById;
        if (openingRows) for (const message of Object.values(openingRows)) visit(message);
        return { sessionId, definitionId, sourceKey, inFlight, latest: null as WorkflowAgentRevision | null,
            seq: sessionId === null ? null : state.sessions[sessionId]?.seq ?? null,
        };
    };
    const [openedAfter, setOpenedAfter] = React.useState(captureOpening);
    const sourceIsCurrent = openedAfter.sessionId === sessionId && openedAfter.definitionId === definitionId && openedAfter.sourceKey === sourceKey;
    const subscribe = React.useCallback((notify: () => void) => {
        if (openedAfter.sessionId === null) return () => {};
        const receive = (change: SessionMessageChanges) => {
            let next = change.kind === 'replaced' ? null : openedAfter.latest;
            visitChangedTranscriptWorkflowDefinitionReferences(change.changes, message => (
                openedAfter.seq !== null && Number.isFinite(openedAfter.seq)
                    && typeof message.seq === 'number' && Number.isFinite(message.seq) && message.seq > openedAfter.seq
            ) || openedAfter.inFlight.has(message.id), candidate => {
                if (candidate.definitionId === openedAfter.definitionId && (next === null
                    || candidate.revision.headerVersion > next.revision.headerVersion
                    || candidate.revision.headerVersion === next.revision.headerVersion && candidate.revision.bodyVersion > next.revision.bodyVersion)) {
                    next = candidate;
                }
            });
            if (openedAfter.latest === next) return;
            openedAfter.latest = next;
            notify();
        };
        const stop = subscribeSessionMessageChanges(openedAfter.sessionId, receive);
        // Reconcile once after subscribing: a receipt can arrive between render
        // (the opening watermark) and commit. Later work uses producer deltas.
        const rows = storage.getState().sessionMessages[openedAfter.sessionId]?.messagesById;
        receive({ kind: 'replaced', changes: Object.values(rows ?? {}).map(message => ({ previous: null, next: message })) });
        return stop;
    }, [openedAfter]);
    const read = React.useCallback(() => openedAfter.latest, [openedAfter]);
    const latest = React.useSyncExternalStore(subscribe, read, read);
    // Opening a particular result must not adopt another result already in the
    // transcript. Capture both the watermark and materialized in-flight calls
    // for each source, so their later completion remains observable.
    if (!sourceIsCurrent) {
        setOpenedAfter(captureOpening());
        return null;
    }
    // The Session sequence is the server watermark at open. Older pages cannot
    // cross it or enter the opening in-flight set, regardless of result timestamps.
    return latest;
}
