import { describe, expect, it, vi } from 'vitest';

import type { ActionExecutorDeps, ActionPluginCaller } from './executor/types.js';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec, listActionSpecs } from './actionSpecs.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { resolveUsagePageAggregation } from '../usage/resolveUsagePageAggregation.js';
import { UsageAnalyticsQueryResponseSchema } from '../usage/usageAnalyticsContracts.js';
import { UsageFileResultSchema } from '../usage/usageExport.js';
import { decodeBase64 } from '../crypto/base64.js';
import { PluginUiResourceSubscriptionRequestV1Schema } from '../plugins/ui/subscriptions.js';

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
  it('permits selected-field export under safe-read caller admission while retaining the Resource ceiling', async () => {
    const query = normalizeUsageQuery({});
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
      tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
      cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } });
    const executor = createExecutor({ usageActions: { query: async request => resolveUsagePageAggregation({ queries: request.queries,
      accounting: [{ query, value: accounting, status: 'available', asOfMs: 150 }] }) } });
    const request = { query, format: 'json', fields: ['totals'] };
    const permitted = await executor.execute('usage.export', request, { surface: 'plugin', actionCaller: pluginCaller('example.usage') });
    expect(permitted.ok).toBe(true);
    const file = UsageFileResultSchema.parse(permitted.ok ? permitted.result : undefined);
    expect(JSON.parse(new TextDecoder().decode(decodeBase64(file.base64))).accounting).toEqual({ totals: accounting.totals });
    expect(await executor.execute('usage.export', request, { surface: 'plugin' })).toMatchObject({ ok: false, errorCode: 'plugin_action_caller_required' });
    const stale = createExecutor({ usageActions: { query: async () => ({ ok: false, errorCode: 'credential_scope_retired', error: 'credential_scope_retired' }) } });
    expect(await stale.execute('usage.export', request, { surface: 'plugin', actionCaller: pluginCaller('example.usage') }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
    expect(PluginUiResourceSubscriptionRequestV1Schema.safeParse({ resource: { hostRead: 'usage.export', input: request }, subscriptionId: 'export' }).success).toBe(false);
  });
  it('enforces explicit caller policy on safe host reads in both prepare and execute', async () => {
    const executor = createExecutor();
    const context = { surface: 'plugin' as const };
    const input = { queries: [{}] };
    await expect(executor.prepare('usage.query', input, context)).resolves.toMatchObject({
      kind: 'settled', result: { ok: false, errorCode: 'plugin_action_caller_required' },
    });
    await expect(executor.execute('usage.query', input, context)).resolves.toMatchObject({
      ok: false, errorCode: 'plugin_action_caller_required',
    });
    await expect(executor.prepare('usage.query', input, { ...context,
      actionCaller: { kind: 'plugin', pluginId: 'acme.author', contributionLocalId: 'surface' },
    })).resolves.toMatchObject({ kind: 'ready' });
  });
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

  it('defers plugin uninstall until a present user approves, including interactive plugin requests', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({
      ok: true as const,
      kind: 'plugins_uninstall',
    }));
    let storedRequest: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    const approvalsCreate = vi.fn(async ({ request }: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]) => {
      storedRequest = request;
      return { artifactId: 'uninstall-approval' };
    });
    const executor = createExecutor({
      pluginsDevLoopAction, approvalsCreate,
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = request;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });

    await expect(executor.execute('plugins.uninstall', {
      pluginId: 'acme.author',
    }, {
      surface: 'plugin',
      serverId: 'server-1',
      actionRequestId: 'uninstall-1',
      authority: 'account_automation',
      actionCaller: {
        ...pluginCaller('acme.author'),
        sourceCustody: { kind: 'development', registeredRootId: 'author-root-1' },
      },
    })).resolves.toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'uninstall-approval', actionId: 'plugins.uninstall' },
    });
    expect(pluginsDevLoopAction).not.toHaveBeenCalled();
    expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      status: 'open', actionId: 'plugins.uninstall', actionArgs: { pluginId: 'acme.author' },
    }) }));

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'uninstall-approval', decision: 'approve',
    }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(pluginsDevLoopAction).toHaveBeenCalledTimes(1);

    await expect(executor.execute('plugins.uninstall', {
      pluginId: 'acme.author',
    }, {
      surface: 'plugin',
      serverId: 'server-1',
      actionRequestId: 'interactive-uninstall-1',
      authority: 'present_user',
      actionCaller: {
        ...pluginCaller('acme.author'),
        sourceCustody: { kind: 'development', registeredRootId: 'author-root-1' },
      },
    })).resolves.toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'uninstall-approval', actionId: 'plugins.uninstall' },
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
