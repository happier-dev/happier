import * as React from 'react';
import { storage } from '@/sync/domains/state/storageStore';
import type { Message } from '@happier-dev/session-core/messages';
import type { WorkflowAgentRevision } from '@/sync/domains/workflows/workflowAgentRevision';
import { isTranscriptWorkflowDefinitionWrite, resolveTranscriptWorkflowDefinitionReference } from '@/components/sessions/transcript/references/transcriptWorkflowDefinitionReference';

/** A narrow acknowledgement read from the canonical Session rows, not another revision store. */
export function useWorkflowAgentRevision(sessionId: string | null, definitionId: string | null, sourceKey: string): WorkflowAgentRevision | null {
    const rows = storage((state) => sessionId === null ? null : state.sessionMessages[sessionId]?.messagesById ?? null);
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
        return { sessionId, definitionId, sourceKey, inFlight,
            seq: sessionId === null ? null : state.sessions[sessionId]?.seq ?? null,
        };
    };
    const [openedAfter, setOpenedAfter] = React.useState(captureOpening);
    const sourceIsCurrent = openedAfter.sessionId === sessionId && openedAfter.definitionId === definitionId && openedAfter.sourceKey === sourceKey;
    const latest = React.useMemo((): WorkflowAgentRevision | null => {
        let latest: WorkflowAgentRevision | null = null;
        const visit = (message: Message) => {
            if (message.kind !== 'tool-call') return;
            const afterOpeningWatermark = openedAfter.seq !== null && Number.isFinite(openedAfter.seq)
                && typeof message.seq === 'number' && Number.isFinite(message.seq) && message.seq > openedAfter.seq;
            const candidate = afterOpeningWatermark || openedAfter.inFlight.has(message.id)
                ? resolveTranscriptWorkflowDefinitionReference(message.tool) : null;
            if (candidate?.definitionId === definitionId && (latest === null
                || candidate.revision.headerVersion > latest.revision.headerVersion
                || candidate.revision.headerVersion === latest.revision.headerVersion && candidate.revision.bodyVersion > latest.revision.bodyVersion)) {
                latest = candidate;
            }
            for (const child of message.children) visit(child);
        };
        if (rows !== null) for (const message of Object.values(rows)) visit(message);
        return latest;
    }, [definitionId, openedAfter, rows]);
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
