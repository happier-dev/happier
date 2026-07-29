import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '@/cli/commandRegistry';
import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';

const daemon = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => undefined),
  requestChange: vi.fn(),
  decideChange: vi.fn(),
  confirm: vi.fn(),
}));
const pluginRegistry = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemon', () => ({
  ensureDaemonRunningForSessionCommand: daemon.ensureRunning,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: daemon.requestChange,
  decideDaemonPluginChange: daemon.decideChange,
}));

vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({
  promptConfirmYesNo: daemon.confirm,
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  resolveMergedContributionRegistry: vi.fn(),
}));
vi.mock('@/plugins/store/registry/currentState', () => ({
  createPluginRegistryStateStore: () => Object.freeze({
    read: pluginRegistry.read,
  }),
}));

vi.mock('@happier-dev/agents', () => ({
  AGENT_IDS: [],
  getAgentCliRuntimeSpec: vi.fn(),
}));

import { runInstallCliCommand } from './install';

const reviewRequired = {
  kind: 'reviewRequired' as const,
  pendingChangeId: 'pending-1',
  review: createPluginInstallationReviewFixture({
    pluginId: 'acme.sample',
    displayName: 'Acme Sample',
    source: { kind: 'path', locator: '/tmp/acme-sample' },
    updateChannel: { kind: 'path', locator: '/tmp/acme-sample', development: false },
  }),
};

const committed = {
  kind: 'committed' as const,
  pluginId: 'acme.sample',
  desiredGeneration: 'generation-1',
  appliedGeneration: 'generation-1',
  pendingSurfaces: [],
};

function context(args: string[]): CommandContext {
  return { args, rawArgv: ['happier', ...args], terminalRuntime: null };
}

function dependencies(isInteractiveTerminal = true) {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as never,
    runDoctorCommand: vi.fn(),
    invokeAgentCliInstall: vi.fn(),
    isInteractiveTerminal: () => isInteractiveTerminal,
  };
}

beforeEach(() => {
  daemon.ensureRunning.mockClear();
  daemon.requestChange.mockReset();
  daemon.decideChange.mockReset();
  daemon.confirm.mockReset();
  pluginRegistry.read.mockReset();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('install command daemon plugin changes', () => {
  it('routes a new path install through one interactive daemon review', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    daemon.confirm.mockResolvedValue(true);
    daemon.decideChange.mockResolvedValue(committed);
    const deps = dependencies();

    await runInstallCliCommand(context(['install', 'plugin', '/tmp/acme-sample']), deps);

    expect(daemon.ensureRunning).toHaveBeenCalledTimes(1);
    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'installPath', locator: '/tmp/acme-sample', development: false,
    });
    expect(daemon.confirm).toHaveBeenCalledTimes(1);
    expect(daemon.decideChange).toHaveBeenCalledWith(expect.objectContaining({
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: expect.objectContaining({ kind: 'authenticatedLocalUser' }),
    }));
    expect(deps.log).toHaveBeenCalledWith(expect.stringMatching(/Installed plugin acme\.sample/i));
  });

  it('does not let explicit install-and-trust approve facts before the daemon review', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    daemon.confirm.mockResolvedValue(true);
    daemon.decideChange.mockResolvedValue(committed);
    const deps = dependencies(true);

    await runInstallCliCommand(context(['install', 'plugin', '/tmp/acme-sample']), deps);

    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'installPath', locator: '/tmp/acme-sample', development: false,
    });
    expect(daemon.confirm).toHaveBeenCalledWith(expect.any(String), { default: 'no' });
    const reviewPrompt = String(daemon.confirm.mock.calls[0]?.[0]);
    for (const reviewedFact of ['Acme Sample', '1.0.0', '/tmp/acme-sample', 'daemon']) {
      expect(reviewPrompt).toContain(reviewedFact);
    }
    expect(daemon.decideChange).toHaveBeenCalledWith(expect.objectContaining({
      pendingChangeId: 'pending-1',
      decision: 'installAndTrust',
      actorEvidence: expect.objectContaining({ kind: 'authenticatedLocalUser' }),
    }));
  });

  it('normalizes npm installation into the canonical daemon request', async () => {
    daemon.requestChange.mockResolvedValue(committed);
    const deps = dependencies();

    await runInstallCliCommand(context([
      'install', 'plugin', '@acme/sample', '--kind', 'npm', '--selector', '2.0.0',
    ]), deps);

    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'installNpm', packageName: '@acme/sample', selector: '2.0.0',
    });
  });

  it('asks the daemon owner to update an installed plugin without reconstructing its channel', async () => {
    pluginRegistry.read.mockResolvedValue({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.sample': {
          source: {
            kind: 'package',
            locator: '@acme/sample',
            trustPolicy: 'prompt',
            installPolicy: 'managed_install',
            resolvedPath: '/tmp/installed',
            manifestPath: '/tmp/installed/.happier-plugin/plugin.json',
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: {
            mode: 'managed_install',
            manifestVersion: '2.0.0',
            updatePolicy: 'automatic',
            trust: {
              pluginId: 'acme.sample',
              state: 'trusted',
              approvedAtMs: 1,
              distribution: {
                kind: 'npm',
                packageName: '@acme/sample',
                registryOrigin: 'https://registry.example.test',
                registryProfileId: 'registry_private',
              },
            },
          },
          state: { enabled: true },
        },
      },
    });
    daemon.requestChange.mockResolvedValue(committed);
    const deps = dependencies();

    await runInstallCliCommand(context(['install', 'plugin', 'update', 'acme.sample']), deps);

    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'update',
      pluginId: 'acme.sample',
    });
  });

  it('leaves review pending in a headless terminal', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    const deps = dependencies(false);

    await runInstallCliCommand(context(['install', 'plugin', '/tmp/acme-sample']), deps);

    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'installPath', locator: '/tmp/acme-sample', development: false,
    });
    expect(daemon.confirm).not.toHaveBeenCalled();
    expect(daemon.decideChange).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/review/i));
  });

  it('reports the specific daemon failure message for a plugin install', async () => {
    const message =
      'Storage-pressure quarantine eviction cleanup remains pending: reconciliation: generationCleanup unavailable';
    daemon.requestChange.mockResolvedValue({
      kind: 'failed',
      code: 'plugin_install_failed',
      message,
    });
    const deps = dependencies();

    await runInstallCliCommand(context(['install', 'plugin', '/tmp/acme-sample']), deps);

    expect(deps.error).toHaveBeenCalledWith(expect.anything(), message);
  });
});
