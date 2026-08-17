import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

describe('createActionExecutor (plugin Settings administration)', () => {
  it('routes validated scope-selected administration through the one canonical executor with cancellation', async () => {
    const controller = new AbortController();
    const pluginSettingsAdministrationAction = vi.fn(async () => ({
      ok: true,
      kind: 'plugins.settings.list' as const,
      data: {
        scope: { kind: 'account' as const },
        target: { kind: 'account' as const },
        revision: '7',
        fields: [],
      },
    }));
    const executor = createActionExecutor({
      pluginSettingsAdministrationAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);
    const input = {
      pluginId: 'acme.settings',
      scope: { kind: 'account' as const },
      target: { kind: 'account' as const },
    };
    const context = { surface: 'cli' as const, signal: controller.signal };

    await expect(executor.execute('plugins.settings.list', input, context)).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        kind: 'plugins.settings.list',
        data: {
          scope: { kind: 'account' },
          target: { kind: 'account' },
          revision: '7',
          fields: [],
        },
      },
    });
    expect(pluginSettingsAdministrationAction).toHaveBeenCalledWith({
      actionId: 'plugins.settings.list',
      input,
      context,
    });
  });

  it('rejects raw secret material before the administration executor can see it', async () => {
    const pluginSettingsAdministrationAction = vi.fn(async () => ({
      ok: true,
      kind: 'plugins.settings.secret.status' as const,
      data: { state: 'missing' },
    }));
    const executor = createActionExecutor({
      pluginSettingsAdministrationAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('plugins.settings.secret.status', {
      pluginId: 'acme.settings',
      localId: 'token',
      value: 'must-never-reach-a-secret-owner',
    }, { surface: 'cli' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(pluginSettingsAdministrationAction).not.toHaveBeenCalled();
  });

  it('fails closed when an administration producer tries to project a raw secret result', async () => {
    const pluginSettingsAdministrationAction = vi.fn(async () => ({
      ok: true,
      kind: 'plugins.settings.secret.status' as const,
      data: {
        localId: 'token',
        custody: 'account' as const,
        target: { kind: 'account' as const },
        state: 'configured' as const,
        revision: 'account-secret-r1:1',
        value: 'must-never-reach-an-action-consumer',
      },
    }));
    const executor = createActionExecutor({
      pluginSettingsAdministrationAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('plugins.settings.secret.status', {
      pluginId: 'acme.settings',
      localId: 'token',
    }, { surface: 'cli' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    });
  });
});
