import type { Scenario } from './types';

type ScenarioDriverOptions = {
    autoplay?: boolean;
    speed?: number;
};

export function useScenarioDriver(
    _scenario: Scenario,
    _options: ScenarioDriverOptions = {},
): void {}
