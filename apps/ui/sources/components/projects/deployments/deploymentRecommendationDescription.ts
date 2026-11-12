import type { DeploymentTargetRecommendationV1 } from '@happier-dev/protocol/deployments/deploymentTargetRecommendationV1';
import { t } from '@/text';

export function deploymentRecommendationDescription(recommendation: DeploymentTargetRecommendationV1): string {
  if (recommendation.evidence.includes('existing_target')) return t('projects.deployments.recommendation.existing');
  if (recommendation.evidence.includes('stored_definition')) return t(recommendation.target?.targetClass === 'ownServer'
    ? 'projects.deployments.recommendation.stored' : 'projects.deployments.recommendation.chooseMachine');
  return t('projects.deployments.recommendation.unknown');
}
