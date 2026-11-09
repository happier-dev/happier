import { SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1, projectSessionFollowRuleSharedSourceEvidenceV1,
    isPotentialSessionFollowHumanInputV1 as isPotentialHumanInput,
    readVerifiedSessionFollowHumanInputOriginalV1 as readVerifiedSessionFollowHumanInputOriginal,
    type SessionFollowRuleSourceEvidenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import type { SessionInputRequest, SessionMessageProvenance } from '@happier-dev/protocol';
import { settleSessionMessageProvenanceV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { isDeepStrictEqual } from 'node:util';
import type { TranscriptLookupOutcome } from '../../transcriptMessageLookup';
import type { CommittedUserMessageSeqTracker } from '../../committedUserMessageSeqTracker';
import { openSessionMessageContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';

export type HumanInputAdmission = Readonly<{ request: SessionInputRequest; provenance: SessionMessageProvenance }>;
export { readVerifiedSessionFollowHumanInputOriginal };

export function observeSessionFollowHumanInputCommit(input: Readonly<{
    localId: string;
    sessionId: string;
    admission: HumanInputAdmission;
    evidence: SessionFollowRuleSourceEvidenceV1 | null;
    tracker: CommittedUserMessageSeqTracker;
    signal: AbortSignal;
    readOriginal: () => Promise<TranscriptLookupOutcome>;
    notify: (original: Readonly<{ localId: string; seq: number; evidence: SessionFollowRuleSourceEvidenceV1; authorAccountId?: string }>) => Promise<void>;
    onError: (error: unknown) => void;
}> & SessionStoredContentCryptoContext): Readonly<{ settle: (accepted: boolean) => void; dispose: () => void }> {
    const evidence = input.evidence;
    if (!evidence || evidence.event.kind !== 'person_wrote' || !isPotentialHumanInput(input.admission) || input.signal.aborted) {
        return { settle: () => {}, dispose: () => {} };
    }
    let accepted = false;
    let retired = false;
    let observing = false;
    let seq: number | null = input.tracker.get(input.localId);
    let unsubscribe: (() => void) | undefined;
    const dispose = () => {
        retired = true;
        unsubscribe?.();
        input.signal.removeEventListener('abort', dispose);
    };
    const verifyOriginal = async (committedSeq: number) => {
        const original = await input.readOriginal();
        if (retired || input.signal.aborted || original.type !== 'found') return;
        const row = original.message;
        if (row.localId !== input.localId || row.seq !== committedSeq) return;
        const body = openSessionMessageContent({ ...input, content: row.content });
        const meta = body && typeof body === 'object' && 'meta' in body ? body.meta : null;
        const verified = readVerifiedSessionFollowHumanInputOriginal({ sessionId: input.sessionId,
            ownerAccountId: evidence.ownerAccountId, row, meta });
        if (!verified) return;
        const { request, provenance } = verified;
        if (!isDeepStrictEqual(request, input.admission.request)
            || !isDeepStrictEqual(provenance, settleSessionMessageProvenanceV1({ request,
                requestedProvenance: input.admission.provenance, inputAdmissionReceipt: row.inputAdmissionReceipt }))) return;
        if (!meta || typeof meta !== 'object'
            || !isDeepStrictEqual((meta as Record<string, unknown>)[SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1],
                projectSessionFollowRuleSharedSourceEvidenceV1(evidence))) return;
        await input.notify({ localId: input.localId, seq: committedSeq, evidence,
            ...(verified.authorAccountId ? { authorAccountId: verified.authorAccountId } : {}) });
    };
    const reconcile = () => {
        if (retired || observing || !accepted || seq === null || seq <= 0) return;
        observing = true;
        unsubscribe?.();
        // The existing tracker only locates the original; its role hint cannot assert humanity.
        void verifyOriginal(seq).catch(input.onError).finally(dispose);
    };
    unsubscribe = input.tracker.subscribe(observation => {
        if (observation.localId !== input.localId) return;
        seq = observation.seq;
        reconcile();
    });
    input.signal.addEventListener('abort', dispose, { once: true });
    return { dispose, settle: admitted => {
        if (!admitted) { dispose(); return; }
        accepted = true;
        reconcile();
    } };
}

/** Metadata preparation at the protected original input boundary. */
export function prepareSessionFollowHumanInputMetadata(input: Readonly<{
    meta?: Record<string, unknown>;
    admission: HumanInputAdmission;
    evidence: SessionFollowRuleSourceEvidenceV1 | null;
}>): Record<string, unknown> {
    const { [SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1]: _authoredEvidence, ...meta } = input.meta ?? {};
    return { ...meta, ...(input.evidence?.event.kind === 'person_wrote' && isPotentialHumanInput(input.admission)
        ? { [SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1]: projectSessionFollowRuleSharedSourceEvidenceV1(input.evidence) } : {}) };
}
