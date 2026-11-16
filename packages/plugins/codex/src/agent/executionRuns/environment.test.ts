import { describe, expect, it } from 'vitest';

import { buildCodexExecutionRunBaseEnv } from './environment.js';

describe('buildCodexExecutionRunBaseEnv', () => {
  it('retains each invocation\'s native AppServer controls without a launch overlay', () => {
    for (const id of ['first', 'second']) {
      const scoped = {
        HOME: `/homes/${id}`,
        CODEX_HOME: `/homes/${id}/codex`,
        HAPPIER_CODEX_APP_SERVER_RESUME_RECOVERY_TIMEOUT_MS: id === 'first' ? '123000' : '124000',
        HAPPIER_CODEX_APP_SERVER_MAX_JSON_LINE_CHARS: id === 'first' ? '1000000' : '2000000',
      };
      expect(buildCodexExecutionRunBaseEnv({ exec: {
        readEnvironment: keys => Object.fromEntries(Object.entries(scoped).filter(([key]) => keys.includes(key))),
      } })).toEqual(scoped);
    }
  });

  it('inherits the parent process environment when execution-run isolation is absent', () => {
    const processEnv = {
      PATH: 'C:\\Users\\alice\\AppData\\Roaming\\npm;C:\\Windows\\System32',
      PATHEXT: '.COM;.EXE;.CMD',
      HAPPIER_CODEX_PARENT_SENTINEL: 'inherited',
    };

    expect(buildCodexExecutionRunBaseEnv({ processEnv })).toEqual(processEnv);
  });

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
