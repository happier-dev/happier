import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { CliApiTokenChildContinuationError } from '@/auth/cliApiToken';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

const startHappyHeadlessInTmux = vi.fn(async () => {});
const contributionRegistry = vi.hoisted(() => ({ resolve: vi.fn() }));

// TMUX launcher touches the host environment; treat it as a boundary and stub it in unit tests.
vi.mock('@/integrations/tmux/startHeadlessSession', () => ({
  startHappyHeadlessInTmux,
}));
vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', async importOriginal => ({
  ...await importOriginal<typeof import('@/plugins/projection/registry/createResolvedContributionRegistry')>(),
  resolveMergedContributionRegistry: contributionRegistry.resolve,
}));
vi.mock('@/persistence', () => ({ readCredentials: vi.fn(async () => null), readStoredCredentials: vi.fn(async () => null) }));
vi.mock('@/session/actions/approvals/credentialedTargetActionCurrentIntent', () => ({ createCredentialedTargetActionCurrentIntent: vi.fn() }));

import { dispatchCli } from './dispatch';
import { synchronizePluginCommandContributions } from './commandRegistry';

function pluginCommands(tmux: 'inherit' | 'required' | 'forbidden'): ResolvedContributionRegistry {
  const plugin = {
    pluginId: 'acme.notes', pluginRootPath: '/plugins/acme.notes', daemonEntryPath: '/plugins/acme.notes/daemon.mjs', devDaemonEntryPath: null,
    manifestPath: '/plugins/acme.notes/plugin.json', sourceSpec: { kind: 'path', locator: '/plugins/acme.notes', trustPolicy: 'local_trusted', installPolicy: 'link' },
    manifest: normalizePluginManifestV2({ schemaVersion: 2, id: 'acme.notes', version: '1.0.0', displayName: 'Notes',
      engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
      contributes: { actions: [{ id: 'watch', title: 'Watch', scopes: ['global'], surfaces: ['cli'],
        dangerLevel: 'safe', execution: { target: 'daemon' }, cli: { path: ['notes', 'watch'], tmux } }] },
    }),
  };
  return createResolvedContributionRegistry({ actions: buildPluginContributionRegistry({ loadedPlugins: [{
    ...plugin, sourceSpec: { kind: 'path', locator: '/plugins/acme.notes', trustPolicy: 'local_trusted', installPolicy: 'link' },
  }] }).actions.map(action => ({ ...action, provenance: 'external', source: { kind: 'path' } })) });
}

