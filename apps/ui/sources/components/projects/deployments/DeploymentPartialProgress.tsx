import * as React from 'react';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { presentActionFailureOutcome, type ApprovalFailureDiagnostics } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { t } from '@/text';
import type { DeploymentPartialResult } from './deploymentActionOutcome';
import { deploymentStateLabel } from './deploymentPresentation';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

/** A producer's acknowledged effects beside the one failed step; no step is inferred or retried. */
export function DeploymentPartialProgress(props: Readonly<{
  progress: DeploymentPartialResult;
  failure: ApprovalFailureDiagnostics;
  testID: string;
}>) {
  const { progress, testID } = props;
  const outcome = presentActionFailureOutcome(props.failure, 'deployment');
  const stepLabel = {
    generation: t('projects.deployments.variablesTitle'),
    repository: t('projects.deployments.settingsSections.moveToRepository.review'),
    environment: t('projects.deployments.newEnvironment'),
    target: t('projects.deployments.whereTitle'),
    bindings: t('projects.deployments.variablesTitle'),
    metadata: t('projects.deployments.tabSettings'),
    domains: t('projects.deployments.tabDomains'),
    deploy: t('projects.deployments.deploy'),
  } satisfies Record<DeploymentPartialResult['phase'], string>;
  return <>
    <ItemGroup testID={testID} description={t('projects.deployments.partialProgressBody')}>
      {progress.environmentId ? <Item title={t('projects.deployments.review.environment')}
        subtitle={progress.environmentId} showChevron={false} /> : null}
      {progress.deployment && 'deploymentId' in progress.deployment ? <Item
        title={deploymentStateLabel(progress.deployment.state)} subtitle={progress.deployment.deploymentId} showChevron={false} /> : null}
      {progress.repositoryChange && 'worktree' in progress.repositoryChange && progress.repositoryChange.worktree ? <Item title={progress.repositoryChange.worktree.branchName}
        subtitle={progress.repositoryChange.worktree.path} mode="info" /> : null}
      {progress.repositoryChange?.headCommit ? <Item title={progress.repositoryChange.headCommit} mode="info" /> : null}
      {progress.repositoryChange?.pullRequest ? <Item title={progress.repositoryChange.pullRequest.url}
        onPress={() => { void requestOpenExternalUrl(progress.repositoryChange!.pullRequest!.url); }} /> : null}
      {progress.savedSecrets.map(secret => <Item key={`${secret.phase}:${secret.name}`}
        title={secret.name} subtitle={t('projects.deployments.variablesTitle')} showChevron={false} />)}
    </ItemGroup>
    <ItemGroup title={stepLabel[progress.phase]}>
      <AttentionBanner testID={`${testID}.failed`} placement="inline" tone="danger"
        title={t(progress.phase === 'domains' ? 'projects.deployments.domainChangeFailedTitle'
          : progress.phase === 'deploy' ? 'projects.deployments.deployFailedTitle' : 'projects.deployments.settingChangeFailedTitle')}
        description={outcome.reason ?? undefined}
        details={outcome.technicalDetails.map(line => `${line.label}: ${line.value}`)} />
    </ItemGroup>
  </>;
}
