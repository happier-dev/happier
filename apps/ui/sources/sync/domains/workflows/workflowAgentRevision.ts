import type { WorkflowDefinitionGetResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getTempData, storeTempData } from '@/utils/sessions/tempDataStore';

/** Exact saved definition and metadata acknowledged by a successful Action. */
export type WorkflowAgentRevision = Readonly<Pick<WorkflowDefinitionGetResultV1,
    'definitionId' | 'definition' | 'revision' | 'metadata' | 'savedBy' | 'savedAt'
> & { changedBlockIds: readonly string[] }>;

const KIND = 'workflow-agent-revision';
type StoredRevision = Readonly<{
    kind: typeof KIND;
    snapshot: WorkflowAgentRevision;
    sessionId: string;
    lifetime: ReturnType<typeof captureActiveServerAccountScopeLifetime>;
}>;

export function storeWorkflowAgentRevision(snapshot: WorkflowAgentRevision, sessionId: string): string {
    return storeTempData({ kind: KIND, snapshot, sessionId, lifetime: captureActiveServerAccountScopeLifetime() } satisfies StoredRevision);
}

export function readWorkflowAgentRevision(seedId: string): StoredRevision | null {
    const seed = getTempData<StoredRevision>(seedId);
    return seed?.kind === KIND && seed.lifetime?.isCurrent() ? seed : null;
}
