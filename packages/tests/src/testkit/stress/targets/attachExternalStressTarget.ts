import type { StartedStressTarget, StartStressTargetParams } from './stressTargetTypes';

export async function attachExternalStressTarget(params: StartStressTargetParams): Promise<StartedStressTarget> {
  if (!params.config.baseUrl) {
    throw new Error('External stress target requires a baseUrl');
  }

  return {
    mode: 'external',
    baseUrl: params.config.baseUrl,
    topology: {
      kind: 'external',
      services: ['external'],
      expectedApiReplicas: params.config.orchestration.expectedApiReplicas,
      expectedWorkerReplicas: params.config.orchestration.expectedWorkerReplicas,
      resolvedApiReplicas: params.config.orchestration.expectedApiReplicas,
      resolvedWorkerReplicas: params.config.orchestration.expectedWorkerReplicas,
      baseUrl: params.config.baseUrl,
      ports: {},
    },
    preserveForInspection: () => {},
    stop: async () => {},
    collectDiagnostics: async () => {},
  };
}
