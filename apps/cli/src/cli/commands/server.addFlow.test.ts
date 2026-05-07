import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { readSettings } from '@/persistence';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { buildLaunchAgentPlistXml } from '@/daemon/service/darwin';
import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths, type DaemonServiceListEntry } from '@/daemon/service/cli';
import { renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

let promptAnswers: string[] = [];
let promptQuestions: string[] = [];
const { resolveInstalledDaemonServiceInventoryForCurrentRelayMock } = vi.hoisted(() => ({
  resolveInstalledDaemonServiceInventoryForCurrentRelayMock: vi.fn<(...args: unknown[]) => Promise<readonly DaemonServiceListEntry[]>>(async () => []),
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (prompt: string, cb: (answer: string) => void) => {
      promptQuestions.push(prompt);
      cb(promptAnswers.shift() ?? '');
    },
    close: () => {},
  }),
}));

const spawnHappyCLIMock = vi.fn();
vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: (...args: unknown[]) => spawnHappyCLIMock(...args),
}));

const fetchServerFeaturesSnapshotMock = vi.fn<
  (params: Readonly<{ serverUrl: string; timeoutMs?: number }>) => Promise<unknown>
>();

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: (params: Readonly<{ serverUrl: string; timeoutMs?: number }>) =>
    fetchServerFeaturesSnapshotMock(params),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/ownership/daemonServiceInventory')>();
  return {
    ...actual,
    resolveInstalledDaemonServiceInventoryForCurrentRelay: (...args: Parameters<typeof actual.resolveInstalledDaemonServiceInventoryForCurrentRelay>) =>
      resolveInstalledDaemonServiceInventoryForCurrentRelayMock(...args),
  };
});

import { handleServerCommand } from './server';
import { runServerSubcommand } from './server/subcommands';

const runTailscaleServeStatusMock = vi.fn<
  (params: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv; tailscaleBin: string }>) => Promise<string>
>();

vi.mock('@/integrations/tailscale/tailscaleCommand', () => ({
  runTailscaleServeStatus: (params: Readonly<{ timeoutMs: number; env: NodeJS.ProcessEnv; tailscaleBin: string }>) =>
    runTailscaleServeStatusMock(params),
}));

function setTtyMode(stdinIsTTY: boolean, stdoutIsTTY: boolean): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinIsTTY });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutIsTTY });

  return () => {
    if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    else delete (process.stdin as any).isTTY;
    if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    else delete (process.stdout as any).isTTY;
  };
}

afterEach(() => {
  resolveInstalledDaemonServiceInventoryForCurrentRelayMock.mockReset();
});

function installDefaultFollowingServiceFixture(homeDir: string): void {
  process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
    ? process.platform
    : 'linux';
  process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = homeDir;
  process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = join(homeDir, '.happier');
  process.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE = 'default-following';
  reloadConfiguration();

  const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env });
  const paths = resolveDaemonServicePaths(runtime);
  mkdirSync(dirname(paths.installedPath), { recursive: true });

  if (runtime.platform === 'darwin') {
    writeFileSync(
      paths.installedPath,
      buildLaunchAgentPlistXml({
        label: paths.label,
        programArgs: [runtime.nodePath, runtime.entryPath, 'daemon', 'start-sync'].filter(Boolean),
        env: {
          HAPPIER_HOME_DIR: join(homeDir, '.happier'),
          HAPPIER_PUBLIC_RELEASE_CHANNEL: runtime.channel,
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
          HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        },
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        workingDirectory: '/tmp',
      }),
      'utf8',
    );
    return;
  }

  if (runtime.platform === 'linux') {
    writeFileSync(
      paths.installedPath,
      renderSystemdServiceUnit({
        description: 'Happier Daemon',
        execStart: [runtime.nodePath, runtime.entryPath, 'daemon', 'start-sync'].filter(Boolean),
        env: {
          HAPPIER_HOME_DIR: join(homeDir, '.happier'),
          HAPPIER_PUBLIC_RELEASE_CHANNEL: runtime.channel,
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
          HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
        },
        wantedBy: 'default.target',
      }),
      'utf8',
    );
    return;
  }

  writeFileSync(
    paths.installedPath,
    renderWindowsScheduledTaskWrapperPs1({
      programArgs: [runtime.nodePath, runtime.entryPath, 'daemon', 'start-sync'].filter(Boolean),
      env: {
        HAPPIER_HOME_DIR: join(homeDir, '.happier'),
        HAPPIER_PUBLIC_RELEASE_CHANNEL: runtime.channel,
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      },
    }),
    'utf8',
  );
}

