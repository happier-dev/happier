import * as React from 'react';
import type { TriageFailureSubjectV1 } from '@happier-dev/triage-protocol/v1';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { readInboxReadySessionTurn } from '@/activity/presentation/buildInboxReadySessionResult';
import { useSessionMessages, useTranscriptApprovalArtifactsForSession } from '@/sync/store/hooks';
import { resolveApprovalDisplayStatus } from '@/components/approvals/approvalStatusLabel';
import { readTranscriptOperationsProducedResults } from '@/components/sessions/transcript/references/transcriptOperationsProducedResults';
import { EMPTY_OPERATIONS_RUN_PRODUCED_RESULTS } from '@/sync/domains/workflows/operationsRunOutcome';
import { storage } from '@/sync/domains/state/storageStore';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { failureInvestigationSubjectKey, type createAccountNoticeInvestigation } from './accountNoticeInvestigation';
import { useInboxReadySessionResult } from './useInboxReadySessionResult';

type Owner = ReturnType<typeof createAccountNoticeInvestigation>;
// Keep decided requests available as historical links; their Artifact owns current status.
const settledApprovalPresentations = Object.freeze([() => true]);

/** One addressed Triage relationship, then the existing exact-Session content owner.
 * Admission completion refreshes the link; Session completion arrives by push. */
export function useInvestigationSessionResult(
    owner: Owner,
    subject: TriageFailureSubjectV1 | null,
    acquisition: unknown,
) {
    const key = subject ? failureInvestigationSubjectKey(subject) : null;
    const [read, setRead] = React.useState<Readonly<{
        owner: Owner; key: string | null; session: ActionSessionAddressV1 | null;
    }> | null>(null);
    React.useEffect(() => {
        if (!subject) return;
        const cancellation = new AbortController();
        void owner.readLinkedSession(subject, { signal: cancellation.signal }).then(session => {
            if (!cancellation.signal.aborted) setRead({ owner, key, session });
        }).catch(() => {
            if (!cancellation.signal.aborted) setRead({ owner, key, session: null });
        });
        return () => cancellation.abort();
    }, [owner, key, acquisition]);
    const address = read?.owner === owner && read.key === key ? read.session : null;
    const sessionId = address?.sessionId ?? '';
    const session = storage(state => {
        const value = state.sessions[sessionId];
        return address && value && areServerProfileIdentifiersEquivalent(value.serverId, address.serverId) ? value : null;
    }, { sessions: address ? [sessionId] : [] });
    const candidate = React.useMemo(() => session ? buildSessionActivityAttention({ session }) : null, [session]);
    const result = useInboxReadySessionResult(candidate, { transcriptAddress: address, selection: 'latestTurn' });
    const readable = Boolean(candidate && readInboxReadySessionTurn(candidate, session?.sessionTurns));
    const transcript = useSessionMessages(sessionId, { enabled: readable, textUpdates: false });
    const transcriptProduced = React.useMemo(() => address && readable
        ? readTranscriptOperationsProducedResults(transcript.messages, address.serverId)
        : EMPTY_OPERATIONS_RUN_PRODUCED_RESULTS, [address, readable, transcript.messages]);
    const approvalArtifacts = useTranscriptApprovalArtifactsForSession(readable ? address : null, settledApprovalPresentations);
    const produced = React.useMemo(() => {
        if (!address || !readable || approvalArtifacts.length === 0) return transcriptProduced;
        const approvals = new Map(transcriptProduced.approvals.map(value =>
            [JSON.stringify([value.serverId, value.request.artifactId]), value] as const));
        for (const { artifact, approval } of approvalArtifacts) {
            approvals.set(JSON.stringify([address.serverId, artifact.id]), { serverId: address.serverId, status: resolveApprovalDisplayStatus(approval),
                request: { kind: 'approval_request_created', artifactId: artifact.id, actionId: approval.actionId } });
        }
        return { ...transcriptProduced, approvals: [...approvals.values()] };
    }, [address, readable, transcriptProduced, approvalArtifacts]);
    return React.useMemo(() => address && subject ? {
        session: address, result, produced,
        messageRef: result.output?.messageRef ?? null,
        evidence: { subject, message: result.output?.messageRef ?? null },
        nextAction: { kind: 'continueSession' as const, session: address },
    } : null, [address, result, produced, key]);
}
