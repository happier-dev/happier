import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessLaunchSpec: () => ({
    runtime: 'node',
    filePath: process.execPath,
    args: [
      '--no-warnings',
      '--no-deprecation',
      '/tmp/happier/index.mjs',
      'tools',
      'call',
      '--source',
      'happier',
      '--tool',
      'change_title',
      '--args-json',
      '{"title":"Renamed"}',
      '--json',
    ],
  }),
}));

describe('buildHappierToolsShellBridgeCommand', () => {
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;

  afterEach(() => {
    if (typeof originalHomeDir === 'string') {
      process.env.HAPPIER_HOME_DIR = originalHomeDir;
    } else {
      delete process.env.HAPPIER_HOME_DIR;
    }

    if (typeof originalServerUrl === 'string') {
      process.env.HAPPIER_SERVER_URL = originalServerUrl;
    } else {
      delete process.env.HAPPIER_SERVER_URL;
    }
  });

  it('preserves current stack env assignments in the shell bridge command', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-stack-home';
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3010';

    const { buildHappierToolsShellBridgeCommand } = await import('./buildHappierToolsShellBridgeCommand');
    const command = buildHappierToolsShellBridgeCommand([
      'call',
      '--source',
      'happier',
      '--tool',
      'change_title',
      '--args-json',
      '{"title":"Renamed"}',
      '--json',
    ]);

    expect(command).toContain(`HAPPIER_HOME_DIR='/tmp/happier-stack-home'`);
    expect(command).toContain(`HAPPIER_SERVER_URL='http://127.0.0.1:3010'`);
    expect(command).toContain(`'tools' 'call' '--source' 'happier' '--tool' 'change_title'`);
  });
});