describe('happier server add guided flow', () => {
  it('guides for missing required values in interactive mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-guided-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const restoreTty = setTtyMode(true, true);
    promptAnswers = [
      'https://company.example.test', // server URL
      'Company', // profile name
      'y', // use as active
    ];
    promptQuestions = [];

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleServerCommand(['add']);
      } finally {
        output.restore();
      }

      const settings = await readSettings();
      expect(settings.activeServerId).toBe('Company');
      expect(settings.servers?.Company?.serverUrl).toBe('https://company.example.test');
      expect(settings.servers?.Company?.webappUrl).toBe('https://company.example.test');
      expect(spawnHappyCLIMock).not.toHaveBeenCalled();
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      promptAnswers = [];
      promptQuestions = [];
      spawnHappyCLIMock.mockReset();
    }
  });

  it('prompts for a canonical share URL when the interactive --server-url looks local-only', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-guided-local-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const restoreTty = setTtyMode(true, true);
    promptAnswers = [
      'http://127.0.0.1:53545', // local server URL
      'y', // local-only confirmation
      'https://company.example.test', // canonical share URL
      'Local', // profile name
      'y', // use as active
    ];
    promptQuestions = [];

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      const output = captureConsoleLogAndMuteStdout();
      try {
        await handleServerCommand(['add']);
      } finally {
        output.restore();
      }

      const settings = await readSettings();
      expect(settings.activeServerId).toBe('Local');
      expect(settings.servers?.Local?.serverUrl).toBe('https://company.example.test');
      expect((settings.servers as any)?.Local?.localServerUrl).toBe('http://127.0.0.1:53545');
      expect(settings.servers?.Local?.webappUrl).toBe('https://company.example.test');
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      promptAnswers = [];
      promptQuestions = [];
      spawnHappyCLIMock.mockReset();
    }
  });

  it('fails fast with instructions in non-interactive mode when required args are missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-noninteractive-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const restoreTty = setTtyMode(false, false);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await expect(runServerSubcommand('add', ['add'])).rejects.toThrow('Non-interactive mode');
      expect(spawnHappyCLIMock).not.toHaveBeenCalled();
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      spawnHappyCLIMock.mockReset();
    }
  });

  it('defaults webapp URL from --server-url in non-interactive mode when --webapp-url is omitted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-default-webapp-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const restoreTty = setTtyMode(false, false);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      process.env.HAPPIER_SERVER_URL = 'https://active-server.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://active-webapp.example.test';
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
      ]);

      const settings = await readSettings();
      expect(settings.servers?.Company?.serverUrl).toBe('https://company.example.test');
      expect(settings.servers?.Company?.webappUrl).toBe('https://company.example.test');
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      spawnHappyCLIMock.mockReset();
    }
  });

  it('does not prompt when --name/--server-url/--use are provided in interactive mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-no-prompts-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const restoreTty = setTtyMode(true, true);
    promptAnswers = [];
    promptQuestions = [];

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
        '--use',
      ]);

      expect(promptQuestions).toEqual([]);
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      promptAnswers = [];
      promptQuestions = [];
      spawnHappyCLIMock.mockReset();
    }
  });

  it('defaults webapp URL to Happier Cloud webapp when --server-url points at the cloud API', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-cloud-webapp-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const restoreTty = setTtyMode(false, false);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'CloudCopy',
        '--server-url',
        'https://api.happier.dev',
      ]);

      const settings = await readSettings();
      expect(settings.servers?.CloudCopy?.serverUrl).toBe('https://api.happier.dev');
      expect(settings.servers?.CloudCopy?.webappUrl).toBe('https://app.happier.dev');
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      spawnHappyCLIMock.mockReset();
    }
  });

  it('runs daemon action commands when explicit flags are passed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-actions-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const restoreTty = setTtyMode(false, false);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      spawnHappyCLIMock.mockImplementation((argv: string[]) => {
        return {
          on: (event: string, handler: (...args: unknown[]) => void) => {
            if (event === 'close') handler(0);
            return undefined;
          },
        };
      });

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
        '--webapp-url',
        'https://company.example.test',
        '--use',
        '--install-service',
      ]);

      expect(spawnHappyCLIMock).toHaveBeenCalledTimes(1);
      expect(spawnHappyCLIMock).toHaveBeenCalledWith(
        ['--server', 'Company', 'daemon', 'service', 'install'],
        expect.objectContaining({ stdio: 'inherit' }),
      );
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      spawnHappyCLIMock.mockReset();
    }
  });

  it('treats legacy --public-server-url as canonical serverUrl and legacy --server-url as localServerUrl', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-public-url-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const restoreTty = setTtyMode(false, false);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'http://127.0.0.1:53545',
        '--public-server-url',
        'https://company.example.test',
        '--webapp-url',
        'https://app.company.example',
        '--use',
      ]);

      const raw = JSON.parse(await readFile(join(home, 'settings.json'), 'utf-8'));
      expect(raw?.servers?.Company?.serverUrl).toBe('https://company.example.test');
      expect(raw?.servers?.Company?.localServerUrl).toBe('http://127.0.0.1:53545');
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      spawnHappyCLIMock.mockReset();
    }
  });

  it('auto-detects public URL from Tailscale Serve when serverUrl is loopback and --public-server-url is omitted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-auto-public-url-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const restoreTty = setTtyMode(false, false);

    runTailscaleServeStatusMock.mockResolvedValueOnce(
      [
        'https://my-machine.tailnet.ts.net',
        '|-- / proxy http://127.0.0.1:53545',
        '',
      ].join('\n'),
    );

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Local',
        '--server-url',
        'http://127.0.0.1:53545',
        '--webapp-url',
        'https://app.company.example',
        '--use',
      ]);

      const raw = JSON.parse(await readFile(join(home, 'settings.json'), 'utf-8'));
      expect(raw?.servers?.Local?.serverUrl).toBe('https://my-machine.tailnet.ts.net');
      expect(raw?.servers?.Local?.localServerUrl).toBe('http://127.0.0.1:53545');
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      runTailscaleServeStatusMock.mockReset();
      spawnHappyCLIMock.mockReset();
    }
  });

  it('adopts canonical URL from server capabilities without persisting remote http as localServerUrl', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-adopt-canonical-safe-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const restoreTty = setTtyMode(false, false);

    fetchServerFeaturesSnapshotMock.mockResolvedValueOnce({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          server: {
            canonicalServerUrl: 'https://public.example.test',
          },
        },
      }),
    });

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Selfhost',
        '--server-url',
        'http://public.example.test',
        '--use',
      ]);

      const raw = JSON.parse(await readFile(join(home, 'settings.json'), 'utf-8'));
      expect(raw?.servers?.Selfhost?.serverUrl).toBe('https://public.example.test');
      expect(raw?.servers?.Selfhost?.localServerUrl).toBeUndefined();
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      fetchServerFeaturesSnapshotMock.mockReset();
      runTailscaleServeStatusMock.mockReset();
      spawnHappyCLIMock.mockReset();
    }
  });

  it('guides to restart a default-following background service after adding and using a new server', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-use-followup-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevDaemonPlatform = process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
    const prevDaemonUserHomeDir = process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
    const prevDaemonHappierHomeDir = process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
    const prevDaemonTargetMode = process.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE;
    const restoreTty = setTtyMode(false, false);
    const output = captureConsoleLogAndMuteStdout();

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'A',
        '--server-url',
        'https://a.example.test',
        '--webapp-url',
        'https://a.example.test',
        '--use',
      ]);
      await handleServerCommand([
        'add',
        '--name',
        'B',
        '--server-url',
        'https://b.example.test',
        '--webapp-url',
        'https://b.example.test',
      ]);

      resolveInstalledDaemonServiceInventoryForCurrentRelayMock.mockResolvedValueOnce([
        {
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: '/tmp/happier-daemon.default.service',
          platform: process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
            ? process.platform
            : 'linux',
          releaseChannel: 'stable',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        },
      ]);

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
        '--webapp-url',
        'https://company.example.test',
        '--use',
      ]);

      const out = output.logs.join('\n');
      expect(out).toContain('Authenticate Happier against https://company.example.test');
      expect(out).toContain('happier auth login');
      expect(out).toContain('happier service restart');
    } finally {
      output.restore();
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevDaemonPlatform === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
      else process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = prevDaemonPlatform;
      if (prevDaemonUserHomeDir === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = prevDaemonUserHomeDir;
      if (prevDaemonHappierHomeDir === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR = prevDaemonHappierHomeDir;
      if (prevDaemonTargetMode === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE;
      else process.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE = prevDaemonTargetMode;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });
});
