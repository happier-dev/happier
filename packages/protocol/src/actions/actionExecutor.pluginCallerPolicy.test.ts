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
import { createPluginInstallationReviewFixture } from '../testing/pluginInstallationReviewFixture.js';

import { normalizeActionsSettingsV1 } from './actionSettings.js';

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

    ...overrides,
  } as ActionExecutorDeps);
}

const defaultApprovalPolicy: NonNullable<ActionExecutorDeps['readActionsSettings']> = (context) => context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 });

describe('createActionExecutor plugin caller policy', () => {
  it('preserves the real plugin caller through contributed dispatch and keeps target admission authoritative', async () => {
    const calls: Parameters<NonNullable<ActionExecutorDeps['invokeContributedAction']>>[0][] = [];
    const executor = createExecutor({ invokeContributedAction: async request => {
      calls.push(request);
      return { ok: false, errorCode: 'plugin_action_surface_unavailable', error: 'plugin_action_surface_unavailable' };
    } });
    const input = { action: { pluginId: 'example.target', localId: 'handoff' }, input: { task: 'fix' } };
    expect(await executor.execute('action.invoke', input, { surface: 'plugin' }))
      .toMatchObject({ ok: false, errorCode: 'plugin_action_caller_required' });
    expect(calls).toHaveLength(0);
    const caller = pluginCaller('example.requester');
    expect(await executor.execute('action.invoke', input, { surface: 'plugin', actionCaller: caller }))
      .toMatchObject({ ok: false, errorCode: 'plugin_action_surface_unavailable' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: input.action, input: input.input,
      context: { surface: 'plugin', actionCaller: caller } });
  });

  it('permits selected-field export under safe-read caller admission while retaining the Resource ceiling', async () => {
    const query = normalizeUsageQuery({});
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1,
      tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
      cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } });
    const executor = createExecutor({ usageActions: { query: async request => resolveUsagePageAggregation({ queries: request.queries,
      accounting: request.queries.map(query => ({ query, value: accounting, status: 'available' as const, asOfMs: 150 })) }) } });
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
  it.each([
    { actionId: 'usage.query', input: { queries: [{}] } },
    { actionId: 'action.operations.get', input: { serverId: 'home', machineId: 'machine-1', operationId: 'operation-1' } },
  ] as const)('enforces explicit caller policy on safe host read $actionId in both prepare and execute', async ({ actionId, input }) => {
    const executor = createExecutor();
    const context = { surface: 'plugin' as const };
    expect(getActionSpec(actionId).surfaces.plugin).toBe(true);
    expect(getActionSpec(actionId).pluginCallerPolicy).toEqual({ kind: 'caller' });
    await expect(executor.prepare(actionId, input, context)).resolves.toMatchObject({
      kind: 'settled', result: { ok: false, errorCode: 'plugin_action_caller_required' },
    });
    await expect(executor.execute(actionId, input, context)).resolves.toMatchObject({
      ok: false, errorCode: 'plugin_action_caller_required',
    });
    await expect(executor.prepare(actionId, input, { ...context,
      actionCaller: { kind: 'plugin', pluginId: 'acme.author', contributionLocalId: 'surface' },
    })).resolves.toMatchObject({ kind: 'ready' });
  });
  it('keeps trusted-plugin Actions open while classifying every non-safe plugin Action', () => {
    for (const [actionId, requiredAuthority] of [
      ['plugins.scaffold', 'account_automation'],
      ['plugins.install', 'account_automation'],
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
    )).map((spec) => spec.id)).toEqual([]);
  });

  it('fails closed without uninstall approval support and admits an interactive present user', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({
      ok: true as const,
      kind: 'plugins_uninstall',
    }));
    const executor = createExecutor({ pluginsDevLoopAction, readActionsSettings: defaultApprovalPolicy });

    await expect(executor.execute('plugins.uninstall', {
      pluginId: 'acme.author',
    }, {
      surface: 'plugin',
      authority: 'account_automation',
      actionCaller: pluginCaller('acme.author'),
    })).resolves.toEqual({
      ok: false,
      errorCode: 'approvals_not_supported',
      error: 'approvals_not_supported',
    });
    expect(pluginsDevLoopAction).not.toHaveBeenCalled();

    await expect(executor.execute('plugins.uninstall', {
      pluginId: 'acme.author',
    }, {
      surface: 'cli',
      authority: 'present_user',
      presentUserConfirmation: { actionId: 'plugins.uninstall' },
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
      readActionsSettings: defaultApprovalPolicy,
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
      executionRunTargetMachineId: 'machine-1',
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
      approval: expect.objectContaining({ flow: 'deferred' }),
      executionOriginV1: expect.objectContaining({ authority: 'account_automation', caller: {
        kind: 'plugin', pluginId: 'acme.author', contributionLocalId: 'surface',
        sourceCustody: { kind: 'development', registeredRootId: 'author-root-1' }, startedBy: 'trigger',
      } }),
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
      executionRunTargetMachineId: 'machine-1',
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

  it('settles an Agent plugin install only through the canonical human approval replay', async () => {
    const pluginsDevLoopAction = vi.fn(async ({ context }: Parameters<NonNullable<ActionExecutorDeps['pluginsDevLoopAction']>>[0]) => ({
      ok: true as const,
      kind: 'plugins_install',
      outcome: 'applied' as const,
      proofArtifactId: context.presentUserApproval?.artifactId ?? null,
    }));
    let storedRequest: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    const sessionSendMessage = vi.fn<NonNullable<ActionExecutorDeps['sessionSendMessage']>>(async ({ localId }) => ({
      status: 'accepted', localId: localId!,
    }));
    const executor = createExecutor({
      pluginsDevLoopAction, sessionSendMessage,
      readActionsSettings: () => (normalizeActionsSettingsV1({ v: 1 })),
      buildApprovalPreview: async ({ defaultPreview }) => ({
        ...defaultPreview,
        pluginInstall: {
          permissionsDisclosure: 'daemonEvaluated',
          pendingReview: {
            kind: 'reviewRequired',
            reviewKind: 'installation',
            pendingChangeId: 'pending-plugin-install',
            reason: 'firstInstall',
            currentVersion: null,
            authorityExpansion: [],
            review: createPluginInstallationReviewFixture(),
          },
        },
      }),
      approvalsCreate: async ({ request }) => {
        storedRequest = request;
        return { artifactId: 'plugin-install-approval' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = request;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const input = { path: '/workspace/acme-plugin', kind: 'path' as const };
    const requester = {
      surface: 'agent' as const,
      authority: 'account_automation' as const,
      serverId: 'server-1',
      runtimeAccountId: 'account-1',
      defaultSessionId: 'agent-session-1',
      executionRunTargetMachineId: 'machine-1',
      actionRequestId: 'agent-install-1',
      actionCaller: {
        kind: 'session' as const,
        sessionId: 'agent-session-1',
        starterDepth: 0,
        turnDepth: 0,
      },
    };

    await expect(executor.execute('plugins.install', input, requester)).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'plugin-install-approval' },
    });
    expect(pluginsDevLoopAction).not.toHaveBeenCalled();
    await expect(executor.execute('approval.request.decide', {
      artifactId: 'plugin-install-approval', decision: 'approve',
    }, requester)).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(pluginsDevLoopAction).not.toHaveBeenCalled();

    const decided = await executor.execute('approval.request.decide', {
      artifactId: 'plugin-install-approval', decision: 'approve',
    }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'account-1', serverId: 'server-1',
    });
    expect(decided, JSON.stringify(decided)).toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true, result: { proofArtifactId: 'plugin-install-approval' } } },
    });
    expect(pluginsDevLoopAction).toHaveBeenCalledTimes(1);
    expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'agent-session-1', localId: 'approval-result:plugin-install-approval',
      context: expect.objectContaining({ runtimeAccountId: 'account-1', serverId: 'server-1' }),
    }));
  });

  it.each(['ui', 'cli'] as const)('keeps native UI install review separate from the CLI approval handle (%s)', async (surface) => {
    const requests: unknown[] = [];
    const executor = createActionExecutor({
      readActionsSettings: () => (normalizeActionsSettingsV1({ v: 1 })),
      approvalsCreate: async ({ request }) => { requests.push(request); return { artifactId: 'install-review' }; },
      pluginsDevLoopAction: async () => { throw new Error('Install effect must wait for approval'); },
    } as ActionExecutorDeps);
    const result = await executor.execute('plugins.install', { kind: 'path', path: '/tmp/example' }, {
      surface, authority: 'present_user', serverId: 'home-1', actionRequestId: 'default-install',
      actionCaller: { kind: 'host' },
    });
    if (surface === 'ui') {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
      expect(requests).toEqual([]);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', artifactId: 'install-review' } });
    expect(requests).toEqual([expect.objectContaining({ status: 'open', actionId: 'plugins.install',
      approval: expect.objectContaining({ flow: 'deferred' }) })]);
  });

  it('executes a plugin install with the user-waived Agent policy without inventing human approval', async () => {
    const settings = normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { 'plugins.install': ['agent'] } });
    const executor = createActionExecutor({
      readActionsSettings: () => (settings),
      pluginsDevLoopAction: async ({ context }) => ({ ok: true, kind: 'plugins_install',
        outcome: 'applied', authority: context.authority, proofArtifactId: context.presentUserApproval?.artifactId ?? null }),
    } as ActionExecutorDeps);
    const result = await executor.execute('plugins.install', { kind: 'path', path: '/tmp/example' }, {
      surface: 'agent', authority: 'account_automation', serverId: 'home-1',
      actionRequestId: 'waived-install', actionCaller: { kind: 'host' },
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
      outcome: 'applied', authority: 'account_automation', proofArtifactId: null,
    } });
  });

  it('keeps a plugin install Artifact open when daemon evaluation is still pending', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true, kind: 'plugins_install' }));
    let storedRequest: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    const executor = createExecutor({
      pluginsDevLoopAction,
      readActionsSettings: () => (normalizeActionsSettingsV1({ v: 1 })),
      buildApprovalPreview: async ({ defaultPreview }) => ({
        ...defaultPreview,
        pluginInstall: { permissionsDisclosure: 'pendingDaemonEvaluation' },
      }),
      approvalsCreate: async ({ request }) => {
        storedRequest = request;
        return { artifactId: 'plugin-install-pending-evaluation' };
      },
      approvalsGet: async () => storedRequest,
      approvalsUpdate: async ({ request }) => {
        storedRequest = request;
        return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const requester = {
      surface: 'agent' as const,
      authority: 'account_automation' as const,
      serverId: 'server-1',
      actionRequestId: 'agent-install-pending-evaluation',
      actionCaller: { kind: 'host' as const },
    };

    await expect(executor.execute('plugins.install', {
      path: '/workspace/acme-plugin', kind: 'path',
    }, requester)).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'plugin-install-pending-evaluation' },
    });
    await expect(executor.execute('approval.request.decide', {
      artifactId: 'plugin-install-pending-evaluation', decision: 'approve',
    }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
    expect(storedRequest).toMatchObject({ status: 'open' });
    expect(pluginsDevLoopAction).not.toHaveBeenCalled();
  });

  it('uninstalls once the user waives the plugin surface Ask (no present-user floor)', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true, kind: 'plugins_uninstall' }));
    const approvalsCreate = vi.fn<NonNullable<ActionExecutorDeps['approvalsCreate']>>(
      async () => ({ artifactId: 'approval-uninstall-1' }),
    );
    const executor = createExecutor({ pluginsDevLoopAction, approvalsCreate, readActionsSettings: defaultApprovalPolicy });
    const caller = {
      ...pluginCaller('acme.author'),
      sourceCustody: { kind: 'development' as const, registeredRootId: 'author-root-1' },
    };

    await expect(executor.execute('plugins.uninstall', { pluginId: 'acme.author' }, {
      surface: 'plugin',
      authority: 'account_automation',
      serverId: 'server-1',
      actionRequestId: 'uninstall-1',
      actionCaller: caller,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'plugins.uninstall': ['plugin'] } }),
    })).resolves.not.toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(approvalsCreate).not.toHaveBeenCalled();
    expect(pluginsDevLoopAction).toHaveBeenCalledOnce();
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
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'plugins.reload': ['plugin'] } }),
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

  it('lets any host-stamped trusted plugin reload a different plugin through the same lifecycle owner', async () => {
    const pluginsDevLoopAction = vi.fn(async () => ({ ok: true, kind: 'plugins_reload' }));
    const executor = createExecutor({ pluginsDevLoopAction });
    const caller = pluginCaller('acme.author', 'surface');

    await expect(executor.execute('plugins.reload', { pluginId: 'acme.target' }, {
      surface: 'plugin',
      actionCaller: caller,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'plugins.reload': ['plugin'] } }),
    })).resolves.toEqual({ ok: true, result: { ok: true, kind: 'plugins_reload' } });

    expect(pluginsDevLoopAction).toHaveBeenCalledWith({
      actionId: 'plugins.reload',
      input: { pluginId: 'acme.target' },
      context: expect.objectContaining({ actionCaller: caller, surface: 'plugin' }),
    });
  });

  it('retains the incumbent plugin binding as the authority against caller identity supplied in input', async () => {
    const pluginPermissionGrantAction = vi.fn(async () => ({ pendingRequest: { id: 'request-1' } }));
    const executor = createExecutor({ pluginPermissionGrantAction });

    await expect(executor.execute('plugins.permissions.grants.request', {
      pluginId: 'acme.spoofed',
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject: { kind: 'general' },
      reason: 'spoofed caller identity must not reach the owner',
    }, {
      surface: 'plugin',
      actionCaller: pluginCaller('acme.author'),
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: {
        issues: [
          { code: 'unrecognized_keys', path: [] },
        ],
      },
    });

    expect(pluginPermissionGrantAction).not.toHaveBeenCalled();
  });
});
