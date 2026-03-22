import type { ReviewFinding, ReviewFollowUpV1 } from '@happier-dev/protocol';
import { ReviewFollowUpV1Schema as ReviewFollowUpSchema } from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { parseHappierMetaEnvelope } from '@/components/sessions/transcript/structured/happierMetaEnvelope';

type RunRef = Readonly<{
    runId: string;
    callId: string;
    backendId: string;
}>;

export type EffectiveReviewFindings = Readonly<{
    findings: readonly ReviewFinding[];
    threadRefsByFindingId: Readonly<Record<string, readonly string[]>>;
}>;

function isSameRunRef(left: RunRef, right: RunRef): boolean {
    return left.runId === right.runId
        && left.callId === right.callId
        && left.backendId === right.backendId;
}

function parseReviewFollowUp(message: Message): ReviewFollowUpV1 | null {
    const envelope = parseHappierMetaEnvelope(message.meta);
    if (!envelope || envelope.kind !== 'review_follow_up.v1') return null;
    const parsed = ReviewFollowUpSchema.safeParse(envelope.payload);
    if (!parsed.success) return null;
    return parsed.data;
}

export function resolveEffectiveReviewFindings(params: Readonly<{
    runRef: RunRef;
    initialFindings: readonly ReviewFinding[];
    messages: readonly Message[];
}>): EffectiveReviewFindings {
    const findingById = new Map<string, ReviewFinding>();
    const orderedFindingIds: string[] = [];
    const threadRefsByFindingId = new Map<string, string[]>();

    for (const finding of params.initialFindings) {
        if (findingById.has(finding.id)) continue;
        orderedFindingIds.push(finding.id);
        findingById.set(finding.id, finding);
    }

    for (const message of params.messages) {
        const followUp = parseReviewFollowUp(message);
        if (!followUp || !isSameRunRef(followUp.parentRunRef, params.runRef)) continue;
        if (!Array.isArray(followUp.updatedFindings) || followUp.updatedFindings.length === 0) continue;

        for (const finding of followUp.updatedFindings) {
            if (!findingById.has(finding.id)) {
                orderedFindingIds.push(finding.id);
            }
            findingById.set(finding.id, finding);

            const threadRefs = threadRefsByFindingId.get(finding.id) ?? [];
            if (!threadRefs.includes(followUp.threadId)) {
                threadRefs.push(followUp.threadId);
            }
            threadRefsByFindingId.set(finding.id, threadRefs);
        }
    }

    return {
        findings: orderedFindingIds
            .map((findingId) => findingById.get(findingId))
            .filter((finding): finding is ReviewFinding => Boolean(finding)),
        threadRefsByFindingId: Object.fromEntries(
            Array.from(threadRefsByFindingId.entries()).map(([findingId, threadRefs]) => [
                findingId,
                [...threadRefs],
            ]),
        ),
    };
}
