import { describe, expect, it, vi } from 'vitest';

import {
  PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT,
  createFeatureDecision,
  type FeatureDecision,
  type PluginSessionHookInstallInputV1,
  type PluginSessionHookInstallResponseV1,
  type PluginSessionHookInstallationMutationInputV1,
  type PluginSessionHookInstallationStatusV1,
  type PluginSessionHookStatusInputV1,
  type PluginSessionHookStatusInventoryDiagnosticV1,
  type PluginSessionHookStatusResponseV1,
  type PluginSessionHookToggleResponseV1,
  type PluginSessionHookUninstallResponseV1,
} from '@happier-dev/protocol';

import {
  createPluginSessionHookManagementActionExecutor,
  type PluginSessionHookManagementHost,
} from './pluginSessionHookManagementActionExecutor';

const target = {
  machineId: 'machine-1',
  agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
} as const;
const installTarget = {
  ...target,
  expectedPreviewId: `hook-install-preview:v1:${'1'.repeat(64)}`,
} as const;
const statusQuery = {
  machineId: target.machineId,
  intent: 'passive_inventory',
  agent: target.agent,
  limit: PLUGIN_SESSION_HOOK_STATUS_INVENTORY_DEFAULT_LIMIT,
} as const;
const installPreview = {
  previewId: installTarget.expectedPreviewId,
  targets: [{
    targetId: 'settings',
    absolutePath: '/tmp/settings.json',
    changes: [{
      kind: 'append_json_array_entry',
      collectionId: 'hooks',
      eventId: 'session-start',
      nativeEventName: 'SessionStart',
      entry: {
        matcher: null,
        hooks: [{
          type: 'command',
          command: '/opt/happier hook',
          timeout: 1,
        }],
      },
    }],
  }],
} as const;

type InventoryStatusFixture =
  | PluginSessionHookInstallationStatusV1
  | Readonly<{ state: 'not_installed' }>;

function featureDecision(
  state: 'enabled' | 'disabled',
  featureId: FeatureDecision['featureId'] = 'sessions.direct',
): FeatureDecision {
  return createFeatureDecision({
    featureId,
    state,
    blockedBy: state === 'enabled' ? null : 'server',
    blockerCode: state === 'enabled' ? 'none' : 'feature_disabled',
    diagnostics: [],
    evaluatedAt: 1,
    scope: { scopeKind: 'runtime', machineId: 'machine-1' },
  });
}

function inventory(
  statuses: readonly InventoryStatusFixture[],
  options: Readonly<{
    nextCursor?: string | null;
    diagnostics?: PluginSessionHookStatusInventoryDiagnosticV1[];
  }> = {},
): PluginSessionHookStatusResponseV1 {
  return {
    ok: true,
    rows: statuses.map((status) => ({
      agent: target.agent,
      status: status.state === 'not_installed' && !('installPreview' in status)
        ? { ...status, installPreview }
        : status,
    })),
    nextCursor: options.nextCursor ?? null,
    diagnostics: options.diagnostics ?? [],
  };
}

type HostCall =
  | Readonly<{ operation: 'status'; input: PluginSessionHookStatusInputV1 }>
  | Readonly<{ operation: 'install'; input: PluginSessionHookInstallInputV1 }>
  | Readonly<{
      operation: 'disable' | 'enable' | 'uninstall';
      input: PluginSessionHookInstallationMutationInputV1;
    }>;

function createHost(
  initialStatus: PluginSessionHookStatusResponseV1,
  overrides: Partial<PluginSessionHookManagementHost> = {},
): PluginSessionHookManagementHost & Readonly<{ calls: HostCall[] }> {
  let current = initialStatus;
  const calls: HostCall[] = [];
  return {
    calls,
    async status(input) {
      calls.push({ operation: 'status', input });
      return current;
    },
    async install(input) {
      calls.push({ operation: 'install', input });
      const response: PluginSessionHookInstallResponseV1 = {
        ok: true,
        status: {
          state: 'installed_enabled',
          installationId: 'installation-1',
        },
      };
      current = inventory([response.status]);
      return response;
    },
    async disable(input) {
      calls.push({ operation: 'disable', input });
      const response: PluginSessionHookToggleResponseV1 = {
        ok: true,
        status: {
          state: 'installed_disabled',
          installationId: input.installationId,
        },
      };
      current = inventory([response.status]);
      return response;
    },
    async enable(input) {
      calls.push({ operation: 'enable', input });
      const response: PluginSessionHookToggleResponseV1 = {
        ok: true,
        status: {
          state: 'installed_enabled',
          installationId: input.installationId,
        },
      };
      current = inventory([response.status]);
      return response;
    },
    async uninstall(input) {
      calls.push({ operation: 'uninstall', input });
      const response: PluginSessionHookUninstallResponseV1 = {
        ok: true,
        status: { state: 'not_installed' },
      };
      current = inventory([response.status]);
      return response;
    },
    ...overrides,
  };
}

