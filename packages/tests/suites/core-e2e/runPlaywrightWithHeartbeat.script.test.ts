import { describe, expect, it } from 'vitest';

import {
  createPlaywrightSpawnOptions,
  parseHeartbeatArgs,
  resolveSignalExitCode,
} from '../../scripts/runPlaywrightWithHeartbeat.shared.mjs';

describe('runPlaywrightWithHeartbeat helpers', () => {
  it('supports both config flag forms while preserving passthrough args', () => {
    expect(parseHeartbeatArgs(['node', 'script', '--config', 'playwright.ui.config.mjs', '--grep', 'tmux'])).toEqual({
      config: 'playwright.ui.config.mjs',
      passThrough: ['--grep', 'tmux'],
    });
    expect(parseHeartbeatArgs(['node', 'script', '--config=playwright.ui.config.mjs', '--reporter=line'])).toEqual({
      config: 'playwright.ui.config.mjs',
      passThrough: ['--reporter=line'],
    });
  });

  it('uses detached child processes for playwright runs on non-Windows platforms', () => {
    expect(createPlaywrightSpawnOptions({ TEST_FLAG: '1' })).toMatchObject({
      detached: process.platform !== 'win32',
      stdio: 'inherit',
      env: { TEST_FLAG: '1' },
    });
  });

  it('maps signals to conventional exit codes', () => {
    expect(resolveSignalExitCode('SIGINT')).toBe(130);
    expect(resolveSignalExitCode('SIGTERM')).toBe(143);
    expect(resolveSignalExitCode(null)).toBe(1);
  });
});
