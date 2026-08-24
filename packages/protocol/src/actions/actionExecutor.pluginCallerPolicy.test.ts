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
  it('keeps trusted-plugin Actions open while classifying every non-safe plugin Action', () => {
    for (const [actionId, requiredAuthority] of [
      ['plugins.scaffold', 'account_automation'],
      ['plugins.install', 'present_user'],
      ['plugins.uninstall', 'present_user'],
      ['plugins.sessionHooks.status.get', 'account_automation'],
      ['plugins.sessionHooks.install', 'present_user'],
      ['plugins.sessionHooks.disable', 'present_user'],
      ['plugins.sessionHooks.enable', 'present_user'],
      ['plugins.sessionHooks.uninstall', 'present_user'],
    ] as const) {
      expect(getActionSpec(actionId).surfaces.plugin).toBe(true);
      expect(getActionSpec(actionId).requiredAuthority).toBe(requiredAuthority);
    }

    const nonSafePluginActions = listActionSpecs().filter((spec) => (
      spec.surfaces.plugin && spec.safety !== 'safe'
    ));
    expect(nonSafePluginActions).not.toHaveLength(0);
    expect(nonSafePluginActions.filter((spec) => (
      spec.pluginCallerPolicy?.kind !== 'caller'
    )).map((spec) => spec.id)).toEqual(['plugins.reload']);
    expect(getActionSpec('plugins.reload').pluginCallerPolicy).toEqual({
      kind: 'self_or_inspector_admin',
      targetPluginIdField: 'pluginId',
      administrativeCallers: [{
        pluginId: 'happier.inspector',
        contributionLocalId: 'inspector-app',
      }],
    });
  });

  it('rejects plugin uninstall automation before side effects and admits an interactive present user', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({
      ok: true as const,
      kind: 'plugins_uninstall',
    }));
    const executor = createExecutor({ pluginsDevLoopAction });

    await expect(executor.execute('plugins.uninstall', {
      pluginId: 'acme.author',
    }, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'present_user_required',
      error: 'present_user_required',
    });
    expect(pluginsDevLoopAction).not.toHaveBeenCalled();

    await expect(executor.execute('plugins.uninstall', {
      pluginId: 'acme.author',
    }, {
      surface: 'api',
      authority: 'present_user',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        kind: 'plugins_uninstall',
      },
    });
    expect(pluginsDevLoopAction).toHaveBeenCalledTimes(1);
  });

  it('allows a plugin to reload itself, propagating its host-stamped caller and cancellation signal', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true, kind: 'plugins_reload' }));
    const executor = createExecutor({ pluginsDevLoopAction });
    const controller = new AbortController();
    const caller = pluginCaller('acme.author');

    await expect(executor.execute('plugins.reload', { pluginId: 'acme.author' }, {
      surface: 'plugin',
      actionCaller: caller,
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: { ok: true, kind: 'plugins_reload' } });

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

  it('still refuses reload from a caller the host never stamped', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true, kind: 'plugins_reload' }));
    const executor = createExecutor({ pluginsDevLoopAction });

    await expect(executor.execute('plugins.reload', { pluginId: 'acme.author' }, {
      surface: 'plugin',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });

    expect(pluginsDevLoopAction).not.toHaveBeenCalled();
  });

  it('admits cross-plugin reload only from the exact Inspector administrative surface', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true, kind: 'plugins_reload' }));
    const executor = createExecutor({ pluginsDevLoopAction });

    await expect(executor.execute('plugins.reload', { pluginId: 'acme.target' }, {
      surface: 'plugin',
      actionCaller: pluginCaller('happier.inspector', 'inspector-app'),
    })).resolves.toEqual({ ok: true, result: { ok: true, kind: 'plugins_reload' } });
    expect(pluginsDevLoopAction).toHaveBeenCalledTimes(1);

    pluginsDevLoopAction.mockClear();
    for (const caller of [
      // An Inspector clone reusing the administrative contribution local id.
      pluginCaller('acme.inspector-clone', 'inspector-app'),
      // The real Inspector calling from a contribution surface that is not the
      // administrative one.
      pluginCaller('happier.inspector', 'some-other-surface'),
      // An arbitrary peer plugin.
      pluginCaller('acme.author', 'surface'),
    ]) {
      await expect(executor.execute('plugins.reload', { pluginId: 'acme.target' }, {
        surface: 'plugin',
        actionCaller: caller,
      })).resolves.toEqual({
        ok: false,
        errorCode: 'plugin_action_caller_forbidden',
        error: 'plugin_action_caller_forbidden',
      });
    }

    expect(pluginsDevLoopAction).not.toHaveBeenCalled();
  });

  it('rejects a target rewritten to a peer plugin after Action interception', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true, kind: 'plugins_reload' }));
    const executor = createExecutor({
      pluginsDevLoopAction,
      interceptActionExecution: async () => ({
        status: 'continue',
        input: { pluginId: 'acme.victim' },
      }),
    });

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
