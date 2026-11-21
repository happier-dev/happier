import { WorkflowDefinitionArtifactHeaderV1ReadSchema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readWorkflowDefinitionLibraryTitle } from './workflowProblemPresentation';

/** Undefined denotes an absent header. Null denotes a Workflow header without a readable title. */
export function workflowReferenceHeaderTitle(header: DecryptedArtifact['rawHeader'] | null | undefined): string | null | undefined {
    if (header?.kind !== 'workflow-definition.v1') return undefined;
    const metadata = WorkflowDefinitionArtifactHeaderV1ReadSchema.shape.metadata.safeParse(header.metadata);
    return readWorkflowDefinitionLibraryTitle({ metadata: metadata.success ? metadata.data : null });
}

export async function readWorkflowReferenceHeaderTitles(
    ids: readonly string[],
    lifetime: ServerAccountScopeLifetime,
    signal?: AbortSignal,
): Promise<readonly (string | null | undefined)[]> {
    const account = await captureLazyActionAccountContext(lifetime.scope.serverId, signal, undefined, lifetime.scope);
    try {
        if (!lifetime.isCurrent()) return [];
        const rows = await account.readArtifactHeaders(ids, { signal });
        return rows.map(row => {
            const artifact = row.status === 'fulfilled' ? row.value : null;
            return workflowReferenceHeaderTitle(artifact?.isDecrypted && artifact.ownerAccountId && artifact.access
                ? artifact.rawHeader : null);
        });
    } finally { account.dispose(); }
}
