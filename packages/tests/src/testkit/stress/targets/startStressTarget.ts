import type { StartedStressTarget, StartStressTargetParams } from './stressTargetTypes';
import { attachExternalStressTarget } from './attachExternalStressTarget';
import { attachRunningFullComposeStressTarget } from './attachRunningFullComposeStressTarget';
import { startFullComposeStressTarget } from './startFullComposeStressTarget';
import { startServerLightStressTarget } from './startServerLightStressTarget';

type StressTargetStarters = Readonly<{
  startServerLightStressTarget: (params: StartStressTargetParams) => Promise<StartedStressTarget>;
  startFullComposeStressTarget: (params: StartStressTargetParams) => Promise<StartedStressTarget>;
  attachRunningFullComposeStressTarget: (params: StartStressTargetParams) => Promise<StartedStressTarget>;
  attachExternalStressTarget: (params: StartStressTargetParams) => Promise<StartedStressTarget>;
}>;

const defaultStarters: StressTargetStarters = {
  startServerLightStressTarget,
  startFullComposeStressTarget,
  attachRunningFullComposeStressTarget,
  attachExternalStressTarget,
};

export async function startStressTarget(
  params: StartStressTargetParams,
  starters: StressTargetStarters = defaultStarters,
): Promise<StartedStressTarget> {
  if (params.config.targetMode === 'full-compose') {
    if (params.config.compose.reuseRunningTopology) {
      return await starters.attachRunningFullComposeStressTarget(params);
    }
    return await starters.startFullComposeStressTarget(params);
  }
  if (params.config.targetMode === 'external') {
    return await starters.attachExternalStressTarget(params);
  }
  return await starters.startServerLightStressTarget(params);
}
