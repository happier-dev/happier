import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { buildActionExecuteResultFromRecordedApprovalExecution, createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionCliExecutionDeps } from '@/cli/actions/executeCommand';
import { executePluginDevLoopAction } from '@/plugins/devLoop/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';

const daemon = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => undefined),
  requestChange: vi.fn(),
  decideChange: vi.fn(),
  readStatus: vi.fn(),
  readCatalog: vi.fn(),
  listChanges: vi.fn(),
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
  readDaemonPluginCatalog: daemon.readCatalog,
  listDaemonPluginChanges: daemon.listChanges,
}));

vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({
  promptConfirmYesNo: daemon.confirm,
}));

import { handlePluginsCommand } from './plugins';

function authenticatedActionDeps(options: Readonly<{ approve?: boolean }> = {}): Partial<ActionCliExecutionDeps> {
  let storedRequest: Parameters<NonNullable<Parameters<typeof createActionExecutor>[0]['approvalsCreate']>>[0]['request'] | null = null;
  const executor = createActionExecutor({
    ...createUnavailableActionTransportDeps(),
    pluginsDevLoopAction: async (args) => await executePluginDevLoopAction(args),
    buildApprovalPreview: async ({ defaultPreview }) => ({
      ...defaultPreview,
      pluginInstall: {
        permissionsDisclosure: 'daemonEvaluated',
        pendingReview: reviewRequired,
      },
    }),
    approvalsCreate: async ({ request }) => {
      storedRequest = request;
      return { artifactId: 'plugins-command-approval' };
    },
    // The artifact store returns its persisted body through the canonical approval parser.
    approvalsGet: async () => storedRequest && ApprovalRequestV2Schema.parse(storedRequest),
    approvalsUpdate: async ({ request }) => {
      storedRequest = request;
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async () => true,
  });
  return {
    readCredentialsFn: async () => ({
      token: 'header.eyJzdWIiOiJhY2NvdW50In0.signature',
      encryption: null,
    }),
    getServerProfileFn: async () => ({
      id: 'cloud',
      name: 'Home',
      serverUrl: 'https://api.example.test',
      webappUrl: 'https://app.example.test',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    }),
    createExecutorFn: async () => ({
      execute: async (actionId, input, context) => {
        const result = await executor.execute(actionId, input, {
          ...context,
          authority: 'present_user',
          actionCaller: { kind: 'host' },
          runtimeAccountId: 'account',
          executionRunTargetMachineId: 'machine-1',
          serverId: 'cloud',
          serverIdentityId: 'server-identity-1',
        });
        if (options.approve === false || !result.ok) return result;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (!approval.success) return result;
        const decided = await executor.execute('approval.request.decide', {
          artifactId: approval.data.artifactId,
          decision: 'approve',
        }, {
          surface: 'ui',
          authority: 'present_user',
          actionCaller: { kind: 'host' },
          runtimeAccountId: 'account',
          serverId: 'cloud',
          serverIdentityId: 'server-identity-1',
        });
        if (!decided.ok || !decided.result || typeof decided.result !== 'object'
          || !('execution' in decided.result) || !decided.result.execution) return decided;
        if (!storedRequest) throw new Error('Expected the recorded approval request');
        const execution = buildActionExecuteResultFromRecordedApprovalExecution(storedRequest);
        if (!execution) throw new Error('Expected the recorded approval execution');
        return execution;
      },
      async resolveSessionTarget() {
        throw new Error('Unexpected Session target');
      },
    }),
  };
}

const reviewRequired = {
  kind: 'reviewRequired' as const,
  reviewKind: 'installation' as const,
  pendingChangeId: 'pending-1',
  reason: 'firstInstall' as const,
  currentVersion: null,
  authorityExpansion: [],
  review: createPluginInstallationReviewFixture({
    pluginId: 'acme.sample',
    displayName: 'Acme Sample',
    packageIdentity: { name: '@acme/sample', version: '1.0.0' },
    source: { kind: 'archive', locator: '/tmp/acme-sample.tgz', integrity: 'sha512-sample', integrityBasis: 'observed' },
    updateChannel: { kind: 'archive', locator: '/tmp/acme-sample.tgz' },
  }),
};

beforeEach(() => {
  daemon.ensureRunning.mockClear();
  daemon.requestChange.mockReset();
  daemon.decideChange.mockReset();
  daemon.readStatus.mockReset();
  daemon.readCatalog.mockReset();
  daemon.listChanges.mockReset();
  daemon.confirm.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('plugins command daemon mutations', () => {
  it('hands a development review to the ordinary install approval owner', async () => {
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['dev', '/tmp/acme-dev', '--sdk-registry', 'https://registry.example.test', '--json'], {
        ensureDaemon: async () => undefined,
        controlPluginDevelopment: async () => ({
          kind: 'failed', code: 'plugin_dev_reviewRequired',
          message: 'Plugin development preparation failed', status: { roots: [], plugins: [] },
        }),
        actionExecutionDeps: authenticatedActionDeps({ approve: false }),
      });
      expect(output.json()).toMatchObject({
        ok: true, kind: 'plugins_install',
        data: { kind: 'approval_request_created', artifactId: 'plugins-command-approval' },
      });
      expect(daemon.decideChange).not.toHaveBeenCalled();
    } finally { output.restore(); }
  });

  it.each(['enable', 'disable', 'rollback', 'update'] as const)('routes %s through Action approval before requesting a daemon change', async command => {
    daemon.requestChange.mockResolvedValue({ kind: 'committed', pluginId: 'acme.sample', desiredGeneration: null, appliedGeneration: null, pendingSurfaces: [] });
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand([command, 'acme.sample', '--json'], {
        isInteractiveTerminal: () => false,
        actionExecutionDeps: authenticatedActionDeps({ approve: false }),
      });
      expect(output.json()).toMatchObject({ ok: true, data: { kind: 'approval_request_created' } });
      expect(daemon.requestChange).not.toHaveBeenCalled();
      expect(daemon.confirm).not.toHaveBeenCalled();
      expect(daemon.decideChange).not.toHaveBeenCalled();
    } finally { output.restore(); }
  });

  it('enumerates outstanding plugin reviews with their daemon-issued ids', async () => {
    daemon.readCatalog.mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
    daemon.listChanges.mockResolvedValue({ kind: 'available', changes: [reviewRequired] });
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['list', '--json']);

      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_list',
        data: {
          plugins: [],
          pendingChanges: [reviewRequired],
        },
      });
    } finally {
      output.restore();
    }
  });

  it('rejects the retired generation filter rather than silently reading other occurrences', async () => {
    const resolvePluginInvocationLogTarget = vi.fn(async () => ({
      kind: 'unavailable' as const,
      code: 'machine_not_current',
      message: 'The selected machine is no longer active.',
    }));
    await expect(handlePluginsCommand(['logs', 'acme.example', '--generation', 'old-id'], {
      resolvePluginInvocationLogTarget,
    })).rejects.toThrow('Unknown option: --generation');
    expect(resolvePluginInvocationLogTarget).not.toHaveBeenCalled();
  });

  it('routes exact structured logs through the selected machine and stops following when cancelled', async () => {
    const controller = new AbortController();
    const target = {
      serverIdentityId: 'srv_example',
      serverLabel: 'https://api.example.test',
      serverUrl: 'https://api.example.test',
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
            occurrenceId: 'occurrence-1',
            correlationId: 'correlation-1',
            surface: 'cli' as const,
          },
          occurredAtMs: 1,
          sequence: 1,
        }],
        cursor: 64,
        hasMore: false,
        logId: 'log-1',
        cursorReset: false,
      };
    });
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand([
        'logs',
        'acme.example',
        '--machine=machine-2',
        '--occurrence', 'occurrence-1',
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
          occurrenceId: 'occurrence-1',
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
      serverUrl: 'https://api.example.test',
      machineId: 'machine-2',
      machineLabel: 'build-host',
    } as const;
    const emptyPage = {
      version: 1 as const,
      kind: 'available' as const,
      records: [],
      cursor: 64,
      hasMore: false,
      logId: 'log-1',
      cursorReset: false,
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
        request: { pluginId: 'acme.example', cursor: 64, logId: 'log-1' },
        waitForChanges: true,
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
      serverUrl: 'https://api.example.test',
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
      logId: 'log-1',
      cursorReset: false,
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
          serverUrl: 'https://api.example.test',
          machineId: 'machine-1',
          machineLabel: 'laptop',
        },
        {
          serverIdentityId: 'srv_example',
          serverLabel: 'https://api.example.test',
          serverUrl: 'https://api.example.test',
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
      serverUrl: 'https://api.example.test',
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
      serverUrl: 'https://api.example.test',
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
        occurrenceId: 'occurrence-1',
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
        logId: 'log-1',
        cursorReset: false,
      })
      .mockResolvedValueOnce({
        version: 1 as const,
        kind: 'available' as const,
        records: [record(101, 'later snapshot record')],
        cursor: 1_100,
        hasMore: false,
        logId: 'log-1',
        cursorReset: false,
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
      reviewKind: 'installation' as const,
      pendingChangeId: 'pending-1',
      reason: 'firstInstall' as const,
      currentVersion: null,
      authorityExpansion: [],
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
        data: { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'pending-1' },
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

  it('keeps a headless archive install in the Action approval Inbox without fabricating approval', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['install', '/tmp/acme-sample.tgz', '--json'], {
        actionExecutionDeps: authenticatedActionDeps({ approve: false }),
      });

      expect(daemon.ensureRunning).not.toHaveBeenCalled();
      expect(daemon.requestChange).not.toHaveBeenCalled();
      expect(daemon.confirm).not.toHaveBeenCalled();
      expect(daemon.decideChange).not.toHaveBeenCalled();
      expect(output.json()).toMatchObject({
        ok: true,
        kind: 'plugins_install',
        data: { kind: 'approval_request_created', artifactId: 'plugins-command-approval' },
      });
    } finally {
      output.restore();
    }
  });

  it('reports the daemon registry-profile requirement as a typed install failure', async () => {
    daemon.requestChange.mockResolvedValue({
      kind: 'registryProfileRequired',
      registryOrigin: 'https://registry.acme.test',
      packageName: '@acme/private-plugin',
      registryProfileId: 'registry-private',
    });
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['install', '@acme/private-plugin', '--kind', 'npm', '--json'], {
        actionExecutionDeps: authenticatedActionDeps(),
      });

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_install',
        error: {
          code: 'plugin_registry_profile_required',
          registryOrigin: 'https://registry.acme.test',
          packageName: '@acme/private-plugin',
          registryProfileId: 'registry-private',
        },
      });
    } finally {
      output.restore();
    }
  });

  it('keeps a non-JSON archive install in the Action approval Inbox without prompting or fabricating approval', async () => {
    daemon.requestChange.mockResolvedValue(reviewRequired);
    // Pending-review guidance names the invoking invoker; pin the documented
    // default lane instead of inheriting the test runner's argv-derived one.
    const envScope = createEnvKeyScope(['HAPPIER_CLI_INVOKER_NAME']);
    envScope.patch({ HAPPIER_CLI_INVOKER_NAME: 'happier' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await handlePluginsCommand(['install', '/tmp/acme-sample.tgz'], {
        isInteractiveTerminal: () => false,
        actionExecutionDeps: authenticatedActionDeps({ approve: false }),
      });

      expect(daemon.requestChange).not.toHaveBeenCalled();
      expect(daemon.confirm).not.toHaveBeenCalled();
      expect(daemon.decideChange).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join('\n')).toContain('approval requested: plugins-command-approval');
    } finally {
      envScope.restore();
    }
  });

  it('routes legacy install --dev directly through daemon development control without installation review', async () => {
    daemon.requestChange.mockResolvedValue({
      kind: 'committed',
      pluginId: 'acme.dev',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    });
    const installOutput = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['install', '/tmp/acme-dev', '--dev', '--json'], {
        actionExecutionDeps: authenticatedActionDeps(),
      });

      expect(installOutput.json()).toMatchObject({
        ok: true,
        kind: 'plugins_install',
        data: {
          outcome: 'applied',
          change: expect.objectContaining({ pluginId: 'acme.dev' }),
        },
      });
    } finally {
      installOutput.restore();
    }
    expect(daemon.ensureRunning).toHaveBeenCalledOnce();
    expect(daemon.requestChange).toHaveBeenCalledWith({
      kind: 'development',
      sourceRootPath: '/tmp/acme-dev',
    });
    expect(daemon.readStatus).not.toHaveBeenCalled();
    expect(daemon.decideChange).not.toHaveBeenCalled();
  });

  it('refuses the retired private pending-change decision command', async () => {
    daemon.readStatus.mockResolvedValue({
      kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
      pendingChangeId: 'pending-1',
      review: createPluginInstallationReviewFixture(),
    });
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['change', 'reject', 'pending-1', '--json']);

      expect(output.json()).toMatchObject({
        ok: false,
        kind: 'plugins_change_reject',
        error: { code: 'unknown_subcommand' },
      });
    } finally {
      output.restore();
    }

    expect(daemon.requestChange).not.toHaveBeenCalled();
    expect(daemon.decideChange).not.toHaveBeenCalled();
  });

  it.each([
    ['enable', [], 'enable'],
    ['disable', [], 'disable'],
    ['uninstall', [], 'uninstall'],
    ['uninstall', ['--delete-data', '--yes'], 'uninstallAndDeleteData'],
    ['rollback', [], 'rollback'],
    ['update', [], 'update'],
  ] as const)(
    'routes %s %j through the daemon with no ad-hoc review or reload',
    async (command, extraArgs, requestKind) => {
      // `daemon_unavailable` is the control client's real ambiguous transport
      // result. `daemon_response_lost` was never a produced error code.
      daemon.requestChange.mockResolvedValue({ kind: 'unavailable', code: 'daemon_unavailable' });
      const output = captureStdoutJsonOutput();
      try {
        await handlePluginsCommand([
          command,
          'acme.sample',
          ...extraArgs,
          '--json',
        ], { actionExecutionDeps: authenticatedActionDeps() });

        expect(daemon.requestChange).toHaveBeenCalledWith({
          kind: requestKind,
          pluginId: 'acme.sample',
        });
        expect(daemon.decideChange).not.toHaveBeenCalled();
        const envelope = output.json<{ data?: unknown }>();
        expect(envelope).toMatchObject({
          ok: false,
          kind: `plugins_${command}`,
          error: { code: 'outcome_unknown' },
        });
        expect(envelope.data).toBeUndefined();
      } finally {
        output.restore();
      }
    },
  );

  it.each([
    { code: 'plugin_install_failed', message: 'Storage-pressure quarantine eviction cleanup remains pending: reconciliation: generationCleanup unavailable' },
    { code: 'PLUGIN_SETTINGS_DEFAULT_INVALID', message: "Plugin 'acme.sample' Settings 'preferences' field 'enabled': PLUGIN_SETTINGS_DEFAULT_INVALID" },
  ])('renders the specific daemon failure in public JSON ($code)', async ({ code, message }) => {
    daemon.requestChange.mockResolvedValue({
      kind: 'failed',
      code,
      message,
    });
    const output = captureStdoutJsonOutput();
    try {
      await handlePluginsCommand(['install', '/tmp/acme-sample.tgz', '--json'], {
        actionExecutionDeps: authenticatedActionDeps(),
      });

      expect(output.json()).toMatchObject({
        ok: false,
        error: {
          code: 'failed',
          message,
          causeCode: code,
          causeMessage: message,
        },
      });
    } finally {
      output.restore();
    }
  });
});