function createExecutor(host: PluginSessionHookManagementHost) {
  return createPluginSessionHookManagementActionExecutor({
    machineId: 'machine-1',
    readFeatureDecision: () => featureDecision('enabled'),
    host,
  });
}

describe('plugin session-hook management ActionSpec executor', () => {
  it.each([
    { machineId: 'machine-1' },
    { machineId: 'machine-1', intent: 'unknown' },
    { machineId: 'machine-1', intent: 'explicit_recheck' },
    { machineId: 'machine-1', intent: 'install_preview' },
    {
      machineId: 'machine-1',
      intent: 'install_preview',
      agent: target.agent,
      limit: 1,
    },
    {
      machineId: 'machine-1',
      intent: 'installation_recheck',
      agent: target.agent,
    },
    {
      machineId: 'machine-1',
      intent: 'installation_recheck',
      agent: target.agent,
      installationId: 'installation-1',
      cursor: 'not-allowed',
    },
  ])('rejects a malformed status intent before host effects', async (input) => {
    const host = createHost(inventory([]));

    await expect(createExecutor(host).execute(
      'plugins.sessionHooks.status.get',
      input,
    )).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'invalid_request',
    });
    expect(host.calls).toEqual([]);
  });

  it.each([
    featureDecision('disabled'),
    featureDecision('enabled', 'pets.sync'),
  ])('fails closed before status unless given an enabled sessions.direct decision', async (
    decision,
  ) => {
    const host = createHost(inventory([]));
    const executor = createPluginSessionHookManagementActionExecutor({
      machineId: 'machine-1',
      readFeatureDecision: () => decision,
      host,
    });

    await expect(executor.execute(
      'plugins.sessionHooks.status.get',
      { ...target, intent: 'passive_inventory' },
    )).resolves.toEqual({
      ok: true,
      result: {
        ok: false,
        diagnostic: { code: 'feature_disabled', retryable: false },
      },
    });
    expect(host.calls).toEqual([]);
  });

  it('re-evaluates the caller-owned feature decision for every execution', async () => {
    const host = createHost(inventory([]));
    let decision = featureDecision('enabled');
    const executor = createPluginSessionHookManagementActionExecutor({
      machineId: 'machine-1',
      readFeatureDecision: () => decision,
      host,
    });

    await expect(executor.execute(
      'plugins.sessionHooks.status.get',
      { ...target, intent: 'passive_inventory' },
    )).resolves.toMatchObject({ ok: true, result: { ok: true, rows: [] } });

    decision = featureDecision('disabled');
    await expect(executor.execute(
      'plugins.sessionHooks.status.get',
      { ...target, intent: 'passive_inventory' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        ok: false,
        diagnostic: { code: 'feature_disabled', retryable: false },
      },
    });
    expect(host.calls).toEqual([{ operation: 'status', input: statusQuery }]);
  });

  it('rejects a mismatched machine before reading or mutating host state', async () => {
    const host = createHost(inventory([]));

    await expect(createExecutor(host).execute(
      'plugins.sessionHooks.install',
      { ...installTarget, machineId: 'machine-2' },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        ok: false,
        diagnostic: { code: 'permission_denied', retryable: false },
      },
    });
    expect(host.calls).toEqual([]);
  });

  it('returns status inventory unchanged and keeps the read passive', async () => {
    const current: PluginSessionHookStatusResponseV1 = {
      ok: true,
      rows: [{
        agent: target.agent,
        status: {
          state: 'installed_disabled',
          installationId: 'installation-1',
        },
      }],
      nextCursor: 'next-page',
      diagnostics: [{
        code: 'installation_record_read_failed',
        retryable: true,
      }],
    };
    const host = createHost(current);

    await expect(createExecutor(host).execute(
      'plugins.sessionHooks.status.get',
      { ...target, intent: 'passive_inventory' },
    )).resolves.toEqual({ ok: true, result: current });
    expect(host.calls).toEqual([{ operation: 'status', input: statusQuery }]);
  });

  it.each([
    {
      actionId: 'plugins.sessionHooks.install' as const,
      initial: inventory([{ state: 'not_installed' }]),
      input: installTarget,
      mutation: 'install' as const,
    },
    {
      actionId: 'plugins.sessionHooks.disable' as const,
      initial: inventory([{
        state: 'installed_enabled',
        installationId: 'installation-1',
      }]),
      input: { ...target, installationId: 'installation-1' },
      mutation: 'disable' as const,
    },
    {
      actionId: 'plugins.sessionHooks.enable' as const,
      initial: inventory([{
        state: 'installed_disabled',
        installationId: 'installation-1',
      }]),
      input: { ...target, installationId: 'installation-1' },
      mutation: 'enable' as const,
    },
    {
      actionId: 'plugins.sessionHooks.uninstall' as const,
      initial: inventory([{
        state: 'needs_attention',
        installationId: 'installation-1',
        diagnostic: {
          code: 'current_contribution_unavailable',
          severity: 'warning',
          remediation: { kind: 'retry' },
        },
      }]),
      input: { ...target, installationId: 'installation-1' },
      mutation: 'uninstall' as const,
    },
    {
      actionId: 'plugins.sessionHooks.uninstall' as const,
      initial: inventory([{
        state: 'unavailable',
        installationId: 'installation-1',
      }]),
      input: { ...target, installationId: 'installation-1' },
      mutation: 'uninstall' as const,
    },
  ])('admits the inventory-valid $actionId transition', async ({
    actionId,
    initial,
    input,
    mutation,
  }) => {
    const host = createHost(initial);
    const executeResult = await createExecutor(host).execute(actionId, input);

    expect(executeResult).toMatchObject({ ok: true, result: { ok: true } });
    expect(host.calls).toEqual([{ operation: mutation, input }]);
  });

  it.each([
    'plugins.sessionHooks.disable',
    'plugins.sessionHooks.uninstall',
  ] as const)('lets %s reach the locked host while the inventory reports a diagnostic', async (
    actionId,
  ) => {
    // An unreadable NEIGHBOURING installation record is exactly when a user most
    // needs to disable or remove the one they can see. A page-level diagnostic
    // describes other rows; it must not veto a mutation the locked custody owner
    // can complete.
    const host = createHost(inventory(
      [{ state: 'installed_enabled', installationId: 'installation-1' }],
      { diagnostics: [{ code: 'installation_record_read_failed', retryable: true }] },
    ));
    const input = { ...target, installationId: 'installation-1' } as const;

    await expect(createExecutor(host).execute(actionId, input))
      .resolves.toMatchObject({ ok: true, result: { ok: true } });
    expect(host.calls).toEqual([{
      operation: actionId === 'plugins.sessionHooks.disable' ? 'disable' : 'uninstall',
      input,
    }]);
  });

  it.each([
    'plugins.sessionHooks.disable',
    'plugins.sessionHooks.enable',
    'plugins.sessionHooks.uninstall',
  ] as const)(
    'forwards the locked host refusal for %s without adding a second verdict',
    async (actionId) => {
      // The host resolves the durable custody record under the per-installation
      // mutation lock, so a stale or already-replaced identity is ITS answer.
      // The executor must relay it, not pre-empt it from an unlocked read.
      const refuse = vi.fn(async () => ({
        ok: false as const,
        diagnostic: { code: 'installation_replaced' as const, retryable: false },
      }));
      const host = createHost(
        inventory([{ state: 'installed_enabled', installationId: 'installation-current' }]),
        { disable: refuse, enable: refuse, uninstall: refuse },
      );
      const input = { ...target, installationId: 'installation-stale' } as const;

      await expect(createExecutor(host).execute(actionId, input)).resolves.toMatchObject({
        ok: true,
        result: {
          ok: false,
          diagnostic: { code: 'installation_replaced', retryable: false },
        },
      });
      expect(refuse).toHaveBeenCalledWith(input);
      expect(host.calls.some((call) => call.operation === 'status')).toBe(false);
    },
  );

  it('maps thrown host failures to a privacy-safe retryable diagnostic', async () => {
    const host = createHost(inventory([{ state: 'not_installed' }]), {
      install: vi.fn(async () => {
        throw new Error('secret token=/private/config payload={...}');
      }),
    });

    const executeResult = await createExecutor(host).execute(
      'plugins.sessionHooks.install',
      installTarget,
    );
    expect(executeResult).toEqual({
      ok: true,
      result: {
        ok: false,
        diagnostic: { code: 'operation_failed', retryable: true },
      },
    });
    expect(JSON.stringify(executeResult)).not.toMatch(/secret|token=|private|payload/u);
  });
});
