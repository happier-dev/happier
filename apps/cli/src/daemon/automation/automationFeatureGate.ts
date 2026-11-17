import { resolveCliGlobalOnlyFeatureDecision } from '@/features/featureDecisionGlobalOnly';

export function getAutomationWorkerFeatureDecision(env: NodeJS.ProcessEnv) {
  return resolveCliGlobalOnlyFeatureDecision({
    featureId: 'workflows',
    env,
  });
}
