import {
  DeploymentPublishPrepareInputV1Schema,
  DeploymentPublishPrepareResultV1Schema,
  type DeploymentPublishPrepareInputV1,
  type DeploymentPublishPrepareResultV1,
  type DeploymentTemplateV1,
  type ActionExecutorContext,
} from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { resolveDeploymentCreationDefaultsV1 } from '@happier-dev/deployments';
import type { DeploymentCreationDefaultInputsForHost } from '@/deployments/readCreationDefaultsForHost';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** The catalog entry shares P45 selection and P40 defaults; it cannot create an effect operand. */
export function createPublishCatalogPreparation(host: Readonly<{
  readSelection(input: DeploymentPublishPrepareInputV1, context: ActionExecutorContext): Promise<Readonly<{
    source?: ProjectSourceV1;
    newProject?: DeploymentPublishPrepareInputV1['newProject'];
    template: DeploymentTemplateV1;
    defaultInputs: DeploymentCreationDefaultInputsForHost;
  }>>;
}>) {
  return async (raw: DeploymentPublishPrepareInputV1, context: ActionExecutorContext): Promise<DeploymentPublishPrepareResultV1 | ActionExecuteFailure> => {
    try {
      const input = DeploymentPublishPrepareInputV1Schema.parse(raw);
      const selected = await host.readSelection(input, context);
      if (input.newProject ? !sameStrictJsonValue(input.newProject, selected.newProject)
        : selected.source?.id !== input.projectSourceId || selected.source?.revision !== input.sourceRevision) return failure('source_changed');
      const owner = selected.newProject?.owner ?? selected.source?.owner
        ?? (selected.source ? { kind: 'account' as const, accountId: selected.source.createdByAccountId } : undefined);
      if (!owner) return failure('source_changed');
      const creationDefaults = resolveDeploymentCreationDefaultsV1({ projectSourceId: input.projectSourceId,
        projectOwner: owner, ...selected.defaultInputs, explicit: input.explicit,
        target: { kind: 'ownServer', machines: [input.machineId] } });
      context.signal?.throwIfAborted();
      return DeploymentPublishPrepareResultV1Schema.parse({ kind: 'prepared', templateRef: input.templateRef,
        project: selected.newProject ? { newProject: selected.newProject, owner }
          : { projectSourceId: selected.source?.id, sourceRevision: selected.source?.revision, owner },
        machine: { machineId: input.machineId, installationId: input.installationId }, template: selected.template,
        creationDefaults, ...(selected.defaultInputs.reviewBasis ? { creationDefaultsBasis: selected.defaultInputs.reviewBasis } : {}) });
    } catch (error) {
      return failure(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'deployment_unavailable');
    }
  };
}
