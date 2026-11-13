import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import {
  HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY,
  clearInitialGoalFromEnv,
  readInitialGoalFromEnv,
  serializeInitialGoalForEnv,
} from './initialGoal';

afterEach(() => vi.unstubAllEnvs());

describe('initial goal handoff environment', () => {
  it('reads and clears each interleaved hosted Session goal without consuming the host goal', async () => {
    const hostGoal = serializeInitialGoalForEnv({ objective: 'Host goal' });
    vi.stubEnv(HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY, hostGoal);
    const goals = ['a', 'b'].map(id => ({ objective: `Session ${id} goal` }));
    const environments = goals.map(goal => ({
      [HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]: serializeInitialGoalForEnv(goal),
    }));
    const results = await Promise.all(environments.map(environment => runAddedHostedSession({
      environment, workingDirectory: '/repo', end: () => undefined,
    }, async () => {
      await Promise.resolve();
      const goal = readInitialGoalFromEnv();
      await Promise.resolve();
      clearInitialGoalFromEnv();
      return goal;
    })));

    expect(results).toEqual(goals);
    for (const environment of environments) {
      expect(environment[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]).toBeUndefined();
    }
    expect(process.env[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]).toBe(hostGoal);
  });

  it('preserves explicit environment overrides and process defaults outside a hosted Session', () => {
    const hostGoal = { objective: 'Host goal' };
    vi.stubEnv(HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY, serializeInitialGoalForEnv(hostGoal));
    const environment = {
      [HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]: serializeInitialGoalForEnv({ objective: 'Session goal' }),
    };
    const explicitGoal = { objective: 'Explicit goal' };
    const explicitEnvironment = {
      [HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]: serializeInitialGoalForEnv(explicitGoal),
    };
    runAddedHostedSession({ environment, workingDirectory: '/repo', end: () => undefined }, () => {
      expect(readInitialGoalFromEnv(explicitEnvironment)).toEqual(explicitGoal);
      clearInitialGoalFromEnv(explicitEnvironment);
      expect(explicitEnvironment[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]).toBeUndefined();
      expect(environment[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]).toBeDefined();
    });
    expect(readInitialGoalFromEnv()).toEqual(hostGoal);
    clearInitialGoalFromEnv();
    expect(process.env[HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]).toBeUndefined();
  });
});
