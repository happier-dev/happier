import { createWorkflowActionExecutor } from './workflowAccountActions.js';
import { createWorkflowDefinitionActions } from './workflowDefinitions.js';
import { createWorkflowTriggerActions } from './workflowTriggerActions.js';
import type { ActionExecutorDeps, WorkflowActionExecute } from './types.js';

/** Real Workflow owners over an empty persistent Account; unexpected writes fail loudly. */
export function createEmptyWorkflowActionHost(
  sessionReads: Pick<ActionExecutorDeps, 'sessionRead' | 'resolveServerProfileScopeId'> = {},
): WorkflowActionExecute {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected empty Workflow host operation'); };
  const definitions = createWorkflowDefinitionActions({
    artifactStore: { read: async () => null, list: async () => ({ items: [] }),
      create: unexpected, update: unexpected, delete: unexpected },
    encodeListCursor: row => row.artifactId,
    assertDefinitionWriteAllowed: unexpected,
  });
  const triggers = createWorkflowTriggerActions({
    ...sessionReads,
    // Artifact and Automation persistence are the only substituted boundaries.
    automations: { list: async () => ({ automations: [], nextCursor: null }),
      listDetails: async () => ({ automations: [], nextCursor: null }), get: async () => null,
      create: unexpected, reconcile: unexpected, delete: unexpected },
    resolveWorkflow: unexpected, openContext: unexpected, sealContext: unexpected,
    newId: () => { throw new Error('Unexpected empty Workflow host identity allocation'); },
  });
  return createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true,
    definitions, triggers, runs: { execute: unexpected } });
}
