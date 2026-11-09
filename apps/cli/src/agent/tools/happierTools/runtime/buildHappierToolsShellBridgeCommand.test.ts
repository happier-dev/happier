import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

// The launcher is the genuine process boundary here; the argument composition
// under test is the CLI's own, so the spec echoes exactly what it was handed.
vi.mock('@/utils/spawnHappyCLI', () => ({
  buildHappyCliSubprocessLaunchSpec: (args: readonly string[]) => ({
    runtime: 'node',
    filePath: process.execPath,
    args: ['--no-warnings', '--no-deprecation', '/tmp/apps/cli/index.mjs', ...args],
  }),
}));

describe('buildHappierToolsShellBridgeCommand', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' }));
  it.each(['home', 'full'])('retains opt-in %s context for the existing Windows shell bridge', async mode => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const previousMode = process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV;
    const previousHome = process.env.HAPPIER_HOME_DIR;
    const previousServer = process.env.HAPPIER_SERVER_URL;
    process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV = mode;
    const home = await mkdtemp(join(tmpdir(), 'happier-windows-shell-'));
    process.env.HAPPIER_HOME_DIR = home;
    process.env.HAPPIER_SERVER_URL = 'https://windows-home.example.test';
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    vi.resetModules();
    try {
      const { buildHappierToolsShellBridgeCommand } = await import('./buildHappierToolsShellBridgeCommand');
      const command = buildHappierToolsShellBridgeCommand(['list', '--json']);
      expect(command).toContain('HAPPIER_HOME_DIR=');
      expect(command).toContain(home);
      if (mode === 'full') expect(command).toContain('HAPPIER_SERVER_URL=');
      else expect(command).not.toContain('HAPPIER_SERVER_URL=');
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (previousMode === undefined) delete process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV;
      else process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV = previousMode;
      if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = previousHome;
      if (previousServer === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = previousServer;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('recognizes only the exact locally generated bridge launcher as trusted', async () => {
    const {
      buildHappierToolsShellBridgeCommand,
      parseTrustedHappierToolsShellBridgeCommand,
    } = await import('./buildHappierToolsShellBridgeCommand');
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

    expect(parseTrustedHappierToolsShellBridgeCommand(command)).toMatchObject({
      kind: 'call',
      source: 'happier',
      tool: 'change_title',
      agentBridge: true,
    });
    expect(
      parseTrustedHappierToolsShellBridgeCommand(
        `happier tools call --source happier --tool change_title --args-json '{"title":"Renamed"}' --json`,
      ),
    ).toBeNull();
    expect(
      parseTrustedHappierToolsShellBridgeCommand(
        `node ./happier-helper.js tools call --source happier --tool change_title --args-json '{"title":"Renamed"}' --json`,
      ),
    ).toBeNull();
    expect(parseTrustedHappierToolsShellBridgeCommand(`${command} && touch /tmp/happier-pwn`)).toBeNull();
    // The generated bridge form is always Agent-produced. A command that is
    // byte-identical apart from the missing provenance marker is not the shape
    // this CLI generates, so it is not the trusted one either.
    expect(
      parseTrustedHappierToolsShellBridgeCommand(command.replace(`'--agent-bridge' `, '')),
    ).toBeNull();
  });

  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalContextEnv = process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV;
  const originalActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalLocalServerUrl = process.env.HAPPIER_LOCAL_SERVER_URL;
  const originalPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalAccessToken = process.env.HAPPIER_ACCESS_TOKEN;

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
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
    expect(command).toContain(`'tools' 'call' '--agent-bridge' '--source' 'happier' '--tool' 'change_title'`);
    // Never embed credentials.
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });

  it('does not restore custodian home when legacy home context is configured', async () => {
    process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV = 'home';
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
    expect(command).not.toContain('HAPPIER_ACTIVE_SERVER_ID=');
    expect(command).not.toContain('HAPPIER_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_LOCAL_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_PUBLIC_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_WEBAPP_URL=');
    // Binary-safe invocation of the tools CLI.
    expect(command).toContain(`'tools' 'call' '--agent-bridge' '--source' 'happier' '--tool' 'change_title'`);
    // Never embed credentials.
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });

  it('does not expose Account context when legacy full context is configured', async () => {
    process.env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV = 'full';
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
    expect(command).not.toContain('HAPPIER_ACTIVE_SERVER_ID=');
    expect(command).not.toContain('HAPPIER_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_PUBLIC_SERVER_URL=');
    expect(command).not.toContain('HAPPIER_WEBAPP_URL=');
    expect(command).not.toContain('secret-token-that-must-not-be-embedded');
    expect(command).not.toContain('HAPPIER_ACCESS_TOKEN');
  });
});
