import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { readSettings } from '@/persistence';
import { captureConsoleLogAndMuteStdout, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import type { ProbeServerVersionResult } from '@/server/serverTest';
import type { DaemonServiceListEntry } from '@/daemon/service/cli';

let promptAnswers: string[] = [];
let promptQuestions: string[] = [];

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (prompt: string, cb: (answer: string) => void) => {
      promptQuestions.push(prompt);
      cb(promptAnswers.shift() ?? '');
    },
    close: () => {},
  }),
}));

const { probeServerVersionMock, resolveInstalledDaemonServiceInventoryForCurrentRelayMock } = vi.hoisted(() => ({
  probeServerVersionMock: vi.fn<(serverUrl: string) => Promise<ProbeServerVersionResult>>(),
  resolveInstalledDaemonServiceInventoryForCurrentRelayMock: vi.fn<(...args: unknown[]) => Promise<readonly DaemonServiceListEntry[]>>(async () => []),
}));

vi.mock('@/server/serverTest', () => ({
  probeServerVersion: (serverUrl: string) => probeServerVersionMock(serverUrl),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: async () => ({ status: 'error', reason: 'network' }),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/ownership/daemonServiceInventory')>();
  return {
    ...actual,
    resolveInstalledDaemonServiceInventoryForCurrentRelay: (...args: Parameters<typeof actual.resolveInstalledDaemonServiceInventoryForCurrentRelay>) =>
      resolveInstalledDaemonServiceInventoryForCurrentRelayMock(...args),
  };
});

const spawnHappyCLIMock = vi.fn();
vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: (...args: unknown[]) => spawnHappyCLIMock(...args),
}));

import { handleServerCommand } from './server';
import { runServerSubcommand } from './server/subcommands';

const UNREACHABLE_URL = 'https://typo.example.test';

function setTtyMode(isTty: boolean): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: isTty });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: isTty });

  return () => {
    if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  };
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'happier-server-add-validate-'));
  const prevHome = process.env.HAPPIER_HOME_DIR;
  const prevServerUrl = process.env.HAPPIER_SERVER_URL;
  const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  try {
    process.env.HAPPIER_HOME_DIR = home;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;
    reloadConfiguration();
    await run(home);
  } finally {
    if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = prevHome;
    if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = prevServerUrl;
    if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
    reloadConfiguration();
    await rm(home, { recursive: true, force: true });
  }
}

afterEach(() => {
  promptAnswers = [];
  promptQuestions = [];
  probeServerVersionMock.mockReset();
  spawnHappyCLIMock.mockReset();
  resolveInstalledDaemonServiceInventoryForCurrentRelayMock.mockReset();
  resolveInstalledDaemonServiceInventoryForCurrentRelayMock.mockResolvedValue([]);
});

