import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

function createDeps() {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    pluginSessionHookManagementAction: vi.fn(async () => ({ ok: true, rows: [], nextCursor: null, diagnostics: [] })),
  };
}

describe('createActionExecutor (plugin session hooks)', () => {
  it.each(['install', 'disable', 'enable', 'uninstall'] as const)('admits UI %s through configurable shared approval', async operation => {
    const actionId = `plugins.sessionHooks.${operation}` as const;
    const transport = vi.fn(async () => ({ ok: true, status: operation === 'uninstall'
      ? { state: 'not_installed' } : { state: 'installed_enabled', installationId: 'installation-one' } }));
    const confirm = vi.fn(async () => false);
    const executor = createActionExecutor({ ...createDeps(), pluginSessionHookManagementAction: transport,
      presentUserActionConfirmation: confirm } as unknown as ActionExecutorDeps);
    const input = { agent: { pluginId: 'author.example', localId: 'codex' }, ...(operation === 'install'
      ? { expectedPreviewId: `hook-install-preview:v1:${'a'.repeat(64)}` }
      : { installationId: 'installation-one' }) };
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'server-one', runtimeAccountId: 'account-one', externalActionTarget: { kind: 'machine', machineId: 'machine-one' } } as const;
    const defaultResult = await executor.execute(actionId, input, context);
    if (operation === 'install' || operation === 'uninstall') {
      expect(defaultResult).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
      expect(transport).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledTimes(1);
    } else {
      expect(defaultResult).toMatchObject({ ok: true, result: { ok: true } });
      expect(confirm).not.toHaveBeenCalled();
    }
    const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } });
    expect(await executor.execute(actionId, input, { ...context, actionsSettings: waived }))
      .toMatchObject({ ok: true, result: { ok: true } });
    const writes = transport.mock.calls.length;
    const ask = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } });
    // This isolated host deliberately has no approval store. Explicit Ask must
    // refuse before native effects; the rendered UI suite proves real custody.
    expect(await executor.execute(actionId, input, { ...context, actionsSettings: ask }))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(transport).toHaveBeenCalledTimes(writes);
  });
  it.each(['agent', 'mcp', 'cli'] as const)('PARITY2 reads hook inventory on %s without approval or plugin identity binding', async (surface) => {
    const deps = createDeps();
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    const input = { intent: 'install_preview', agent: { pluginId: 'author.example', localId: 'codex' } } as const;
    await expect(executor.execute('plugins.sessionHooks.status.get', input, { surface, authority: 'account_automation' }))
      .resolves.toEqual({ ok: true, result: { ok: true, rows: [], nextCursor: null, diagnostics: [] } });
    expect(deps.pluginSessionHookManagementAction).toHaveBeenCalledWith({ actionId: 'plugins.sessionHooks.status.get', input });
  });

  it('binds the caller plugin identity and routes through the canonical management dependency', async () => {
    const deps = createDeps();
    const signal = new AbortController().signal;
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);

    const result = await executor.execute('plugins.sessionHooks.status.get', {
      intent: 'install_preview',
      agent: { localId: 'codex' },
    }, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'author.example' },
      signal,
      bypassApprovals: true,
    });

    expect(result.ok).toBe(true);
    expect(deps.pluginSessionHookManagementAction).toHaveBeenCalledWith({
      actionId: 'plugins.sessionHooks.status.get',
      input: {
        intent: 'install_preview',
        agent: { pluginId: 'author.example', localId: 'codex' },
      },
      signal,
    });
  });
});