describe('dispatchCli --tmux disallowed controller commands', () => {
  let consoleErrorSpy: MockInstance;
  let exitSpy: MockInstance;
  const originalTmux = process.env.TMUX;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      const normalized = typeof code === 'number' ? code : Number(code ?? 0);
      throw new Error(`process.exit(${Number.isFinite(normalized) ? normalized : 0})`);
    });

    exitSpy.mockClear();
    startHappyHeadlessInTmux.mockClear();
    consoleErrorSpy.mockClear();
    contributionRegistry.resolve.mockReset();
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  });

  it('launches a required plugin command once and does not relaunch inside truthful tmux mode', async () => {
    const snapshot = pluginCommands('required');
    synchronizePluginCommandContributions(snapshot);
    contributionRegistry.resolve.mockResolvedValue(snapshot);

    await dispatchCli({
      args: ['notes', 'watch'], rawArgv: ['happier', 'notes', 'watch'], terminalRuntime: null,
    });
    expect(startHappyHeadlessInTmux).toHaveBeenCalledOnce();

    startHappyHeadlessInTmux.mockClear();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await dispatchCli({
        args: ['notes', 'watch', '--help'],
        rawArgv: ['happier', 'notes', 'watch', '--help'],
        terminalRuntime: null,
      });
      await dispatchCli({
        args: ['notes', 'watch', '--help'],
        rawArgv: ['happier', 'notes', 'watch', '--help'],
        terminalRuntime: { mode: 'tmux', requested: 'tmux' },
      });
    } finally {
      log.mockRestore();
    }
    expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
  });

  it('uses the real tmux environment to avoid required double-launch and reject forbidden commands', async () => {
    process.env.TMUX = '/tmp/tmux-501/default,123,0';

    const requiredSnapshot = pluginCommands('required');
    synchronizePluginCommandContributions(requiredSnapshot);
    contributionRegistry.resolve.mockResolvedValue(requiredSnapshot);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await dispatchCli({
        args: ['notes', 'watch', '--help'], rawArgv: ['happier', 'notes', 'watch', '--help'], terminalRuntime: null,
      });
    } finally {
      log.mockRestore();
    }
    expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();

    const forbiddenSnapshot = pluginCommands('forbidden');
    synchronizePluginCommandContributions(forbiddenSnapshot);
    await expect(dispatchCli({
      args: ['notes', 'watch'], rawArgv: ['happier', 'notes', 'watch'], terminalRuntime: null,
    })).rejects.toThrow('process.exit(1)');
    expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
  });

  it('returns exactly one JSON envelope when a required tmux launch succeeds', async () => {
    const snapshot = pluginCommands('required');
    synchronizePluginCommandContributions(snapshot);
    const output = captureConsoleJsonOutput();
    const previousExitCode = process.exitCode;
    try {
      await dispatchCli({
        args: ['notes', 'watch', '--json'],
        rawArgv: ['happier', 'notes', 'watch', '--json'],
        terminalRuntime: null,
      });
      expect(output.logs).toHaveLength(1);
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'cli_dispatch',
        data: { command: 'notes', launched: 'tmux' },
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('returns exactly one JSON envelope when a required tmux launch fails', async () => {
    const snapshot = pluginCommands('required');
    synchronizePluginCommandContributions(snapshot);
    startHappyHeadlessInTmux.mockRejectedValueOnce(new Error('tmux unavailable'));
    const output = captureConsoleJsonOutput();
    const previousExitCode = process.exitCode;
    try {
      await dispatchCli({
        args: ['notes', 'watch', '--json'],
        rawArgv: ['happier', 'notes', 'watch', '--json'],
        terminalRuntime: null,
      });
      expect(output.logs).toHaveLength(1);
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'cli_dispatch',
        error: { code: 'tmux_launch_failed' },
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('preserves the typed compound-token continuation refusal at the root JSON boundary', async () => {
    const snapshot = pluginCommands('required');
    synchronizePluginCommandContributions(snapshot);
    startHappyHeadlessInTmux.mockRejectedValueOnce(new CliApiTokenChildContinuationError());
    const output = captureConsoleJsonOutput<{
      ok: boolean;
      kind: string;
      error?: { code?: string; message?: string };
    }>();
    const previousExitCode = process.exitCode;
    try {
      await dispatchCli({
        args: ['notes', 'watch', '--json'],
        rawArgv: ['happier', 'notes', 'watch', '--json'],
        terminalRuntime: null,
      });
      expect(output.logs).toHaveLength(1);
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'cli_dispatch',
        error: { code: 'api_token_child_continuation_unsupported' },
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('keeps plugin command JSON output to one machine-readable stdout envelope', async () => {
    const snapshot = pluginCommands('inherit');
    synchronizePluginCommandContributions(snapshot);
    contributionRegistry.resolve.mockResolvedValue(snapshot);
    const output = captureConsoleJsonOutput<{ ok: boolean; kind: string; error?: { code?: string } }>();
    const previousExitCode = process.exitCode;
    try {
      await dispatchCli({
        args: ['notes', 'missing', '--json'],
        rawArgv: ['happier', 'notes', 'missing', '--json'],
        terminalRuntime: null,
      });
      expect(output.logs).toHaveLength(1);
      expect(output.json()).toMatchObject({ ok: false, kind: 'plugin_command', error: { code: 'plugin_command_unknown' } });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('keeps plugin command help machine-readable when --json is requested', async () => {
    const snapshot = pluginCommands('inherit');
    synchronizePluginCommandContributions(snapshot);
    contributionRegistry.resolve.mockResolvedValue(snapshot);
    const output = captureConsoleJsonOutput();
    const previousExitCode = process.exitCode;
    try {
      await dispatchCli({
        args: ['notes', 'watch', '--help', '--json'],
        rawArgv: ['happier', 'notes', 'watch', '--help', '--json'],
        terminalRuntime: null,
      });
      expect(output.logs).toHaveLength(1);
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugin_command_help',
        data: { root: 'notes', text: expect.stringContaining('Usage: happier notes watch') },
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('keeps registry acquisition failures machine-readable in plugin JSON mode', async () => {
    const snapshot = pluginCommands('inherit');
    synchronizePluginCommandContributions(snapshot);
    contributionRegistry.resolve.mockRejectedValueOnce(new Error('registry unavailable'));
    const output = captureConsoleJsonOutput();
    const previousExitCode = process.exitCode;
    try {
      await dispatchCli({
        args: ['notes', 'watch', '--json'],
        rawArgv: ['happier', 'notes', 'watch', '--json'],
        terminalRuntime: null,
      });
      expect(output.logs).toHaveLength(1);
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugin_command',
        error: { code: 'plugin_command_registry_unavailable' },
      });
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  });

  it('rejects --tmux for session controller commands', async () => {
    await expect(
      dispatchCli({
        args: ['session', 'list', '--tmux'],
        rawArgv: ['happier', 'session', 'list', '--tmux'],
        terminalRuntime: null,
      }),
    ).rejects.toThrow('process.exit(1)');
    expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
  });

  it('does not start tmux when process.exit is mocked to no-op', async () => {
    exitSpy.mockImplementation(() => undefined);

    await expect(
      dispatchCli({
        args: ['session', 'list', '--tmux'],
        rawArgv: ['happier', 'session', 'list', '--tmux'],
        terminalRuntime: null,
      }),
    ).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
  });

  it('returns a JSON dispatch error when --tmux is used with a controller command in JSON mode', async () => {
    const output = captureConsoleJsonOutput();

    try {
      await dispatchCli({
        args: ['session', 'list', '--tmux', '--json'],
        rawArgv: ['happier', 'session', 'list', '--tmux', '--json'],
        terminalRuntime: null,
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('cli_dispatch');
      expect(parsed.error?.code).toBe('tmux_not_allowed');
      expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });
});
