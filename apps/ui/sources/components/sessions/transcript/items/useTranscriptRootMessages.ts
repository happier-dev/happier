import * as React from 'react';
import type { Message } from "@happier-dev/session-core/messages";
import { storage, useActiveServerAccountScope, useForkedTranscriptSnapshot } from '@/sync/domains/state/storage';
import { readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { refreshWorkflowTranscriptProvenance } from '@/sync/engine/workflows/refreshWorkflowRun';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { buildForkAwareMessageDescriptors } from '@/components/sessions/transcript/forkContext/buildForkAwareMessageDescriptors';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function useTranscriptRootMessages(sessionId: string) {
    const source = useSessionTranscriptSource();
    const scope = useActiveServerAccountScope(source.kind === 'app' ? source.serverId ?? undefined : null);
    // Fork ancestry is an app-owned cross-session projection, never a snapshot fallback.
    const fork = source.kind === 'app' ? useForkedTranscriptSnapshot(sessionId) : null;
    const childMessageIdsOldestFirst = source.useMessageIdsOldestFirst();
    const { isLoaded } = source.history.useState();
    const childMessagesById = source.useMessagesById();
    const forkedTranscriptEnabled = fork != null;

    const forkContextNeedsPrefetch = React.useMemo(() => {
        if (!fork) return false;
        return fork.segments.some((seg) =>
            seg.isReadOnlyContext === true &&
            typeof seg.cutoffSeqInclusive === 'number' &&
            Number.isFinite(seg.cutoffSeqInclusive) &&
            seg.cutoffSeqInclusive >= 0 &&
            (seg.messageIdsOldestFirst?.length ?? 0) === 0
        );
    }, [fork]);

    React.useEffect(() => {
        if (!forkContextNeedsPrefetch) return;
        // Wait for the child's own transcript load to settle first: the sync-side prefetch
        // gate requires every closer segment's pagination state to be RESOLVED (no more
        // older pages), and a prefetch fired before the child's initial page lands is
        // silently skipped with nothing retrying (live native S-F 2026-07-11: a fork with
        // an empty child never displayed the pre-fork parent transcript). `isLoaded`
        // flipping true re-fires this effect against the settled state.
        if (!isLoaded) return;
        fireAndForget(sync.prefetchForkedTranscriptContext(sessionId), { tag: 'ChatList.prefetchForkedTranscriptContext' });
    }, [forkContextNeedsPrefetch, isLoaded, sessionId]);

    const forkAwareMessageDescriptors = React.useMemo(() => {
        if (!forkedTranscriptEnabled || !fork) return null;
        return buildForkAwareMessageDescriptors(fork);
    }, [fork, forkedTranscriptEnabled]);
    const messageIdsOldestFirst = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messageIdsOldestFirst as string[];
        }
        return childMessageIdsOldestFirst;
    }, [forkAwareMessageDescriptors, childMessageIdsOldestFirst]);
    const messagesById = React.useMemo(() => {
        if (forkAwareMessageDescriptors) {
            return forkAwareMessageDescriptors.messagesById as Record<string, Message>;
        }
        return childMessagesById;
    }, [forkAwareMessageDescriptors, childMessagesById]);

    React.useEffect(() => {
        if (source.kind !== 'app') return;
        if (!scope) return;
        const state = storage.getState();
        const references = new Map<string, Set<string>>();
        for (const id of messageIdsOldestFirst) {
            const message = messagesById[id];
            const provenance = message && readSessionMessageProvenance(message.meta);
            if (provenance?.kind !== 'workflow_invocation') continue;
            const needsTitle = !state.workflowRunsById[provenance.runId]?.summary;
            const fact = state.workflowRunInvocationsByRunId[provenance.runId]?.factsById[provenance.invocationRecordId];
            const needsStep = !provenance.stepOrdinal
                && !fact?.stepOrdinal;
            const needsProvenance = !fact?.provenanceLoaded;
            if (!needsTitle && !needsStep && !needsProvenance) continue;
            const invocations = references.get(provenance.runId) ?? new Set<string>();
            if (needsStep || needsProvenance) invocations.add(provenance.invocationRecordId);
            references.set(provenance.runId, invocations);
        }
        const batch = [...references].sort(([a], [b]) => a.localeCompare(b))
            .map(([runId, ids]) => ({ runId, invocationRecordIds: [...ids].sort() }));
        fireAndForget(refreshWorkflowTranscriptProvenance(batch), { tag: 'transcript.workflowProvenance' });
        // Hydration publishes only to chip selectors; never replace message objects or subscribe the list to Run facts.
    }, [source.kind, scope, messageIdsOldestFirst, messagesById]);

    return {
        fork,
        forkAwareMessageDescriptors,
        forkedTranscriptEnabled,
        isLoaded,
        messageIdsOldestFirst,
        messagesById,
    };
}
