import { admitAgentStartV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { createWorkflowDefinitionActions as createSharedWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { materializeWorkflowDefinitionAuthorityV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { SessionAgentSpawnPolicyV1StrictSchema } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';
import type { WorkflowPluginSourceReaderV1 } from '@happier-dev/protocol';

import { encodeAccountArtifactListCursor, type createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { createWorkflowMaterializationHostV1 } from './workflowMaterializationHost';
import { readPluginWorkflowSources } from '@/plugins/projection/registry/workflows';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';

/** CLI crypto/transport adapts the shared atomic definition and admission owners. */
export function createWorkflowDefinitionActions(params: Readonly<{
  artifactStore: ReturnType<typeof createAccountArtifactStore>;
  removeWorkflowTriggers?: (definitionId: string) => Promise<void>;
  resolveMaterializer?: ReturnType<typeof createWorkflowMaterializationHostV1>;
  readPluginWorkflows?: WorkflowPluginSourceReaderV1;
  readWorkflowTriggerSummaries?: Parameters<typeof createSharedWorkflowDefinitionActions>[0]['readWorkflowTriggerSummaries'];
}>) {
  return createSharedWorkflowDefinitionActions({
    artifactStore: params.artifactStore,
    encodeListCursor: encodeAccountArtifactListCursor,
    readPluginWorkflows: params.readPluginWorkflows ?? (() => readPluginWorkflowSources(readCurrentContributionRegistry())),
    ...(params.readWorkflowTriggerSummaries ? { readWorkflowTriggerSummaries: params.readWorkflowTriggerSummaries } : {}),
    ...(params.removeWorkflowTriggers ? { removeWorkflowTriggers: params.removeWorkflowTriggers } : {}),
    assertDefinitionWriteAllowed: async (definition, context, caller) => {
      if (caller?.surface !== 'agent') return;
      const policy = SessionAgentSpawnPolicyV1StrictSchema.safeParse(caller.sessionAgentSpawnPolicyV1);
      const authority = caller.agentStartContext;
      if (!policy.success || !authority || !params.resolveMaterializer) {
        throw Object.assign(new Error('definition_exceeds_authority'), {
          code: 'definition_exceeds_authority', details: { code: 'definition_exceeds_authority', cause: { code: 'target_unavailable' } },
        });
      }
      const { machineId, directory } = authority.baseline;
      const originSessionId = authority.caller.kind === 'session'
        ? authority.caller.sessionId : authority.caller.runOriginSessionId;
      const materialization = await params.resolveMaterializer({ machineId, directory,
        ...(caller.signal ? { signal: caller.signal } : {}) });
      const materialized = await materializeWorkflowDefinitionAuthorityV1({
        definition, ...(context ? { ingressContext: context } : {}), ...materialization,
        context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
          workspaceTarget: { project: { machineId, directory, checkoutRootPath: directory } },
          origin: { kind: 'direct', ...(originSessionId ? { originSessionId } : {}) },
          authorization: { principal: { kind: 'host' } } },
      });
      if (!materialized.ok) throw Object.assign(new Error(materialized.error.code), {
        code: materialized.error.code, details: materialized.error,
      });
      // Workflow-local pins are resolved by the same materializer, not mutable
      // Settings membership. They add selection facts, never policy authority.
      for (const sourceKey of new Set(materialized.agentStartLeaves.map((leaf) => leaf.sourceKey ?? '$root'))) {
        const roles = { ...authority.roles };
        for (const leaf of materialized.materializedLeaves) {
          if (leaf.sourceKey === sourceKey && leaf.role) roles[leaf.role.roleId] = leaf.role;
        }
        const admission = admitAgentStartV1(policy.data, { kind: 'definition_write',
          leaves: materialized.agentStartLeaves.filter((leaf) => (leaf.sourceKey ?? '$root') === sourceKey),
        }, { ...authority, roles });
        if (!admission.ok) throw Object.assign(new Error(admission.refusal.code), {
          code: admission.refusal.code, details: admission.refusal,
        });
      }
    },
  });
}
