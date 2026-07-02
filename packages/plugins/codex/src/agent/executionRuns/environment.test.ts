import { describe, expect, it } from 'vitest';

import { buildCodexExecutionRunBaseEnv } from './environment.js';

describe('buildCodexExecutionRunBaseEnv', () => {
  it('inherits only Codex execution-run process override keys before isolated env values', () => {
    expect(buildCodexExecutionRunBaseEnv({
      processEnv: {
        HAPPIER_CODEX_APP_SERVER_BIN: '/tmp/app-server',
        HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1234',
        CODEX_THREAD_ID: 'poisoned-thread',
      },
      isolationEnv: {
        PATH: '/tmp/isolated-bin:/usr/bin',
        HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'acp',
      },
    })).toEqual({
      HAPPIER_CODEX_APP_SERVER_BIN: '/tmp/app-server',
      HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '1234',
      HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'acp',
      PATH: '/tmp/isolated-bin:/usr/bin',
    });
  });

  it('returns the isolated env unchanged when no Codex process overrides are set', () => {
    const isolationEnv = {
      PATH: '/tmp/isolated-bin:/usr/bin',
      XDG_STATE_HOME: '/tmp/state',
    };

    expect(buildCodexExecutionRunBaseEnv({
      processEnv: {
        CODEX_THREAD_ID: 'poisoned-thread',
      },
      isolationEnv,
    })).toBe(isolationEnv);
  });
});
