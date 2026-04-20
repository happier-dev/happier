import { startServerLight } from '../../process/serverLight';
import type { StartedStressTarget, StartStressTargetParams } from './stressTargetTypes';

export async function startServerLightStressTarget(params: StartStressTargetParams): Promise<StartedStressTarget> {
  const server = await startServerLight({ testDir: params.testDir });
  return {
    mode: 'light',
    baseUrl: server.baseUrl,
    topology: {
      kind: 'light',
      services: ['server-light'],
      expectedApiReplicas: 1,
      expectedWorkerReplicas: 0,
      resolvedApiReplicas: 1,
      resolvedWorkerReplicas: 0,
      baseUrl: server.baseUrl,
      ports: {
        server: server.port,
      },
    },
    preserveForInspection: () => {},
    stop: async () => {
      await server.stop();
    },
    collectDiagnostics: async () => {},
  };
}
