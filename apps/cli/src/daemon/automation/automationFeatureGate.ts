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
