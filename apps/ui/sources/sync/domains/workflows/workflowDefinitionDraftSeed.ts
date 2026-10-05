import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getTempData, storeTempData } from '@/utils/sessions/tempDataStore';

/** Portable authoring copy only: no Artifact identity, placement, grants or triggers. */
export type WorkflowDefinitionDraftSeed = Readonly<{
    name: string;
    description?: string;
    definition: WorkflowDefinitionV1;
}>;

type StoredDefinitionDraftSeed = Readonly<{
    kind: 'workflow-definition-draft-seed';
    seed: WorkflowDefinitionDraftSeed;
    lifetime: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
}>;

export function storeWorkflowDefinitionDraftSeed(seed: WorkflowDefinitionDraftSeed): string {
    return storeTempData({
        kind: 'workflow-definition-draft-seed',
        seed,
        lifetime: captureActiveServerAccountScopeLifetime(),
    } satisfies StoredDefinitionDraftSeed);
}

export function readWorkflowDefinitionDraftSeed(id: string): WorkflowDefinitionDraftSeed | null {
    const stored = getTempData<StoredDefinitionDraftSeed>(id);
    return stored?.kind === 'workflow-definition-draft-seed' && stored.lifetime?.isCurrent() ? stored.seed : null;
}
