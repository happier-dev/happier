import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { projectApprovalExecutionFailureV2 } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { settleApprovalRequestReplayInputs } from '@happier-dev/protocol/approvals/approvalRequestTransition';

import type { ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { writeApprovalRequestArtifact } from './approvalArtifactWriter';

function claimKey(scope: ServerAccountScope, artifactId: string): string {
    return `happier:approval-claim:${JSON.stringify([scope.serverId, scope.accountId, artifactId])}`;
}

function claimRevision(artifact: DecryptedArtifact): string | null {
    return artifact.bodyVersion === undefined ? null
        : JSON.stringify([artifact.createdAt, artifact.headerVersion, artifact.bodyVersion]);
}

export type BrowserApprovalClaim = Readonly<{ release: () => void; settled: () => void }>;

/** Hold browser-local custody from the acknowledged executing CAS through the invocation. */
export async function retainBrowserApprovalClaim(scope: ServerAccountScope, artifact: DecryptedArtifact): Promise<BrowserApprovalClaim | null> {
    const locks = globalThis.navigator?.locks;
    const revision = claimRevision(artifact);
    if (!locks || !revision) return null;
    const key = claimKey(scope, artifact.id);
    return await new Promise<BrowserApprovalClaim | null>(resolve => {
        void locks.request(key, { ifAvailable: true }, lock => {
            if (!lock || !globalThis.localStorage) return resolve(null);
            const storage = globalThis.localStorage;
            return new Promise<void>(release => {
                storage.setItem(key, revision);
                resolve({
                    release,
                    settled: () => {
                        try { storage.removeItem(key); } catch { /* The Home already acknowledged settlement. */ }
                        release();
                    },
                });
            });
        }).catch(() => resolve(null));
    });
}

/** An exact acknowledged revision and a released document lock are both required for recovery. */
export async function recoverBrowserApprovalClaim(input: Readonly<{
    scope: ServerAccountScope;
    artifact: DecryptedArtifact;
    write: (basis: DecryptedArtifact, header: ArtifactHeader, body: string) => Promise<DecryptedArtifact | null>;
}>): Promise<DecryptedArtifact | null> {
    const { artifact } = input;
    const { rawHeader, body } = artifact;
    if (!artifact.isDecrypted || !rawHeader || typeof body !== 'string') return null;
    const locks = globalThis.navigator?.locks;
    if (!locks) return null;
    const key = claimKey(input.scope, artifact.id);
    const revision = claimRevision(artifact);
    try {
        const storage = globalThis.localStorage;
        if (!storage || !revision || storage.getItem(key) !== revision) return null;
        return await locks.request(key, { ifAvailable: true }, async lock => {
            if (!lock || storage.getItem(key) !== revision) return null;
            const parsed = approvalArtifactBodyMatchesHeaderV1(rawHeader, body);
            if (parsed?.family !== 'built_in' || parsed.request.v !== 2 || parsed.request.status !== 'executing') return null;

            const executedAtMs = Math.max(Date.now(), parsed.request.updatedAtMs);
            const request = {
                ...settleApprovalRequestReplayInputs(parsed.request),
                status: 'outcome_unknown', updatedAtMs: executedAtMs,
                execution: projectApprovalExecutionFailureV2({ request: parsed.request, executedAtMs,
                    failure: { ok: false, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' } }),
            } as const;
            let committed: DecryptedArtifact | null = null;
            const result = await writeApprovalRequestArtifact({
                artifactId: artifact.id, request, expectedStatus: 'executing', read: async () => artifact,
                write: async (basis, header, body) => { committed = await input.write(basis, header, body); },
            });
            if (!result.ok || !committed) return null;
            try { storage.removeItem(key); } catch { /* The Home already acknowledged settlement. */ }
            return committed;
        });
    } catch {
        // Leave the local witness available for the next exact read if settlement fails.
        return null;
    }
}
