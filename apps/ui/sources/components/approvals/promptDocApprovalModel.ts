import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ArtifactSavedByV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { readPromptDocInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';

type InstructionsDocument = Extract<Awaited<ReturnType<typeof readPromptDocInLibrary>>, { ok: true }>;
export type PromptDocInstructionWriteFacts = Readonly<{
    provenance: Readonly<{ changedBy?: ArtifactSavedByV1; approvedBy?: Readonly<{ kind: 'person'; accountId: string; decidedVia?: 'voice' }> }>;
    agentWriteResult: Readonly<{ status: 'pending' | 'updated' | 'denied' | 'conflict' | 'failed' | 'outcome_unknown' | 'canceled' }> | null;
    /** Latest executed receipt for this exact document, used to refresh its display once after settlement. */
    acceptedRevision?: InstructionsDocument['revision'];
}>;

/** Read existing accepted receipts, never infer authorship or approval from document timestamps. */
export function readPromptDocInstructionWriteFacts(document: InstructionsDocument, approvals: readonly ApprovalRequest[]): PromptDocInstructionWriteFacts {
    const provenance: { changedBy?: ArtifactSavedByV1; approvedBy?: Readonly<{ kind: 'person'; accountId: string; decidedVia?: 'voice' }> } =
        document.provenance ? { changedBy: document.provenance.savedBy } : {};
    let latest: ApprovalRequest | null = null;
    let acceptedRevision: InstructionsDocument['revision'] | undefined;
    for (const request of approvals) {
        const edit = readPromptDocUpdateApproval(request);
        if (!edit || edit.artifactId !== document.artifactId || !request.createdBy.sessionId) continue;
        if (!latest || request.createdAtMs > latest.createdAtMs) latest = request;
        if (request.status !== 'executed' || request.execution?.ok !== true) continue;
        const receipt = getActionSpec('prompt_doc.update').outputSchema?.safeParse(request.execution.result);
        if (!receipt?.success) continue;
        const accepted = receipt.data as Readonly<{ artifactId: string; revision?: InstructionsDocument['revision'] }>;
        if (accepted.artifactId !== document.artifactId) continue;
        if (accepted.revision && (!acceptedRevision || accepted.revision.bodyVersion > acceptedRevision.bodyVersion)) acceptedRevision = accepted.revision;
        // Header-only changes (favorite, title) do not replace the accepted body revision's actor.
        if (accepted.artifactId !== document.artifactId || accepted.revision?.bodyVersion !== document.revision.bodyVersion) continue;
        if (request.v === 2 && request.decision?.kind === 'approve'
            && request.decision.authority === 'present_user' && request.decision.decidingAccountId) {
            provenance.approvedBy = { kind: 'person', accountId: request.decision.decidingAccountId,
                ...(request.decision.decidedVia === 'voice' ? { decidedVia: 'voice' } : {}) };
        }
    }
    return { provenance, agentWriteResult: latest ? readPromptDocWriteOutcome(latest) : null,
        ...(acceptedRevision ? { acceptedRevision } : {}) };
}

function readPromptDocWriteOutcome(request: ApprovalRequest): NonNullable<PromptDocInstructionWriteFacts['agentWriteResult']> {
    return request.status === 'executed' && request.execution?.ok === true ? { status: 'updated' }
        : request.status === 'rejected' ? { status: 'denied' }
        : request.status === 'canceled' ? { status: 'canceled' }
        : request.status === 'outcome_unknown' ? { status: 'outcome_unknown' }
        : request.status === 'failed' ? { status: request.execution?.errorCode === 'version_mismatch' ? 'conflict' : 'failed' }
        : { status: 'pending' };
}

export type PromptDocUpdateApproval = Readonly<{
    artifactId: string;
    title: string;
    markdown: string;
    expectedRevision: Readonly<{ headerVersion: number; bodyVersion: number }> | null;
    /** Existing approval/result surface may render the accepted or denied outcome. */
    outcome?: NonNullable<PromptDocInstructionWriteFacts['agentWriteResult']>;
}>;

/** The edit reviewed by the existing diff surface, through the Action's input schema. */
export function readPromptDocUpdateApproval(approval: ApprovalRequest): PromptDocUpdateApproval | null {
    if (approval.actionId !== 'prompt_doc.update') return null;
    const parsed = getActionSpec('prompt_doc.update').inputSchema.safeParse(approval.actionArgs);
    if (!parsed.success) return null;
    const input = parsed.data as Readonly<{ artifactId: string; title: string; markdown: string;
        expectedRevision?: Readonly<{ headerVersion: number; bodyVersion: number }> }>;
    return { artifactId: input.artifactId, title: input.title, markdown: input.markdown,
        expectedRevision: input.expectedRevision ?? null, outcome: readPromptDocWriteOutcome(approval) };
}
