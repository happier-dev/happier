import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';

type DeploymentDeps = ReturnType<typeof createDaemonDeploymentActionDeps>;
type DaemonDeploymentDeps = Pick<DeploymentDeps,
  | 'deploymentAction' | 'deploymentRestore' | 'deploymentBackupAction' | 'projectReadinessRead' | 'prepareDeploymentEnvironmentCreate'
  | 'deploymentTemplateInstantiate' | 'prepareDeploymentTemplateInstantiation' | 'resolveEnvironmentApprovalScope'
  | 'prepareDeploymentAction' | 'prepareDeploymentTeardown' | 'prepareHostReviewedChildren'
  | 'readSetupAppArtifact' | 'readPendingDeploymentRecovery'>;

/** Bind content custody when the effect runs: detached approval replay restores its root after executor construction. */
export function createRequesterBoundDeploymentActionDeps(
  host: Parameters<typeof createDaemonDeploymentActionDeps>[0],
): DaemonDeploymentDeps {
  const forContext = (context: ActionExecutorContext) => {
    const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
    return createDaemonDeploymentActionDeps(requester ? {
      ...host, credentials: requester.credentials,
      savedSecretOperationContext: requester.savedSecretOperationContext,
      serverHttpBaseUrl: requester.serverHttpBaseUrl,
    } : context.externalActionExecutionAuthorization
      // A signed root must not borrow the deciding invocation's private Settings snapshot.
      ? { ...host, savedSecretOperationContext: undefined } : host);
  };
  return {
    deploymentAction: (...args) => forContext(args[2]).deploymentAction(...args),
    deploymentRestore: (...args) => forContext(args[1]).deploymentRestore(...args),
    deploymentBackupAction: (...args) => forContext(args[2]).deploymentBackupAction(...args),
    projectReadinessRead: (...args) => forContext(args[1]).projectReadinessRead(...args),
    prepareDeploymentEnvironmentCreate: request => forContext(request.context).prepareDeploymentEnvironmentCreate(request),
    deploymentTemplateInstantiate: (...args) => forContext(args[1]).deploymentTemplateInstantiate(...args),
    prepareDeploymentTemplateInstantiation: request => forContext(request.context).prepareDeploymentTemplateInstantiation(request),
    resolveEnvironmentApprovalScope: request => forContext(request.context).resolveEnvironmentApprovalScope!(request),
    prepareDeploymentAction: request => forContext(request.context).prepareDeploymentAction(request),
    prepareDeploymentTeardown: request => forContext(request.context).prepareDeploymentTeardown(request),
    prepareHostReviewedChildren: request => forContext(request.context).prepareHostReviewedChildren(request),
    readSetupAppArtifact: (input, context) => forContext(context).readSetupAppArtifact(input, context),
    readPendingDeploymentRecovery: (input, context) => forContext(context).readPendingDeploymentRecovery(input, context),
  };
}
