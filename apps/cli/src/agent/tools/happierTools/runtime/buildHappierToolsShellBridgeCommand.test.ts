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
  const originalContextEnv = process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV;
  const originalActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalLocalServerUrl = process.env.HAPPIER_LOCAL_SERVER_URL;
  const originalPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalAccessToken = process.env.HAPPIER_ACCESS_TOKEN;

  afterEach(() => {
    if (typeof originalContextEnv === 'string') {
      process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV = originalContextEnv;
    } else {
      delete process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV;
    }

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

    if (typeof originalActiveServerId === 'string') {
      process.env.HAPPIER_ACTIVE_SERVER_ID = originalActiveServerId;
    } else {
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    }

    if (typeof originalLocalServerUrl === 'string') {
      process.env.HAPPIER_LOCAL_SERVER_URL = originalLocalServerUrl;
    } else {
      delete process.env.HAPPIER_LOCAL_SERVER_URL;
    }

    if (typeof originalPublicServerUrl === 'string') {
      process.env.HAPPIER_PUBLIC_SERVER_URL = originalPublicServerUrl;
    } else {
      delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    }

    if (typeof originalWebappUrl === 'string') {
      process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
    } else {
      delete process.env.HAPPIER_WEBAPP_URL;
    }

    if (typeof originalAccessToken === 'string') {
      process.env.HAPPIER_ACCESS_TOKEN = originalAccessToken;
    } else {
      delete process.env.HAPPIER_ACCESS_TOKEN;
    }

    vi.resetModules();
  });

  it('does not inline Happier runtime context by default', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-stack-home';
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'preview';
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3010';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://127.0.0.1:4010';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://preview.happier.example';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.happier.example';
    process.env.HAPPIER_ACCESS_TOKEN = 'secret-token-that-must-not-be-embedded';

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

    expect(command).not.toContain('HAPPIER_HOME_DIR=');
    expect(command).not.toContain('HAPPIER_SERVER_URL=');
    // Binary-safe invocation of the tools CLI.
    expect(command).toContain(`'tools' 'call' '--source' 'happier' '--tool' 'change_title'`);
    // Never embed credentials.
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });

  it('inlines only Happier home when explicitly configured for home context', async () => {
    process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV = 'home';
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-stack-home';
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'preview';
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3010';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://127.0.0.1:4010';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://preview.happier.example';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.happier.example';
    process.env.HAPPIER_ACCESS_TOKEN = 'secret-token-that-must-not-be-embedded';

    const { buildHappierToolsShellBridgeCommand } = await import('./buildHappierToolsShellBridgeCommand');
    const command = buildHappierToolsShellBridgeCommand(['call']);

    expect(command).toContain(`HAPPIER_HOME_DIR='/tmp/happier-stack-home'`);
    expect(command).not.toContain('HAPPIER_ACTIVE_SERVER_ID=');
    expect(command).not.toContain('HAPPIER_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_LOCAL_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_PUBLIC_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_WEBAPP_URL=');
    // Binary-safe invocation of the tools CLI.
    expect(command).toContain(`'tools' 'call' '--source' 'happier' '--tool' 'change_title'`);
    // Never embed credentials.
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });

  it('inlines full Happier runtime context when explicitly configured for full context', async () => {
    process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV = 'full';
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-stack-home';
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'preview';
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3010';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://127.0.0.1:4010';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://preview.happier.example';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.happier.example';
    process.env.HAPPIER_ACCESS_TOKEN = 'secret-token-that-must-not-be-embedded';

    const { buildHappierToolsShellBridgeCommand } = await import('./buildHappierToolsShellBridgeCommand');
    const command = buildHappierToolsShellBridgeCommand(['call']);

    expect(command).toContain(`HAPPIER_HOME_DIR='/tmp/happier-stack-home'`);
    expect(command).toContain(`HAPPIER_ACTIVE_SERVER_ID='preview'`);
    expect(command).toContain(`HAPPIER_SERVER_URL='http://127.0.0.1:4010'`);
    expect(command).toContain(`HAPPIER_PUBLIC_SERVER_URL='https://preview.happier.example'`);
    expect(command).toContain(`HAPPIER_WEBAPP_URL='https://app.happier.example'`);
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });
});
