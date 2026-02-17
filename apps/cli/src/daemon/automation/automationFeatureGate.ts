import { resolveCliGlobalOnlyFeatureDecision } from '@/features/featureDecisionGlobalOnly';

export function getAutomationWorkerFeatureDecision(env: NodeJS.ProcessEnv) {
  return resolveCliGlobalOnlyFeatureDecision({
    featureId: 'automations',
    env,
  });
}

export function isAutomationWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  return getAutomationWorkerFeatureDecision(env).state === 'enabled';
}

export function isExistingSessionAutomationTargetEnabled(env: NodeJS.ProcessEnv): boolean {
  return resolveCliGlobalOnlyFeatureDecision({
    featureId: 'automations.existingSessionTarget',
    env,
  }).state === 'enabled';
}
