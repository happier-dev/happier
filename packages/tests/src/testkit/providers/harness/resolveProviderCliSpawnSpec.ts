import type { ProviderScenario } from '../types';
import { wrapCommandForPseudoTty } from '../../process/wrapCommandForPseudoTty';

export function resolveProviderCliSpawnSpec(params: {
  platform: NodeJS.Platform;
  scriptPath: string | null;
  baseCommand: string;
  baseArgs: string[];
  scenario: ProviderScenario;
}): { command: string; args: string[] } {
  return wrapCommandForPseudoTty({
    platform: params.platform,
    scriptPath: params.scriptPath,
    command: params.baseCommand,
    args: [...params.baseArgs],
    needsTty: params.scenario.cliRequiresTty === true,
  });
}

