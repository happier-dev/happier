import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

/** One body-authoritative acquisition for every approval family. */
export function createApprovalArtifactAccess(deps: Readonly<{
    read: (artifactId: string) => Promise<DecryptedArtifact | null>;
    local?: (artifactId: string) => DecryptedArtifact | null;
    publish?: (artifact: DecryptedArtifact) => void;
    /** Only invocation-scoped owners may lend their acquisition to the first CAS. */
    reuseWriteBasis?: boolean;
}>) {
    let writeBasis: DecryptedArtifact | null = null;
    const get: NonNullable<ActionExecutorDeps['approvalsGet']> = async ({ artifactId }) => {
        const local = deps.local?.(artifactId);
        if (local?.header && typeof local.body === 'string') {
            const parsed = approvalArtifactBodyMatchesHeaderV1(local.header, local.body);
            if (parsed) return parsed.request;
        }
        // Consent acquires current content independently of ordinary cached reads.
        const full = await deps.read(artifactId);
        if (deps.reuseWriteBasis) writeBasis = full;
        if (!full) return null;
        deps.publish?.(full);
        return full.header && typeof full.body === 'string'
            ? approvalArtifactBodyMatchesHeaderV1(full.header, full.body)?.request ?? null : null;
    };
    return {
        get,
        takeWriteBasis: (artifactId: string) => {
            const acquired = writeBasis?.id === artifactId ? writeBasis : null;
            // Consume even on refusal/conflict. Later transitions read afresh;
            // the writer validates this body's transition and keeps its CAS versions.
            writeBasis = null;
            return acquired;
        },
    };
}
