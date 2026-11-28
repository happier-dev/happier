import * as React from 'react';
import { isRecord } from '@happier-dev/protocol/common/records';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';
import { type DeploymentFailureRecoveryDestinationV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { readDeploymentRefusalRecovery } from './deploymentPresentation';

import type { PlatformInspectOutcome } from './platformTargetLink';

/** The sheet presents the plugin's settled inspection; it never decides prerequisites. */
export function DeploymentPlatformInspectState({ outcome, refusal, onOpenRecovery }: Readonly<{
  outcome: PlatformInspectOutcome | null;
  /** Create can need Git access before any provider resource exists. */
  refusal?: Readonly<{ code: string; details?: unknown }>;
  /** Opens a refusal's next step through the page's one recovery router. */
  onOpenRecovery?: (destination: DeploymentFailureRecoveryDestinationV1) => void;
}>) {
  if (outcome?.kind === 'ready') return (
    <SurfaceStateCard testID="project-deployments.platform.ready" size="line" kind="success"
      title={t('projects.deployments.platformLink.ready')} />
  );
  const gitRefusal = refusal?.code === 'needsGitAccess' ? refusal : null;
  const grantUrl = outcome?.kind === 'needsGitAccess' ? outcome.grantUrl
    : isRecord(gitRefusal?.details) && typeof gitRefusal.details.grantUrl === 'string' ? gitRefusal.details.grantUrl : null;
  if (outcome?.kind === 'needsGitAccess' || gitRefusal) return (
    <SurfaceStateCard testID="project-deployments.platform.needsGitAccess" size="line" kind="warning"
      title={t('projects.deployments.platformLink.needsGit')}
      reason={t('projects.deployments.platformLink.needsGitBody')}
      {...(gitRefusal ? { diagnosticCode: gitRefusal.code } : {})}
      {...(grantUrl ? { action: {
        label: t('projects.deployments.platformLink.grant'),
        onPress: () => { void openExternalUrl(grantUrl); },
      } } : {})} />
  );
  // A refusal the shared recovery owner knows says its remedy and offers its next step.
  const recovery = outcome?.kind === 'refused' ? readDeploymentRefusalRecovery(outcome.code,
    outcome.failure?.details, outcome.request, outcome.failure?.failureCause?.errorCode, { failureCause: outcome.failure?.failureCause }) : null;
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
