import { describe, expect, it } from 'vitest';

import {
  consumeDaemonInitialPromptFromEnv,
  HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY,
  normalizeDaemonInitialPrompt,
} from './daemonInitialPrompt';

describe('daemonInitialPrompt', () => {
  it('normalizes non-empty prompt strings', () => {
    expect(normalizeDaemonInitialPrompt('  hello world  ')).toBe('hello world');
  });

  it('returns null for blank prompt strings', () => {
    expect(normalizeDaemonInitialPrompt('   ')).toBeNull();
  });

  it('consumes prompt from env and removes env key', () => {
    const env: NodeJS.ProcessEnv = {
      [HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY]: '  run automation  ',
    };

    expect(consumeDaemonInitialPromptFromEnv(env)).toBe('run automation');
    expect(env[HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY]).toBeUndefined();
  });
});

