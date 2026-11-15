import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';

type DeploymentDeps = ReturnType<typeof createDaemonDeploymentActionDeps>;
type DaemonDeploymentDeps = Pick<DeploymentDeps,
  | 'deploymentAction' | 'deploymentRestore' | 'deploymentBackupAction' | 'projectReadinessRead'
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
