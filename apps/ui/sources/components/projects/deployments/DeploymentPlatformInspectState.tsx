import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import type { PlatformInspectOutcome } from './platformTargetLink';

/** The sheet presents the plugin's settled inspection; it never decides prerequisites. */
export function DeploymentPlatformInspectState({ outcome }: Readonly<{ outcome: PlatformInspectOutcome | null }>) {
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
