import { WorkflowDefinitionV1Schema, type WorkflowActionLeafV1 } from '@happier-dev/protocol/workflows/workflowV1';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storeWorkflowDefinitionDraftSeed, type WorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';

export type WorkflowSentenceEditorIntent = Readonly<Pick<WorkflowDefinitionDraftSeed,
    'name' | 'description' | 'definition' | 'trigger' | 'payloadSchema' | 'eventSeed' | 'project' | 'executionTarget'> & {
    step?: WorkflowActionLeafV1;
}>;

/** All verbs keep their ordinary Action and field bindings; the mounted editor owns Save and its retry identity. */
export function prepareWorkflowSentenceEditorEntry(intent: WorkflowSentenceEditorIntent, accountLifetime: ServerAccountScopeLifetime) {
    if (!accountLifetime.isCurrent()) return null;
    const { step, ...seed } = intent;
    const definition = step === undefined ? seed.definition : WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [step] });
    const definitionDraftSeedId = storeWorkflowDefinitionDraftSeed({ ...seed, ...(definition === undefined ? {} : { definition }), initialView: 'sentence' }, accountLifetime);
    return { pathname: '/workflows/[id]' as const, params: { id: 'new', definitionDraftSeedId, serverId: accountLifetime.scope.serverId } };
}
