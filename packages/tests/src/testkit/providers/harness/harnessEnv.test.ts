import { describe, expect, it } from 'vitest';

import { applyCliDevTsxTsconfigEnv, applyHomeIsolationEnv } from './harnessEnv';

describe('applyHomeIsolationEnv', () => {
  it('forces daemon autostart off for provider harness runs', () => {
    const env = applyHomeIsolationEnv({ cliHome: '/tmp/cli-home', env: {} });
    expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('0');
  });
});

describe('applyCliDevTsxTsconfigEnv', () => {
  it('sets TSX_TSCONFIG_PATH for workspace-driven dev CLI runs', () => {
    const env = applyCliDevTsxTsconfigEnv({ repoRootDir: '/repo', env: {} });
    expect(env.TSX_TSCONFIG_PATH).toBe('/repo/apps/cli/tsconfig.json');
  });

  it('does not override an explicit TSX_TSCONFIG_PATH', () => {
    const env = applyCliDevTsxTsconfigEnv({ repoRootDir: '/repo', env: { TSX_TSCONFIG_PATH: '/custom/tsconfig.json' } });
    expect(env.TSX_TSCONFIG_PATH).toBe('/custom/tsconfig.json');
  });
});
