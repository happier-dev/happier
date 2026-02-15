import { resolveCliFeatureDecision } from '@/features/featureDecisionService';

export function getAutomationWorkerFeatureDecision(env: NodeJS.ProcessEnv) {
  return resolveCliFeatureDecision({
    featureId: 'automations',
    env,
  });
}

export function isAutomationWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  return getAutomationWorkerFeatureDecision(env).state === 'enabled';
}

export function isExistingSessionAutomationTargetEnabled(env: NodeJS.ProcessEnv): boolean {
  return resolveCliFeatureDecision({
    featureId: 'automations.existingSessionTarget',
    env,
  }).state === 'enabled';
}
