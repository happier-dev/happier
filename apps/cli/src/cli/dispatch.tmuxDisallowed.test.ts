import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import type { ResolvedCommandContribution, ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

const startHappyHeadlessInTmux = vi.fn(async () => {});
const runtimeLease = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn(async () => {}) }));

// TMUX launcher touches the host environment; treat it as a boundary and stub it in unit tests.
vi.mock('@/integrations/tmux/startHeadlessSession', () => ({
  startHappyHeadlessInTmux,
}));
vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLease.acquire,
}));
vi.mock('@/persistence', () => ({ readCredentials: vi.fn(async () => null) }));
vi.mock('@/session/actions/createCliActionExecutor', () => ({ createCredentialedTargetActionCurrentIntent: vi.fn() }));

import { dispatchCli } from './dispatch';
import { synchronizePluginCommandContributions } from './commandRegistry';

function pluginCommands(tmux: 'inherit' | 'required' | 'forbidden'): ResolvedContributionRegistry {
  const command: ResolvedCommandContribution = {
    provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.notes',
    manifestPath: '/plugins/acme.notes/plugin.json', manifestDigest: 'sha256:notes',
    sourceSpec: { kind: 'path', locator: '/plugins/acme.notes', trustPolicy: 'local_trusted', installPolicy: 'link' },
    definition: { kindVersion: 1, id: 'watch', title: 'Watch', path: ['notes', 'watch'], action: 'run', actionId: 'acme.notes/run', tmux },
  };
  return {
    generationId: `commands:${tmux}`, uiViewsV2: [], uiRenderersV2: [], uiTranslationsV2: [], agents: [],     actions: [], tools: [], commands: [command], resources: [], activationTargets: [],
    actionsById: new Map(), toolsById: new Map(), commandsById: new Map([['acme.notes/watch', command]]), resourcesById: new Map(),
    catalogEntriesById: {}, agentDefinitionsById: new Map(),     pluginDiagnosticsByPluginId: {},
  };
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
    runtimeLease.acquire.mockReset();
    runtimeLease.release.mockClear();
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  });

  it('launches a required plugin command once and does not relaunch inside truthful tmux mode', async () => {
    const snapshot = pluginCommands('required');
    synchronizePluginCommandContributions(snapshot);
    runtimeLease.acquire.mockResolvedValue({ registry: { contributes: snapshot }, release: runtimeLease.release });

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
    expect(runtimeLease.release).toHaveBeenCalledTimes(2);
  });

  it('uses the real tmux environment to avoid required double-launch and reject forbidden commands', async () => {
    process.env.TMUX = '/tmp/tmux-501/default,123,0';

    const requiredSnapshot = pluginCommands('required');
    synchronizePluginCommandContributions(requiredSnapshot);
    runtimeLease.acquire.mockResolvedValue({ registry: { contributes: requiredSnapshot }, release: runtimeLease.release });
    await dispatchCli({
      args: ['notes', 'watch'], rawArgv: ['happier', 'notes', 'watch'], terminalRuntime: null,
    });
    expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
    expect(runtimeLease.release).toHaveBeenCalledOnce();

    const forbiddenSnapshot = pluginCommands('forbidden');
    synchronizePluginCommandContributions(forbiddenSnapshot);
    runtimeLease.release.mockClear();
    await expect(dispatchCli({
      args: ['notes', 'watch'], rawArgv: ['happier', 'notes', 'watch'], terminalRuntime: null,
    })).rejects.toThrow('process.exit(1)');
    expect(startHappyHeadlessInTmux).not.toHaveBeenCalled();
    expect(runtimeLease.release).not.toHaveBeenCalled();
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

  it('keeps plugin command JSON output to one machine-readable stdout envelope', async () => {
    const snapshot = pluginCommands('inherit');
    synchronizePluginCommandContributions(snapshot);
    runtimeLease.acquire.mockResolvedValue({ registry: { contributes: snapshot }, release: runtimeLease.release });
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
    runtimeLease.acquire.mockResolvedValue({ registry: { contributes: snapshot }, release: runtimeLease.release });
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
    runtimeLease.acquire.mockRejectedValueOnce(new Error('registry unavailable'));
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
