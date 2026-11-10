import { createWorkflowDefinitionActions as createSharedWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import type { WorkflowPluginSourceReaderV1 } from '@happier-dev/protocol';

import { encodeAccountArtifactListCursor, type createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { createWorkflowMaterializationHostV1 } from './workflowMaterializationHost';

/** CLI crypto/transport adapts the shared atomic definition and admission owners. */
export function createWorkflowDefinitionActions(params: Readonly<{
  artifactStore: ReturnType<typeof createAccountArtifactStore>;
  removeWorkflowTriggers?: Parameters<typeof createSharedWorkflowDefinitionActions>[0]['removeWorkflowTriggers'];
  resolveMaterializer?: ReturnType<typeof createWorkflowMaterializationHostV1>;
  readPluginWorkflows?: WorkflowPluginSourceReaderV1;
  readWorkflowTriggerSummaries?: Parameters<typeof createSharedWorkflowDefinitionActions>[0]['readWorkflowTriggerSummaries'];
}>) {
  return createSharedWorkflowDefinitionActions({
    artifactStore: params.artifactStore,
    encodeListCursor: encodeAccountArtifactListCursor,
    readPluginWorkflows: params.readPluginWorkflows ?? (async () => {
      const [{ readPluginWorkflowSources }, { readCurrentContributionRegistry }] = await Promise.all([
        import('@/plugins/projection/registry/workflows'),
        import('@/agent/catalog/snapshot'),
      ]);
      return readPluginWorkflowSources(readCurrentContributionRegistry());
    }),
    ...(params.readWorkflowTriggerSummaries ? { readWorkflowTriggerSummaries: params.readWorkflowTriggerSummaries } : {}),
    ...(params.removeWorkflowTriggers ? { removeWorkflowTriggers: params.removeWorkflowTriggers } : {}),
    ...(params.resolveMaterializer ? { resolveMaterializer: params.resolveMaterializer } : {}),
  });
}
