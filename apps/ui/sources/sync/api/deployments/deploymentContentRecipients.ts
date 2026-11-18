import type {
  ActionExecutorContext,
  ActionExecutorDeps,
} from '@happier-dev/protocol/actions/executor/types';
import { prepareProjectSourceDeploymentRecipientsV1, type DeploymentContentRecipientPortsV1 } from '@happier-dev/deployment-protocol/v1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readUiProjectDeploymentDefaults } from '@/sync/api/projects/projectDeploymentDefaultsRead';

/** The app is a keyholder only for its own signed-in Account; delegated or signed calls deliver nothing here. */
export function createUiDeploymentContentRecipientPorts(
  account: LazyActionAccountContext,
  deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']>,
) {
  return (
    context: ActionExecutorContext,
  ): DeploymentContentRecipientPortsV1 | null => {
    if (
      account.credentialAuthorityKind === 'api_token' ||
      context.externalActionCredential ||
      context.externalActionExecutionAuthorization
    )
      return null;
    return {
      deploymentAction,
      readDefaults: (sourceId, readContext) =>
        readUiProjectDeploymentDefaults(account, sourceId, readContext),
      // A keyholding open runs the canonical census + key-envelope preparation for each Artifact.
      async prepareArtifactRecipients(artifactIds, prepareContext) {
        const opened = await account.readArtifactContents(artifactIds, {
          signal: prepareContext.signal,
        });
        const refused = opened.find(
          (result) => result.status === 'rejected' || result.value === null,
        );
        if (refused)
          throw refused.status === 'rejected'
            ? refused.reason
            : new Error('artifact_not_found');
      },
    };
  };
}

/** Source owner/audience edits made in the app deliver the Source's deployment content to the committed audience. */
export function createUiProjectSourceRecipientDelivery(account: LazyActionAccountContext,
    deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']>) {
    const portsFor = createUiDeploymentContentRecipientPorts(account, deploymentAction);
    return async (input: Readonly<{ serverId: string; projectSourceId: string }>, context?: ActionExecutorContext) => {
        const ports = context ? portsFor(context) : null;
        return ports && context ? prepareProjectSourceDeploymentRecipientsV1(ports, input, context) : null;
    };
}