describe('happier server add validates the relay before persisting it', () => {
  it('refuses to persist an unreachable relay in non-interactive mode', async () => {
    const restoreTty = setTtyMode(false);
    probeServerVersionMock.mockResolvedValue({ ok: false, url: `${UNREACHABLE_URL}/v1/version`, status: null, error: 'getaddrinfo ENOTFOUND typo.example.test' });

    try {
      await withHome(async () => {
        await expect(
          handleServerCommand(['add', '--name', 'Typo', '--server-url', UNREACHABLE_URL, '--use']),
        ).rejects.toThrow(/--yes/);

        expect(probeServerVersionMock).toHaveBeenCalledWith(UNREACHABLE_URL);
        const settings = await readSettings();
        expect(settings.servers?.Typo).toBeUndefined();
        expect(settings.activeServerId).not.toBe('Typo');
      });
    } finally {
      restoreTty();
    }
  });

  it('never prompts in --json mode, even on a TTY', async () => {
    const restoreTty = setTtyMode(true);
    probeServerVersionMock.mockResolvedValue({ ok: false, url: `${UNREACHABLE_URL}/v1/version`, status: null, error: 'request_timeout' });

    try {
      await withHome(async () => {
        await expect(
          runServerSubcommand('add', ['add', '--name', 'Typo', '--server-url', UNREACHABLE_URL, '--use', '--json']),
        ).rejects.toThrow();

        expect(promptQuestions).toEqual([]);
        const settings = await readSettings();
        expect(settings.servers?.Typo).toBeUndefined();
      });
    } finally {
      restoreTty();
    }
  });

  it('reports the refusal as a server_unreachable envelope in --json mode', async () => {
    const restoreTty = setTtyMode(false);
    const prevExitCode = process.exitCode;
    probeServerVersionMock.mockResolvedValue({ ok: false, url: `${UNREACHABLE_URL}/v1/version`, status: null, error: 'request_timeout' });

    const stdout = captureStdoutJsonOutput();
    try {
      await withHome(async () => {
        process.exitCode = undefined;
        await handleServerCommand(['add', '--name', 'Typo', '--server-url', UNREACHABLE_URL, '--use', '--json']);

        const envelope = stdout.json<{ ok: boolean; kind: string; error?: { code?: string } }>();
        expect(envelope.ok).toBe(false);
        expect(envelope.kind).toBe('server_add');
        expect(envelope.error?.code).toBe('server_unreachable');
        expect(process.exitCode).toBe(1);
      });
    } finally {
      stdout.restore();
      process.exitCode = prevExitCode;
      restoreTty();
    }
  });

  it('asks before saving an unreachable relay on a TTY and saves nothing when declined', async () => {
    const restoreTty = setTtyMode(true);
    probeServerVersionMock.mockResolvedValue({ ok: false, url: `${UNREACHABLE_URL}/v1/version`, status: 502, error: 'http_502' });
    promptAnswers = ['']; // default answer

    const output = captureConsoleLogAndMuteStdout();
    try {
      await withHome(async () => {
        await expect(
          handleServerCommand(['add', '--name', 'Typo', '--server-url', UNREACHABLE_URL, '--use']),
        ).rejects.toThrow(/not saved/i);

        expect(promptQuestions.join('\n')).toContain('anyway');
        expect(output.logs.join('\n')).toContain('http_502');
        const settings = await readSettings();
        expect(settings.servers?.Typo).toBeUndefined();
      });
    } finally {
      output.restore();
      restoreTty();
    }
  });

  it('saves an unreachable relay when the user confirms on a TTY', async () => {
    const restoreTty = setTtyMode(true);
    probeServerVersionMock.mockResolvedValue({ ok: false, url: `${UNREACHABLE_URL}/v1/version`, status: null, error: 'request_timeout' });
    promptAnswers = ['y'];

    const output = captureConsoleLogAndMuteStdout();
    try {
      await withHome(async () => {
        await handleServerCommand(['add', '--name', 'Typo', '--server-url', UNREACHABLE_URL, '--use']);

        const settings = await readSettings();
        expect(settings.servers?.Typo?.serverUrl).toBe(UNREACHABLE_URL);
        expect(settings.activeServerId).toBe('Typo');
      });
    } finally {
      output.restore();
      restoreTty();
    }
  });

  it('saves without probing when --yes is passed', async () => {
    const restoreTty = setTtyMode(false);

    try {
      await withHome(async () => {
        await handleServerCommand(['add', '--name', 'Typo', '--server-url', UNREACHABLE_URL, '--use', '--yes']);

        expect(probeServerVersionMock).not.toHaveBeenCalled();
        const settings = await readSettings();
        expect(settings.servers?.Typo?.serverUrl).toBe(UNREACHABLE_URL);
      });
    } finally {
      restoreTty();
    }
  });

  it('saves a reachable relay without asking anything', async () => {
    const restoreTty = setTtyMode(true);
    probeServerVersionMock.mockResolvedValue({ ok: true, url: 'https://relay.example.test/v1/version', version: '0.2.0' });

    const output = captureConsoleLogAndMuteStdout();
    try {
      await withHome(async () => {
        await handleServerCommand(['add', '--name', 'Good', '--server-url', 'https://relay.example.test', '--use']);

        expect(promptQuestions).toEqual([]);
        const settings = await readSettings();
        expect(settings.servers?.Good?.serverUrl).toBe('https://relay.example.test');
        expect(settings.activeServerId).toBe('Good');
      });
    } finally {
      output.restore();
      restoreTty();
    }
  });

  it('probes the local API URL when the profile carries one', async () => {
    const restoreTty = setTtyMode(false);
    probeServerVersionMock.mockResolvedValue({ ok: true, url: 'http://127.0.0.1:53545/v1/version', version: '0.2.0' });

    try {
      await withHome(async () => {
        await handleServerCommand([
          'add',
          '--name',
          'Local',
          '--server-url',
          'http://127.0.0.1:53545',
          '--public-server-url',
          'https://relay.example.test',
          '--use',
        ]);

        expect(probeServerVersionMock).toHaveBeenCalledWith('http://127.0.0.1:53545');
      });
    } finally {
      restoreTty();
    }
  });
});
