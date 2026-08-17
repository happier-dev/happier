import { describe, expect, it, vi } from 'vitest';

import type { ActionExecutorDeps, ActionPluginCaller } from './executor/types.js';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec, listActionSpecs } from './actionSpecs.js';

function pluginCaller(
  pluginId: string,
  contributionLocalId = 'surface',
): ActionPluginCaller {
  return {
    kind: 'plugin',
    pluginId,
    contributionLocalId,
    materialization: {
      machineId: 'machine-1',
      materializationId: `${pluginId}-materialization`,
      pluginId,
    },
  };
}

function createExecutor(overrides: Partial<ActionExecutorDeps> = {}) {
  return createActionExecutor({
    isActionApprovalRequired: () => false,
    ...overrides,
  } as ActionExecutorDeps);
}

describe('createActionExecutor plugin caller policy', () => {
  it('classifies every retained non-safe plugin Action and retracts unconsumed plugin administration', () => {
    for (const actionId of ['plugins.scaffold', 'plugins.install', 'plugins.uninstall'] as const) {
      expect(getActionSpec(actionId).surfaces.plugin).toBe(false);
    }

    const nonSafePluginActions = listActionSpecs().filter((spec) => (
      spec.surfaces.plugin && spec.safety !== 'safe'
    ));
    expect(nonSafePluginActions).toHaveLength(49);
    expect(nonSafePluginActions.filter((spec) => (
      spec.pluginCallerPolicy?.kind === 'caller'
    ))).toHaveLength(48);
    expect(nonSafePluginActions.every((spec) => spec.pluginCallerPolicy?.kind === 'caller'
      || spec.pluginCallerPolicy?.kind === 'self_or_inspector_admin')).toBe(true);
    expect(nonSafePluginActions.filter((spec) => spec.id !== 'plugins.reload').every((spec) => (
      spec.pluginCallerPolicy?.kind === 'caller'
    ))).toBe(true);
    expect(getActionSpec('plugins.reload').pluginCallerPolicy).toMatchObject({
      kind: 'self_or_inspector_admin',
      targetPluginIdField: 'pluginId',
    });
  });

  it('allows a plugin to reload itself, propagating its host-stamped caller and cancellation signal', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ pluginsDevLoopAction });
    const controller = new AbortController();
    const caller = pluginCaller('acme.author');

    await expect(executor.execute('plugins.reload', { pluginId: 'acme.author' }, {
      surface: 'plugin',
      actionCaller: caller,
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: { ok: true } });

    expect(pluginsDevLoopAction).toHaveBeenCalledWith({
      actionId: 'plugins.reload',
      input: { pluginId: 'acme.author' },
      context: expect.objectContaining({
        actionCaller: caller,
        signal: controller.signal,
        surface: 'plugin',
      }),
    });
  });

  it('refuses a plugin-target spoof, including one introduced by an Action interceptor', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true }));
    const interceptActionExecution = vi.fn(async () => ({
      status: 'continue' as const,
      input: { pluginId: 'acme.other' },
    }));
    const executor = createExecutor({ pluginsDevLoopAction, interceptActionExecution });

    await expect(executor.execute('plugins.reload', { pluginId: 'acme.author' }, {
      surface: 'plugin',
      actionCaller: pluginCaller('acme.author'),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_forbidden',
      error: 'plugin_action_caller_forbidden',
    });

    expect(pluginsDevLoopAction).not.toHaveBeenCalled();
  });

  it('admits Inspector cross-plugin reload only from its declared administrative surface', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true }));
    const executor = createExecutor({ pluginsDevLoopAction });

    await expect(executor.execute('plugins.reload', { pluginId: 'acme.target' }, {
      surface: 'plugin',
      actionCaller: pluginCaller('happier.inspector', 'inspector-app'),
    })).resolves.toEqual({ ok: true, result: { ok: true } });

    await expect(executor.execute('plugins.reload', { pluginId: 'acme.target' }, {
      surface: 'plugin',
      actionCaller: pluginCaller('happier.inspector', 'other-surface'),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_forbidden',
      error: 'plugin_action_caller_forbidden',
    });
  });

  it('retains the incumbent plugin binding as the authority against caller identity supplied in input', async () => {
    const pluginPermissionGrantAction = vi.fn(async () => ({ pendingRequest: { id: 'request-1' } }));
    const executor = createExecutor({ pluginPermissionGrantAction });

    await expect(executor.execute('plugins.permissions.grants.request', {
      pluginId: 'acme.spoofed',
      capability: 'network',
      targetScope: { kind: 'account' },
      subject: { kind: 'general' },
      reason: 'spoofed caller identity must not reach the owner',
    }, {
      surface: 'plugin',
      actionCaller: pluginCaller('acme.author'),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(pluginPermissionGrantAction).not.toHaveBeenCalled();
  });
});
