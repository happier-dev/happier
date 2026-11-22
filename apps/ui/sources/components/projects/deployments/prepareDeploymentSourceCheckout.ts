import type { DeploymentEnvironmentDetailV1, DeploymentSourceMethodV1 } from '@happier-dev/deployments/contracts/v1';
import { resolveDeploymentSourceMethodV1 } from '@happier-dev/deployments/contracts/v1';
import { OpenProjectRefusalV1Schema, OpenProjectResultV1Schema, projectOpenProjectRefusalV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { selectSourceCheckoutWorkspaceRefs } from '@/sync/domains/workspaces/workspaceRefs';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { buildProjectOpenDraft, buildProjectOpenInput, suggestProjectOpenDestination, type ProjectOpenChoiceState } from '../activation/projectOpenChoices';

/** The app's Deploy gesture prepares its Source through Open's ordinary destination review, never deploy authority. */
export async function prepareDeploymentSourceCheckout(
  lifetime: ServerAccountScopeLifetime,
  detail: DeploymentEnvironmentDetailV1,
  resolveSource: () => Promise<ProjectSourceV1 | null>,
  sourceMethod?: DeploymentSourceMethodV1,
): Promise<void> {
  if (detail.content.definition.kind !== 'repository') return;
  const target = detail.targetLinks.find(row => row.targetLink.id === detail.environment.runtimeTargetLinkId);
  if (target?.targetLink.source.kind === 'plugin' && resolveDeploymentSourceMethodV1({
    explicit: sourceMethod, recorded: target.content?.sourceMethod,
  }) === 'gitIntegration') return;
  const source = await resolveSource();
  if (!lifetime.isCurrent()) throw new HappyError('action_account_scope_changed', false, { code: 'action_account_scope_changed' });
  const account = await captureLazyActionAccountContext(lifetime.scope.serverId);
  try {
    const machineId = detail.environment.controllerMachineId;
    const hasMatchingCheckout = (checkouts: readonly WorkspaceRefV1[]) => source !== null
      && selectSourceCheckoutWorkspaceRefs(checkouts, source.id, lifetime.scope.serverId)
        .some(ref => ref.machineId === machineId && ref.source?.revision === source.revision);
    // A CLI Open can register the exact checkout before its update reaches this app's held rows.
    const { workspaceRefs: checkouts } = await createUiProjectAccountRowsClient(account).read(undefined,
      rows => source === null || hasMatchingCheckout(rows.workspaceRefs));
    if (hasMatchingCheckout(checkouts)) return;
    if (!source?.repository) throw new HappyError('deployment_source_unavailable', false, { code: 'deployment_source_unavailable' });
    const machineHomeDir = resolveServerScopedMachine(storage.getState(), lifetime.scope.serverId, machineId)?.metadata?.homeDir ?? null;
    const choice: ProjectOpenChoiceState = {
      serverId: lifetime.scope.serverId, machineId, machineHomeDir,
      subject: { kind: 'source', source }, ref: detail.content.definition.ref, use: 'clone',
      branch: '', destination: '', checkouts,
    };
    const input = buildProjectOpenInput(buildProjectOpenDraft({ ...choice, destination: suggestProjectOpenDestination(choice) }), checkouts);
    if (!input) throw new HappyError('invalid_parameters', false, { code: 'invalid_parameters' });
    const executed = await createFrontDoorActionExecute()('projects.open', input, {
      surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
    });
    const refused = OpenProjectRefusalV1Schema.safeParse(executed.ok ? executed.result : executed.details);
    if (refused.success) {
      const failure = projectOpenProjectRefusalV1(refused.data);
      const code = refused.data.remediation?.kind === 'unsupported_provider' ? 'deployment_source_clone_failed' : failure.errorCode;
      throw new HappyError(code, false, { code, details: failure.details, failureCause: failure.failureCause,
        effectAttempted: failure.effectAttempted, ...(!executed.ok && executed.requestId ? { requestId: executed.requestId } : {}) });
    }
    requireActionSuccess(executed, 'projects.open');
    const result = OpenProjectResultV1Schema.parse(executed.result);
    if (result.kind !== 'opened') throw new HappyError('outcome_unknown', false, { code: 'outcome_unknown', details: result });
  } finally { account.dispose(); }
}
