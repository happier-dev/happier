import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { readDeploymentRefusalRecoveryV1, type DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

import type { PlatformInspectOutcome } from './platformTargetLink';

/** The sheet presents the plugin's settled inspection; it never decides prerequisites. */
export function DeploymentPlatformInspectState({ outcome, onOpenRecovery }: Readonly<{
  outcome: PlatformInspectOutcome | null;
  /** Opens a refusal's next step through the page's one recovery router. */
  onOpenRecovery?: (destination: DeploymentFailureRecoveryDestinationV1) => void;
}>) {
  if (outcome?.kind === 'ready') return (
    <SurfaceStateCard testID="project-deployments.platform.ready" size="line" kind="success"
      title={t('projects.deployments.platformLink.ready')} />
  );
  if (outcome?.kind === 'needsGitAccess') return (
    <SurfaceStateCard testID="project-deployments.platform.needsGitAccess" size="line" kind="warning"
      title={t('projects.deployments.platformLink.needsGit')}
      reason={t('projects.deployments.platformLink.needsGitBody')}
      {...(outcome.grantUrl ? { action: {
        label: t('projects.deployments.platformLink.grant'),
        onPress: () => { void openExternalUrl(outcome.grantUrl!); },
      } } : {})} />
  );
  // A refusal the shared recovery owner knows says its remedy and offers its next step.
  const recovery = outcome?.kind === 'refused' ? readDeploymentRefusalRecoveryV1(outcome.code) : null;
  if (outcome?.kind === 'refused' && recovery) return (
    <SurfaceStateCard testID="project-deployments.platform.refused" size="line"
      kind={outcome.reason === 'repository' ? 'warning' : 'error'}
      title={outcome.reason === 'repository'
        ? t('projects.deployments.platformLink.repositoryRequired')
        : t('projects.deployments.platformLink.refused')}
      reason={recovery.remedy}
      diagnosticCode={outcome.code}
      {...(onOpenRecovery ? { action: { label: recovery.nextAction.label, testID: 'project-deployments.platform.refused.next',
        onPress: () => onOpenRecovery(recovery.nextAction.destination) } } : {})} />
  );
  if (outcome?.kind === 'refused') return (
    <SurfaceStateCard testID="project-deployments.platform.refused" size="line"
      kind={outcome.reason === 'repository' ? 'warning' : 'error'}
      title={outcome.reason === 'repository'
        ? t('projects.deployments.platformLink.repositoryRequired')
        : t('projects.deployments.platformLink.refused')}
      reason={outcome.reason === 'repository'
        ? t('projects.deployments.platformLink.repositoryRequiredBody')
        : outcome.reason === 'permission'
          ? t('projects.deployments.platformLink.managersOnly')
          : t('projects.deployments.platformLink.refusedRemedy')}
      diagnosticCode={outcome.code} />
  );
  return null;
}
