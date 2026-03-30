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
      env: expect.objectContaining({
        TEST_FLAG: '1',
      }),
    });
  });

  it('assigns a per-run UI web export namespace when one is not provided', () => {
    const options = createPlaywrightSpawnOptions({ TEST_FLAG: '1' });
    expect(options.env).toEqual(expect.objectContaining({
      TEST_FLAG: '1',
    }));
    expect(typeof options.env.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE).toBe('string');
    expect(options.env.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE).toMatch(/^playwright-ui-/);
  });

  it('preserves an explicit UI web export namespace', () => {
    const options = createPlaywrightSpawnOptions({
      TEST_FLAG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: 'uiweb-explicit',
    });
    expect(options.env.HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE).toBe('uiweb-explicit');
  });

  it('maps signals to conventional exit codes', () => {
    expect(resolveSignalExitCode('SIGINT')).toBe(130);
    expect(resolveSignalExitCode('SIGTERM')).toBe(143);
    expect(resolveSignalExitCode(null)).toBe(1);
  });
});
