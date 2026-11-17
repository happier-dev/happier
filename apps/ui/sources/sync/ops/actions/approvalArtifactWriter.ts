import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createApprovalRequestArtifact, decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ApprovalRequestUpdateSchema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { admitTargetActionApprovalTransition, settleTargetActionApprovalReplayInputs } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';

import type { ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { randomUUID } from 'expo-crypto';
import type { ArtifactIdScopeV1 } from '@happier-dev/protocol';

/** Creation and settlement adapt the same private Artifact authority. */
export async function createApprovalArtifact(input: Readonly<{
    request: ApprovalRequest;
    accountId: string;
    read: (artifactId: string) => Promise<DecryptedArtifact | null>;
    create: (artifactId: string, header: ArtifactHeader, body: string, idScope?: ArtifactIdScopeV1) => Promise<DecryptedArtifact>;
}>) {
    const opened = (artifact: DecryptedArtifact) => {
        if (!artifact.isDecrypted || !artifact.rawHeader) {
            throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
        }
        return { header: artifact.rawHeader, body: artifact.body, access: artifact.access };
    };
    return createApprovalRequestArtifact({ ...input, newId: randomUUID,
        read: async artifactId => {
            const artifact = await input.read(artifactId);
            return artifact ? opened(artifact) : null;
        },
        create: async (artifactId, header, body, idScope) => opened(await input.create(artifactId, header, body, idScope)),
    });
}

export type ApprovalArtifactWriteResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; errorCode: string; error: string; writeCommitted?: false }>;

/**
 * The UI adapter of the Protocol approval subject/transition owner — the same
 * contract the CLI/daemon Artifact store enforces.
 *
 * It validates the proposed request against the acquired stored row and
 * commits it with that row's versions as the Artifact CAS basis. The first
 * decision may reuse its invocation's acquisition; later transitions read afresh. A write that
 * lost a race therefore fails instead of landing on whatever version is newest,
 * which is what makes `approved -> executing` the single effect claim.
 */
export async function writeApprovalRequestArtifact(input: Readonly<{
    artifactId: string;
    request: ApprovalRequest | TargetActionApprovalRequestV1;
    expectedStatus?: ApprovalRequest['status'];
    read: (artifactId: string) => Promise<DecryptedArtifact | null>;
    /** Writes `header`/`body` with `basis`'s versions as the expected versions. */
    write: (basis: DecryptedArtifact, header: ArtifactHeader, body: string) => Promise<void>;
}>): Promise<ApprovalArtifactWriteResult> {
    const current = await input.read(input.artifactId);
    if (!current || !current.header || typeof current.body !== 'string') {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found', writeCommitted: false };
    }
    const stored = approvalArtifactBodyMatchesHeaderV1(current.header, current.body);
    let header: ArtifactHeader;
    let request: ApprovalRequest | TargetActionApprovalRequestV1;
    const target = TargetActionApprovalRequestV1Schema.safeParse(input.request);
    if (target.success) {
        if (stored?.family !== 'target_action') {
            return { ok: false, errorCode: 'subject_mismatch', error: 'target_action_approval_subject_mismatch', writeCommitted: false };
        }
        const transition = admitTargetActionApprovalTransition(stored.request, target.data);
        if (!transition.ok) return { ...transition, writeCommitted: false };
        if (transition.unchanged) return { ok: true };
        request = settleTargetActionApprovalReplayInputs(target.data);
        header = buildTargetActionApprovalArtifactHeaderV1(request);
    } else {
        const builtIn = ApprovalRequestUpdateSchema.safeParse(input.request);
        if (stored?.family !== 'built_in' || !builtIn.success) {
            return { ok: false, errorCode: 'subject_mismatch', error: 'approval_request_subject_mismatch', writeCommitted: false };
        }
        const transition = decideApprovalRequestTransition(stored.request, builtIn.data, { expectedStatus: input.expectedStatus });
        if (!transition.ok) return { ...transition, writeCommitted: false };
        if (!transition.changed) return { ok: true };
        // V1's retained Home marker is history indexing, never replay authority.
        // Preserve it from this validated CAS basis; V2 still uses its body origin.
        const legacyServerId = stored.request.v === 1 && typeof current.header.serverId === 'string'
            ? current.header.serverId : null;
        request = builtIn.data;
        header = buildApprovalRequestArtifactHeaderV1(builtIn.data, { legacyServerId });
    }
    try {
        await input.write(current, header, JSON.stringify(request));
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'version_mismatch') {
            return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch',
                ...('writeCommitted' in error && error.writeCommitted === false ? { writeCommitted: false as const } : {}) };
        }
        throw error;
    }
    return { ok: true };
}
