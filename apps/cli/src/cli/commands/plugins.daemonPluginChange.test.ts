import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';

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
    packageIdentity: { name: '@acme/sample', version: '1.0.0' },
    source: { kind: 'archive', locator: '/tmp/acme-sample.tgz' },
    updateChannel: { kind: 'archive', locator: '/tmp/acme-sample.tgz' },
  }),
};

beforeEach(() => {
  daemon.ensureRunning.mockClear();
  daemon.requestChange.mockReset();
  daemon.decideChange.mockReset();
  daemon.confirm.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function readJsonLog(log: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n')) as Record<string, unknown>;
}

describe('plugins command daemon mutations', () => {
  it('keeps a headless archive review pending without fabricating approval', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handlePluginsCommand(['install', '/tmp/acme-sample.tgz', '--json']);

    expect(daemon.ensureRunning).toHaveBeenCalledTimes(1);
    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'installArchive', locator: '/tmp/acme-sample.tgz',
    });
    expect(daemon.confirm).not.toHaveBeenCalled();
    expect(daemon.decideChange).not.toHaveBeenCalled();
    expect(readJsonLog(log)).toMatchObject({
      ok: false,
      error: { code: 'review_required', pendingChangeId: 'pending-1' },
    });
  });

  it('keeps a non-JSON headless review pending without prompting', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await handlePluginsCommand(['install', '/tmp/acme-sample'], {
      isInteractiveTerminal: () => false,
    });

    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'installPath', locator: '/tmp/acme-sample', development: false,
    });
    expect(daemon.confirm).not.toHaveBeenCalled();
    expect(daemon.decideChange).not.toHaveBeenCalled();
  });

  it.each(['enable', 'disable', 'uninstall', 'rollback'] as const)(
    'routes %s through the daemon with no ad-hoc review or reload',
    async (kind) => {
      daemon.requestChange.mockResolvedValue({ kind: 'unavailable', code: 'daemon_response_lost' });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      await handlePluginsCommand([kind, 'acme.sample', '--json']);

      expect(daemon.requestChange).toHaveBeenCalledWith({ kind, pluginId: 'acme.sample' });
      expect(daemon.decideChange).not.toHaveBeenCalled();
      expect(readJsonLog(log)).toMatchObject({ ok: false, error: { code: 'outcome_unknown' } });
    },
  );

  it('renders the specific daemon failure message instead of collapsing it to a generic rejection', async () => {
    const message =
      'Storage-pressure quarantine eviction cleanup remains pending: reconciliation: generationCleanup unavailable';
    daemon.requestChange.mockResolvedValue({
      kind: 'failed',
      code: 'plugin_install_failed',
      message,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handlePluginsCommand(['install', '/tmp/acme-sample', '--json']);

    expect(readJsonLog(log)).toMatchObject({
      ok: false,
      error: {
        code: 'failed',
        message,
        causeCode: 'plugin_install_failed',
        causeMessage: message,
      },
    });
  });
});
