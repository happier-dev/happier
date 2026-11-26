import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { isDeploymentActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { PROJECT_READINESS_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/projectReadinessActionIdsV1';
import { MACHINE_SERVICE_ADOPT_ACTION_ID } from '@happier-dev/protocol/local/services/actionIdsV1';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1, MACHINE_SETUP_PLAN_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { readDeploymentDatabaseReadAccessSetupV1, type DeploymentReadAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';

/**
 * Roots whose effects (or reviewed children) run on this daemon's deployment owner. A database read setup that
 * Home admitted to bind its login (Attach, or Create Apply) issues one reviewed `deployments.bindings.set` child,
 * so its `action.invoke` root needs the same owner; Home's setup admission stays the only decision.
 */
export function needsDaemonDeploymentActionDeps(actionId: string, readAdmission: DeploymentReadAdmissionV1 | undefined): boolean {
  return isDeploymentActionIdV1(actionId)
    || actionId === PROJECT_READINESS_ACTION_IDS_V1[0]
    || actionId === MACHINE_SERVICE_ADOPT_ACTION_ID
    || actionId === MACHINE_SETUP_PLAN_ACTION_ID_V1 || actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1
    || actionId === ACTION_INVOKE_ACTION_ID_V1 && readDeploymentDatabaseReadAccessSetupV1(readAdmission)?.allowsBindingWrite === true;
}

type DeploymentDeps = ReturnType<typeof createDaemonDeploymentActionDeps>;
type DaemonDeploymentDeps = Pick<DeploymentDeps,
  | 'deploymentAction' | 'deploymentTelemetrySet' | 'deploymentRestore' | 'deploymentBackupAction' | 'projectReadinessRead'
  | 'deploymentTemplateInstantiate' | 'deploymentMoveToRepository' | 'prepareDeploymentTemplateInstantiation' | 'resolveEnvironmentApprovalScope'
  | 'prepareDeploymentAction' | 'prepareDeploymentTeardown' | 'prepareHostReviewedChildren'
  | 'readSetupAppArtifact' | 'readPendingDeploymentRecovery'>
  & Required<Pick<ActionExecutorDeps, 'prepareDeploymentEnvironmentCreate'>>;

/**
 * Bind content custody when the effect runs: detached approval replay restores its root after executor construction.
 * The deployment owner loads on the first deployment effect; most daemons never run one (P03-CODE-COVERAGE).
 */
export function createRequesterBoundDeploymentActionDeps(
  host: Parameters<typeof createDaemonDeploymentActionDeps>[0],
): DaemonDeploymentDeps {
  const forContext = async (context: ActionExecutorContext) => {
    const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
    const { createDaemonDeploymentActionDeps } = await import('@/deployments/createDaemonDeploymentActionDeps');
    return createDaemonDeploymentActionDeps(requester ? {
      ...host, credentials: requester.credentials,
      savedSecretOperationContext: requester.savedSecretOperationContext,
      serverHttpBaseUrl: requester.serverHttpBaseUrl,
    } : context.externalActionExecutionAuthorization
      // A signed root must not borrow the deciding invocation's private Settings snapshot.
      ? { ...host, savedSecretOperationContext: undefined } : host);
  };
  return {
    deploymentAction: async (...args) => (await forContext(args[2])).deploymentAction(...args),
    deploymentTelemetrySet: async (...args) => (await forContext(args[1])).deploymentTelemetrySet(...args),
    // Restore carries its retained prepare step; both bind custody from their own invocation context.
    deploymentRestore: Object.assign(
      async (...args: Parameters<DaemonDeploymentDeps['deploymentRestore']>) => (await forContext(args[1])).deploymentRestore(...args),
      { prepare: async (request: Parameters<DaemonDeploymentDeps['deploymentRestore']['prepare']>[0]) =>
        (await forContext(request.context)).deploymentRestore.prepare(request) }),
    deploymentBackupAction: async (...args) => (await forContext(args[2])).deploymentBackupAction(...args),
    projectReadinessRead: async (...args) => (await forContext(args[1])).projectReadinessRead(...args),
    prepareDeploymentEnvironmentCreate: async request => (await forContext(request.context)).prepareDeploymentEnvironmentCreate(request),
    deploymentTemplateInstantiate: async (...args) => (await forContext(args[1])).deploymentTemplateInstantiate(...args),
    deploymentMoveToRepository: async (...args) => (await forContext(args[1])).deploymentMoveToRepository(...args),
    prepareDeploymentTemplateInstantiation: async request => (await forContext(request.context)).prepareDeploymentTemplateInstantiation(request),
    resolveEnvironmentApprovalScope: async request => (await forContext(request.context)).resolveEnvironmentApprovalScope!(request),
    prepareDeploymentAction: async request => (await forContext(request.context)).prepareDeploymentAction(request),
    prepareDeploymentTeardown: async request => (await forContext(request.context)).prepareDeploymentTeardown(request),
    prepareHostReviewedChildren: async request => (await forContext(request.context)).prepareHostReviewedChildren(request),
    readSetupAppArtifact: async (input, context) => (await forContext(context)).readSetupAppArtifact(input, context),
    readPendingDeploymentRecovery: async (input, context) => (await forContext(context)).readPendingDeploymentRecovery(input, context),
  };
}
