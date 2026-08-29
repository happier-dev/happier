import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const daemon = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => undefined),
  requestChange: vi.fn(),
  decideChange: vi.fn(),
  readStatus: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemon', () => ({
  ensureDaemonRunningForSessionCommand: daemon.ensureRunning,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: daemon.requestChange,
  decideDaemonPluginChange: daemon.decideChange,
  readDaemonPluginChangeStatus: daemon.readStatus,
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
  daemon.readStatus.mockReset();
  daemon.confirm.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('plugins command daemon mutations', () => {
  it('routes exact structured logs through the selected machine and stops follow polling when cancelled', async () => {
    const controller = new AbortController();
    const target = {
      serverIdentityId: 'srv_example',
      serverLabel: 'https://api.example.test',
      machineId: 'machine-2',
      machineLabel: 'build-host',
    } as const;
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({
      kind: 'selected' as const,
      target,
    }));
    const readPluginInvocationLogsOnMachine = vi.fn(async () => {
      controller.abort();
      return {
        version: 1 as const,
        kind: 'available' as const,
        records: [{
          version: 1 as const,
          kind: 'plugin_invocation_log' as const,
          level: 'info' as const,
          message: 'redacted output',
          fields: { apiKey: '[REDACTED]' },
          context: {
            plugin: { id: 'acme.example', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'acme.example/run' },
            generation: 'generation-1',
            correlationId: 'correlation-1',
            surface: 'cli' as const,
          },
          occurredAtMs: 1,
          sequence: 1,
        }],
        cursor: 64,
        hasMore: false,
      };
    });
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand([
        'logs',
        'acme.example',
        '--machine=machine-2',
        '--generation', 'generation-1',
        '--correlation', 'correlation-1',
        '--follow',
        '--json',
      ], {
        resolvePluginInvocationLogTarget,
        readPluginInvocationLogsOnMachine,
      }, {
        signal: controller.signal,
      });

      expect(resolvePluginInvocationLogTarget).toHaveBeenCalledWith({
        requestedMachineId: 'machine-2',
        signal: controller.signal,
      });
      expect(readPluginInvocationLogsOnMachine).toHaveBeenCalledTimes(1);
      expect(readPluginInvocationLogsOnMachine).toHaveBeenCalledWith({
        target,
        request: {
          pluginId: 'acme.example',
          generation: 'generation-1',
          correlationId: 'correlation-1',
        },
        signal: controller.signal,
      });
      expect(daemon.requestChange).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_logs',
        data: {
          target,
          records: [{
            fields: { apiKey: '[REDACTED]' },
            context: { correlationId: 'correlation-1' },
          }],
        },
      });
    } finally {
      output.restore();
    }
  });

  it('prints an initial empty follow page once and suppresses an unchanged idle page', async () => {
    const controller = new AbortController();
    const target = {
      serverIdentityId: 'srv_example',
      serverLabel: 'https://api.example.test',
      machineId: 'machine-2',
      machineLabel: 'build-host',
    } as const;
    const emptyPage = {
      version: 1 as const,
      kind: 'available' as const,
      records: [],
      cursor: 64,
      hasMore: false,
    };
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({ kind: 'selected' as const, target }));
    const readPluginInvocationLogsOnMachine = vi.fn()
      .mockResolvedValueOnce(emptyPage)
      .mockImplementationOnce(async () => {
        controller.abort();
        return emptyPage;
      });
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand([
        'logs',
        'acme.example',
        '--machine', 'machine-2',
        '--follow',
        '--json',
      ], {
        resolvePluginInvocationLogTarget,
        readPluginInvocationLogsOnMachine,
      }, {
        signal: controller.signal,
      });

      expect(readPluginInvocationLogsOnMachine).toHaveBeenCalledTimes(2);
      expect(readPluginInvocationLogsOnMachine).toHaveBeenNthCalledWith(1, {
        target,
        request: { pluginId: 'acme.example' },
        signal: controller.signal,
      });
      expect(readPluginInvocationLogsOnMachine).toHaveBeenNthCalledWith(2, {
        target,
        request: { pluginId: 'acme.example', cursor: 64 },
        signal: controller.signal,
      });
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_logs',
        data: {
          target,
          records: [],
          cursor: 64,
          hasMore: false,
        },
      });
    } finally {
      output.restore();
    }
  });

  it('keeps a non-follow empty log response visible to human callers', async () => {
    const target = {
      serverIdentityId: 'srv_example',
      serverLabel: 'https://api.example.test',
      machineId: 'machine-2',
      machineLabel: 'build-host',
    } as const;
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({ kind: 'selected' as const, target }));
    const readPluginInvocationLogsOnMachine = vi.fn(async () => ({
      version: 1 as const,
      kind: 'available' as const,
      records: [],
      cursor: 64,
      hasMore: false,
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handlePluginsCommand(['logs', 'acme.example', '--machine', 'machine-2'], {
      resolvePluginInvocationLogTarget,
      readPluginInvocationLogsOnMachine,
    });

    expect(readPluginInvocationLogsOnMachine).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('No matching plugin logs.');
  });

  it('requires an explicit machine when multiple current machines can own plugin logs', async () => {
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({
      kind: 'selection_required' as const,
      candidates: [
        {
          serverIdentityId: 'srv_example',
          serverLabel: 'https://api.example.test',
          machineId: 'machine-1',
          machineLabel: 'laptop',
        },
        {
          serverIdentityId: 'srv_example',
          serverLabel: 'https://api.example.test',
          machineId: 'machine-2',
          machineLabel: 'build-host',
        },
      ],
    }));
    const readPluginInvocationLogsOnMachine = vi.fn();
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['logs', 'acme.example', '--json'], {
        resolvePluginInvocationLogTarget,
        readPluginInvocationLogsOnMachine,
      });

      expect(readPluginInvocationLogsOnMachine).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_logs',
        error: {
          code: 'machine_selection_required',
          candidates: [
            { machineId: 'machine-1', machineLabel: 'laptop' },
            { machineId: 'machine-2', machineLabel: 'build-host' },
          ],
        },
      });
    } finally {
      output.restore();
    }
  });

  it('refuses a stale exact machine before reading any daemon log path', async () => {
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({
      kind: 'unavailable' as const,
      code: 'machine_not_current',
      message: 'The selected machine is no longer active.',
    }));
    const readPluginInvocationLogsOnMachine = vi.fn();
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['logs', 'acme.example', '--machine', 'machine-stale', '--json'], {
        resolvePluginInvocationLogTarget,
        readPluginInvocationLogsOnMachine,
      });

      expect(readPluginInvocationLogsOnMachine).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_logs',
        error: { code: 'machine_not_current' },
      });
    } finally {
      output.restore();
    }
  });

  it('reports an old target daemon as unavailable without falling back to a local reader', async () => {
    const target = {
      serverIdentityId: 'srv_example',
      serverLabel: 'https://api.example.test',
      machineId: 'machine-2',
      machineLabel: 'build-host',
    } as const;
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({ kind: 'selected' as const, target }));
    const readPluginInvocationLogsOnMachine = vi.fn(async () => ({
      kind: 'unavailable' as const,
      code: 'daemon_plugin_log_read_unsupported',
    }));
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['logs', 'acme.example', '--machine', 'machine-2', '--json'], {
        resolvePluginInvocationLogTarget,
        readPluginInvocationLogsOnMachine,
      });

      expect(readPluginInvocationLogsOnMachine).toHaveBeenCalledTimes(1);
      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_logs',
        error: { code: 'daemon_plugin_log_read_unsupported' },
      });
    } finally {
      output.restore();
    }
  });

  it('keeps later log pages reachable through an explicit bounded cursor continuation', async () => {
    const target = {
      serverIdentityId: 'srv_example',
      serverLabel: 'https://api.example.test',
      machineId: 'machine-2',
      machineLabel: 'build-host',
    } as const;
    const record = (sequence: number, message: string) => ({
      version: 1 as const,
      kind: 'plugin_invocation_log' as const,
      level: 'info' as const,
      message,
      context: {
        plugin: { id: 'acme.example', version: '1.0.0' },
        contribution: { id: 'run', qualifiedId: 'acme.example/run' },
        generation: 'generation-1',
        correlationId: 'correlation-1',
        surface: 'cli' as const,
      },
      occurredAtMs: sequence,
      sequence,
    });
    const firstPage = Array.from({ length: 100 }, (_value, index) => record(index + 1, `snapshot-${index + 1}`));
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({ kind: 'selected' as const, target }));
    const readPluginInvocationLogsOnMachine = vi.fn()
      .mockResolvedValueOnce({
        version: 1 as const,
        kind: 'available' as const,
        records: firstPage,
        cursor: 1_000,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        version: 1 as const,
        kind: 'available' as const,
        records: [record(101, 'later snapshot record')],
        cursor: 1_100,
        hasMore: false,
      });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handlePluginsCommand(['logs', 'acme.example', '--machine', 'machine-2'], {
      resolvePluginInvocationLogTarget,
      readPluginInvocationLogsOnMachine,
    });

    expect(readPluginInvocationLogsOnMachine).toHaveBeenNthCalledWith(1, {
      target,
      request: { pluginId: 'acme.example' },
    });
    expect(log.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'More log data is available. Continue with --cursor 1000.',
    );

    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand([
        'logs', 'acme.example', '--machine', 'machine-2', '--cursor', '1000', '--limit', '10', '--json',
      ], {
        resolvePluginInvocationLogTarget,
        readPluginInvocationLogsOnMachine,
      });

      expect(readPluginInvocationLogsOnMachine).toHaveBeenNthCalledWith(2, {
        target,
        request: { pluginId: 'acme.example', cursor: 1_000, limit: 10 },
      });
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_logs',
        data: {
          cursor: 1_100,
          hasMore: false,
          records: [{ message: 'later snapshot record' }],
        },
      });
    } finally {
      output.restore();
    }
  });

  it('rejoins a pending daemon change by id without sending another mutation', async () => {
    const readPluginChangeStatus = vi.fn(async () => ({
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-1',
      review: createPluginInstallationReviewFixture(),
    }));
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['change', 'status', 'pending-1', '--json'], {
        readPluginChangeStatus,
      });

      expect(readPluginChangeStatus).toHaveBeenCalledWith({ pendingChangeId: 'pending-1' });
      expect(daemon.requestChange).not.toHaveBeenCalled();
      expect(daemon.decideChange).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_change_status',
        data: { kind: 'reviewRequired', pendingChangeId: 'pending-1' },
      });
    } finally {
      output.restore();
    }
  });

  it('forwards command cancellation only to the read-only status request', async () => {
    const controller = new AbortController();
    const readPluginChangeStatus = vi.fn(async () => ({ kind: 'expired' as const }));
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['change', 'status', 'pending-1', '--json'], {
        readPluginChangeStatus,
      }, {
        signal: controller.signal,
      });

      expect(readPluginChangeStatus).toHaveBeenCalledWith({
        pendingChangeId: 'pending-1',
        signal: controller.signal,
      });
      expect(daemon.requestChange).not.toHaveBeenCalled();
      expect(daemon.decideChange).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_change_status',
        data: { kind: 'expired' },
      });
    } finally {
      output.restore();
    }
  });

  it('keeps a headless archive review pending without fabricating approval', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['install', '/tmp/acme-sample.tgz', '--json']);

      expect(daemon.ensureRunning).toHaveBeenCalledTimes(1);
      expect(daemon.requestChange).toHaveBeenCalledWith({
        kind: 'installArchive', locator: '/tmp/acme-sample.tgz',
      });
      expect(daemon.confirm).not.toHaveBeenCalled();
      expect(daemon.decideChange).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: false,
        error: { code: 'review_required', pendingChangeId: 'pending-1' },
      });
    } finally {
      output.restore();
    }
  });

  it('keeps a non-JSON headless review pending without prompting', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    // Pending-review guidance names the invoking invoker; pin the documented
    // default lane instead of inheriting the test runner's argv-derived one.
    const envScope = createEnvKeyScope(['HAPPIER_CLI_INVOKER_NAME']);
    envScope.patch({ HAPPIER_CLI_INVOKER_NAME: 'happier' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await handlePluginsCommand(['install', '/tmp/acme-sample'], {
        isInteractiveTerminal: () => false,
      });

      expect(daemon.requestChange).toHaveBeenCalledWith({
        kind: 'installPath', locator: '/tmp/acme-sample', development: false,
      });
      expect(daemon.confirm).not.toHaveBeenCalled();
      expect(daemon.decideChange).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().join('\n')).toContain('happier plugins change status pending-1');
      expect(error.mock.calls.flat().join('\n')).toContain('happier plugins change approve pending-1');
      expect(error.mock.calls.flat().join('\n')).toContain('happier plugins change reject pending-1');
    } finally {
      envScope.restore();
    }
  });

  it('keeps a first dev install pending, then completes its two present-user decisions by the same id', async () => {
    const sourceRootReview = {
      kind: 'sourceRootReviewRequired' as const,
      pendingChangeId: 'pending-dev-1',
      review: { source: { kind: 'path' as const, locator: '/tmp/acme-dev' } },
    };
    const packageReview = {
      kind: 'reviewRequired' as const,
      pendingChangeId: 'pending-dev-1',
      review: createPluginInstallationReviewFixture({
        pluginId: 'acme.dev',
        displayName: 'Acme Dev',
        source: { kind: 'path', locator: '/tmp/acme-dev' },
        updateChannel: { kind: 'path', locator: '/tmp/acme-dev', development: true },
      }),
    };
    daemon.requestChange.mockResolvedValue(sourceRootReview);
    daemon.readStatus
      .mockResolvedValueOnce(sourceRootReview)
      .mockResolvedValueOnce(packageReview);
    daemon.decideChange
      .mockResolvedValueOnce(packageReview)
      .mockResolvedValueOnce({
        kind: 'committed',
        pluginId: 'acme.dev',
        desiredGeneration: 'generation-dev-1',
        appliedGeneration: 'generation-dev-1',
        pendingSurfaces: [],
      });
    const installOutput = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['install', '/tmp/acme-dev', '--dev', '--json']);

      expect(installOutput.json()).toMatchObject({
        ok: false,
        kind: 'plugins_install',
        error: {
          code: 'source_root_review_required',
          pendingChangeId: 'pending-dev-1',
        },
      });
    } finally {
      installOutput.restore();
    }
    expect(daemon.decideChange).not.toHaveBeenCalled();

    process.exitCode = undefined;
    const sourceRootDecisionOutput = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['change', 'approve', 'pending-dev-1', '--json']);

      expect(sourceRootDecisionOutput.json()).toMatchObject({
        ok: false,
        kind: 'plugins_change_decision',
        error: {
          code: 'review_required',
          outcome: 'reviewRequired',
          pendingChangeId: 'pending-dev-1',
        },
      });
    } finally {
      sourceRootDecisionOutput.restore();
    }
    expect(daemon.readStatus).toHaveBeenCalledWith({ pendingChangeId: 'pending-dev-1' });
    expect(daemon.decideChange).toHaveBeenNthCalledWith(1, expect.objectContaining({
      pendingChangeId: 'pending-dev-1',
      decision: 'trustSourceRoot',
      actorEvidence: expect.objectContaining({ kind: 'authenticatedLocalUser' }),
    }));

    process.exitCode = undefined;
    const packageDecisionOutput = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['change', 'approve', 'pending-dev-1', '--json']);

      expect(packageDecisionOutput.json()).toMatchObject({
        ok: true,
        kind: 'plugins_change_decision',
        data: {
          outcome: 'applied',
          pendingChangeId: 'pending-dev-1',
          result: {
            kind: 'committed',
            pluginId: 'acme.dev',
          },
        },
      });
    } finally {
      packageDecisionOutput.restore();
    }
    expect(daemon.decideChange).toHaveBeenNthCalledWith(2, expect.objectContaining({
      pendingChangeId: 'pending-dev-1',
      decision: 'installAndTrust',
      actorEvidence: expect.objectContaining({ kind: 'authenticatedLocalUser' }),
      optionalSelections: [],
    }));
  });

  it('rejects a pending change explicitly by id without minting approval evidence', async () => {
    daemon.readStatus.mockResolvedValue({
      kind: 'reviewRequired',
      pendingChangeId: 'pending-1',
      review: createPluginInstallationReviewFixture(),
    });
    daemon.decideChange.mockResolvedValue({ kind: 'cancelled' });
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['change', 'reject', 'pending-1', '--json']);

      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_change_decision',
        data: {
          outcome: 'rejected',
          pendingChangeId: 'pending-1',
          result: { kind: 'cancelled' },
        },
      });
    } finally {
      output.restore();
    }

    expect(daemon.requestChange).not.toHaveBeenCalled();
    expect(daemon.decideChange).toHaveBeenCalledWith({
      pendingChangeId: 'pending-1',
      decision: 'cancel',
    });
  });

  it.each(['enable', 'disable', 'uninstall', 'rollback'] as const)(
    'routes %s through the daemon with no ad-hoc review or reload',
    async (kind) => {
      // `daemon_unavailable` is the control client's real ambiguous transport
      // result. `daemon_response_lost` was never a produced error code.
      daemon.requestChange.mockResolvedValue({ kind: 'unavailable', code: 'daemon_unavailable' });
      const output = captureStdoutJsonOutput();
      try {
        await handlePluginsCommand([kind, 'acme.sample', '--json']);

        expect(daemon.requestChange).toHaveBeenCalledWith({ kind, pluginId: 'acme.sample' });
        expect(daemon.decideChange).not.toHaveBeenCalled();
        expect(output.json()).toMatchObject({ ok: false, error: { code: 'outcome_unknown' } });
      } finally {
        output.restore();
      }
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
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['install', '/tmp/acme-sample', '--json']);

      expect(output.json()).toMatchObject({
        ok: false,
        error: {
          code: 'failed',
          message,
          causeCode: 'plugin_install_failed',
          causeMessage: message,
        },
      });
    } finally {
      output.restore();
    }
  });
});
