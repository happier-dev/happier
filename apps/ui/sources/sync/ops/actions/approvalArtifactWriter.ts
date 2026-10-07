import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import type { ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

export type ApprovalArtifactWriteResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; errorCode: string; error: string }>;

// The one message the Artifact codec raises for a stale expected version.
const ARTIFACT_VERSION_CONFLICT_MESSAGE = 'modified by another client';

/**
 * The UI adapter of the Protocol approval subject/transition owner — the same
 * contract the CLI/daemon Artifact store enforces.
 *
 * It validates the proposed request against a fresh read of the stored one and
 * commits it with that read's versions as the Artifact CAS basis. A write that
 * lost a race therefore fails instead of landing on whatever version is newest,
 * which is what makes `approved -> executing` the single effect claim.
 */
export async function writeApprovalRequestArtifact(input: Readonly<{
    artifactId: string;
    request: ApprovalRequest;
    read: (artifactId: string) => Promise<DecryptedArtifact | null>;
    /** Writes `header`/`body` with `basis`'s versions as the expected versions. */
    write: (basis: DecryptedArtifact, header: ArtifactHeader, body: string) => Promise<void>;
}>): Promise<ApprovalArtifactWriteResult> {
    const current = await input.read(input.artifactId);
    if (!current || !current.header || typeof current.body !== 'string') {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
    }
    const stored = approvalArtifactBodyMatchesHeaderV1(current.header, current.body);
    if (stored?.family !== 'built_in') {
        return { ok: false, errorCode: 'subject_mismatch', error: 'approval_request_subject_mismatch' };
    }
    const transition = decideApprovalRequestTransition(stored.request, input.request);
    if (!transition.ok) return transition;
    if (!transition.changed) return { ok: true };
    try {
        await input.write(current, buildApprovalRequestArtifactHeaderV1(input.request), JSON.stringify(input.request));
    } catch (error) {
        if (error instanceof Error && error.message.includes(ARTIFACT_VERSION_CONFLICT_MESSAGE)) {
            return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
        }
        throw error;
    }
    return { ok: true };
}
