import type { DeploymentTargetRecommendationV1 } from '@happier-dev/protocol/deployments/deploymentTargetRecommendationV1';
import { t } from '@/text';

/** Why the recommended target fits, when the recommendation knows; null when it has no reason to give. */
export function deploymentRecommendationReason(recommendation: DeploymentTargetRecommendationV1): string | null {
  if (recommendation.evidence.includes('existing_target')) return t('projects.deployments.recommendation.existing');
  if (recommendation.evidence.includes('stored_definition')) return t(recommendation.target?.targetClass === 'ownServer'
    ? 'projects.deployments.recommendation.stored' : 'projects.deployments.recommendation.chooseMachine');
  return null;
}

export function deploymentRecommendationDescription(recommendation: DeploymentTargetRecommendationV1): string {
  return deploymentRecommendationReason(recommendation) ?? t('projects.deployments.recommendation.unknown');
}
