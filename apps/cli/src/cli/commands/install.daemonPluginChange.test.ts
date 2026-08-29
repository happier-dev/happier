import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';

const daemon = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => undefined),
  requestChange: vi.fn(),
  decideChange: vi.fn(),
  confirm: vi.fn(),
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

import { handlePluginsCommand } from './plugins';

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

/**
 * `happier plugins update` is the one CLI surface for the daemon's explicit
 * `{ kind: 'update' }` request. The daemon reconstructs the installed plugin's
 * own channel; these tests pin that the CLI never rebuilds one client-side and
 * that a headless terminal surfaces a pending review instead of approving it.
 */
describe('plugins update command daemon plugin changes', () => {
  let home: string;
  let envScope: ReturnType<typeof createEnvKeyScope>;

  beforeEach(async () => {
    daemon.ensureRunning.mockClear();
    daemon.requestChange.mockReset();
    daemon.decideChange.mockReset();
    daemon.confirm.mockReset();
    home = await createTempDir('happier-plugins-update-cli-');
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
    reloadConfiguration();
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    await removeTempDir(home);
  });

  it('asks the daemon owner to update an installed plugin without reconstructing its channel', async () => {
    daemon.requestChange.mockResolvedValue(committed);

    const output = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand(['update', 'acme.sample', '--json'], {
        isInteractiveTerminal: () => true,
      });
      expect(output.json<{ ok: boolean; kind: string; data?: { pluginId?: string } }>()).toMatchObject({
        ok: true,
        kind: 'plugins_update',
        data: { pluginId: 'acme.sample' },
      });
    } finally {
      output.restore();
    }

    expect(daemon.ensureRunning).toHaveBeenCalledTimes(1);
    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'update',
      pluginId: 'acme.sample',
    });
    expect(daemon.decideChange).not.toHaveBeenCalled();
  });

  it('leaves a review-required update pending for a present user in a headless terminal', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    const json = captureConsoleJsonOutput();
    try {
      await handlePluginsCommand(['update', 'acme.sample', '--json'], {
        isInteractiveTerminal: () => false,
      });
      expect(json.json<{ ok: boolean; error?: { code?: string } }>()).toMatchObject({
        ok: false,
        error: { code: 'review_required' },
      });
    } finally {
      json.restore();
      process.exitCode = previousExitCode;
    }

    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'update',
      pluginId: 'acme.sample',
    });
    expect(daemon.confirm).not.toHaveBeenCalled();
    expect(daemon.decideChange).not.toHaveBeenCalled();
  });
});
