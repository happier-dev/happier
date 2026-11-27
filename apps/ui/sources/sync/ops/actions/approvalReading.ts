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
    const read = async (artifactId: string) => {
        const full = await deps.read(artifactId);
        if (deps.reuseWriteBasis) writeBasis = full;
        if (!full) return { kind: 'missing' } as const;
        deps.publish?.(full);
        const request = full.header && typeof full.body === 'string'
            ? approvalArtifactBodyMatchesHeaderV1(full.header, full.body)?.request : undefined;
        return request ? { kind: 'found', request } as const : { kind: 'unavailable' } as const;
    };
    const get: NonNullable<ActionExecutorDeps['approvalsGet']> = async ({ artifactId }) => {
        const local = deps.local?.(artifactId);
        if (local?.header && typeof local.body === 'string') {
            const parsed = approvalArtifactBodyMatchesHeaderV1(local.header, local.body);
            if (parsed) return parsed.request;
        }
        // Consent acquires current content independently of ordinary cached reads.
        const current = await read(artifactId);
        return current.kind === 'found' ? current.request : null;
    };
    return {
        get, read,
        takeWriteBasis: (artifactId: string) => {
            const acquired = writeBasis?.id === artifactId ? writeBasis : null;
            // Consume even on refusal/conflict so retries read afresh; a committed
            // write explicitly hands back its server-acknowledged revision below.
            writeBasis = null;
            return acquired;
        },
        rememberWriteBasis: (artifact: DecryptedArtifact | null) => {
            if (deps.reuseWriteBasis) writeBasis = artifact;
        },
    };
}
