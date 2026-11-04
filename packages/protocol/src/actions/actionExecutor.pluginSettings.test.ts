import { describe, expect, it, vi } from 'vitest';

import { buildApprovalExecutionOriginV1, createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { PluginSettingsAdministrationSetActionInputV1Schema } from '../plugins/settingsAdministration.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';

describe('createActionExecutor (plugin Settings administration)', () => {
  it('admits an ordinary Settings operand once and does not re-admit its prepared dispatch', async () => {
    const admitInput = vi.fn(async () => null);
    const port = Object.assign(async () => ({ ok: true, kind: 'plugins.settings.set' as const,
      data: { scope: { kind: 'account' as const }, target: { kind: 'account' as const },
        localId: 'enabled', revision: '8', application: { kind: 'live' as const } } }), { admitInput });
    const executor = createActionExecutor({ pluginSettingsAdministrationAction: port });
    const prepared = await executor.prepare('plugins.settings.set', {
      pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' },
      localId: 'enabled', value: true, expectedRevision: '7',
    }, { surface: 'cli', authority: 'present_user', bypassApprovals: true });
    expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
    expect(admitInput).toHaveBeenCalledTimes(1);
    if (prepared.kind !== 'ready') throw new Error('Expected admitted Settings write');
    await expect(prepared.invocation.run()).resolves.toMatchObject({ ok: true });
    expect(admitInput).toHaveBeenCalledTimes(1);
  });
  it('defaults automation and irreversible UI Settings writes to approval while letting users waive each surface', () => {
    const defaults = ActionsSettingsV1Schema.parse({ v: 1 });
    for (const actionId of [
      'plugins.settings.list', 'plugins.settings.get', 'plugins.settings.secret.status',
      'plugins.settings.set', 'plugins.settings.reset', 'plugins.settings.secret.bind',
      'plugins.settings.secret.unbind', 'plugins.settings.secret.delete',
    ] as const) {
      const spec = getActionSpec(actionId);
      const sensitive = spec.sideEffectClass === 'write';
      for (const surface of ['ui', 'agent', 'mcp'] as const) {
        const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const };
        const requiresApproval = sensitive && (surface !== 'ui'
          || actionId === 'plugins.settings.reset' || actionId === 'plugins.settings.secret.delete');
        expect(resolveActionApprovalRouting({ actionId, spec, settings: defaults, context }).required,
          `${actionId}/${surface}`).toBe(requiresApproval);
        const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } });
        expect(resolveActionApprovalRouting({ actionId, spec, settings: waived, context }).required,
          `${actionId}/${surface} waived`).toBe(false);
      }
    }
  });
  it('keeps ordinary Settings approval custody on the strict selected target instead of an ambient Machine', () => {
    const input = { pluginId: 'acme.settings', scope: { kind: 'daemon' },
      target: { kind: 'daemon', serverIdentityId: 'srv_selected_home', machineId: 'selected-machine' },
      localId: 'enabled', value: true, expectedRevision: 'same-revision' };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'selected-home',
      serverIdentityId: 'srv_selected_home', actionRequestId: 'selected-settings-write',
      executionRunTargetMachineId: 'ambient-run-machine', defaultSessionMachineId: 'ambient-session-machine' };
    expect(buildApprovalExecutionOriginV1({ actionId: 'plugins.settings.set', input, context, targetSessionId: null }))
      .toMatchObject({ serverIdentityId: 'srv_selected_home', machineId: 'selected-machine' });
    expect(buildApprovalExecutionOriginV1({ actionId: 'plugins.settings.set', input,
      context: { ...context, serverIdentityId: 'srv_other_home' }, targetSessionId: null })).toBeNull();
    expect(buildApprovalExecutionOriginV1({ actionId: 'plugins.settings.set', input: { ...input, scope: { kind: 'account' } },
      context, targetSessionId: null })).toBeNull();
    const accountOrigin = buildApprovalExecutionOriginV1({ actionId: 'plugins.settings.set',
      input: { ...input, scope: { kind: 'account' }, target: { kind: 'account' } }, context, targetSessionId: null });
    expect(accountOrigin).toMatchObject({ serverIdentityId: 'srv_selected_home' });
    expect(accountOrigin).not.toHaveProperty('machineId');
    const secretInput = { pluginId: input.pluginId, localId: 'token',
      secretDaemonTarget: input.target, canonicalOrigin: 'https://service.example' };
    expect(buildApprovalExecutionOriginV1({ actionId: 'plugins.settings.secret.delete', input: secretInput,
      context, targetSessionId: null })).toMatchObject({ machineId: 'selected-machine' });
    expect(buildApprovalExecutionOriginV1({ actionId: 'plugins.settings.secret.bind',
      input: { pluginId: input.pluginId, localId: 'token', savedSecretId: 'saved-1' }, context, targetSessionId: null }))
      .not.toHaveProperty('machineId');
  });
  it('refuses declared secret record operands before hooks, observations, approval disclosure or effects', async () => {
    for (const transformToSecret of [false, true]) {
      const artifacts: ApprovalRequest[] = [];
      const interceptedInputs: unknown[] = [];
      const observations: unknown[] = [];
      let revision = 7;
      const secretValue = 'synthetic-private-credential';
      const port = Object.assign(async () => {
        revision += 1;
        return { ok: true, kind: 'plugins.settings.set' as const,
          data: { scope: { kind: 'account' as const }, target: { kind: 'account' as const },
            localId: 'enabled', revision: String(revision), application: { kind: 'live' as const } } };
      }, {
        // The Protocol's host boundary reports its declared-field admission;
        // the real UI/CLI declaration resolvers are exercised in their owner suites.
        admitInput: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['pluginSettingsAdministrationAction']>>[0]) => {
          const parsed = PluginSettingsAdministrationSetActionInputV1Schema.parse(input);
          return parsed.localId === 'token' ? { ok: false as const, errorCode: 'plugin_settings_unknown_key', error: 'plugin_settings_unknown_key' } : null;
        },
      });
      const executor = createActionExecutor({ pluginSettingsAdministrationAction: port,
        isActionApprovalRequired: id => id === 'plugins.settings.set',
        approvalsCreate: async ({ request }) => { artifacts.push(request); return { artifactId: 'settings-approval' }; },
        interceptActionExecution: async ({ input }) => { interceptedInputs.push(input);
          return { status: 'continue', input: transformToSecret ? { ...PluginSettingsAdministrationSetActionInputV1Schema.parse(input),
            localId: 'token', value: secretValue } : input }; },
        observeActionExecution: observation => { observations.push(observation); },
      } as ActionExecutorDeps);
      const result = await executor.execute('plugins.settings.set', { pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' },
        localId: transformToSecret ? 'enabled' : 'token', value: transformToSecret ? true : secretValue, expectedRevision: '7' },
      { surface: 'cli', authority: 'present_user', serverId: 'server-1', actionCaller: { kind: 'host' }, actionRequestId: 'settings-secret-attempt' });
      expect(result).toMatchObject({ ok: false, errorCode: 'plugin_settings_unknown_key' });
      expect(artifacts).toEqual([]);
      expect(revision).toBe(7);
      if (!transformToSecret) expect(interceptedInputs).toEqual([]);
      expect(JSON.stringify(observations)).not.toContain(secretValue);
    }
  });

  it('retains ordinary Settings values for the existing deferred approval and approved replay', async () => {
    let request: ApprovalRequest | null = null;
    let revision = 7;
    let enabled = false;
    const port = Object.assign(async ({ input }: Parameters<NonNullable<ActionExecutorDeps['pluginSettingsAdministrationAction']>>[0]) => {
      const parsed = PluginSettingsAdministrationSetActionInputV1Schema.parse(input);
      enabled = parsed.value === true;
      revision += 1;
      return { ok: true, kind: 'plugins.settings.set' as const,
        data: { scope: { kind: 'account' as const }, target: { kind: 'account' as const },
          localId: parsed.localId, revision: String(revision), application: { kind: 'live' as const } } };
    }, { admitInput: async () => null });
    const executor = createActionExecutor({ pluginSettingsAdministrationAction: port,
      isActionApprovalRequired: id => id === 'plugins.settings.set',
      approvalsCreate: async args => {
        request = ApprovalRequestV2Schema.parse(args.request);
        return { artifactId: 'settings-approval' };
      },
      approvalsGet: async () => request,
      approvalsUpdate: async args => { request = args.request; return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
    } as ActionExecutorDeps);
    const input = { pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'enabled', value: true, expectedRevision: '7' };
    expect(await executor.execute('plugins.settings.set', input, { surface: 'cli', authority: 'present_user', serverId: 'server-1',
      executionRunTargetMachineId: 'ambient-run-machine', defaultSessionMachineId: 'ambient-session-machine',
      actionCaller: { kind: 'host' }, actionRequestId: 'settings-ordinary-attempt' })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(request).toMatchObject({ actionArgs: input, approval: { flow: 'deferred' } });
    expect(request).not.toHaveProperty('executionOriginV1.machineId');
    expect(enabled).toBe(false);
    expect(await executor.execute('approval.request.decide', { artifactId: 'settings-approval', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'server-1', actionCaller: { kind: 'host' } })).toMatchObject({ ok: true });
    expect(enabled).toBe(true);
    expect(revision).toBe(8);
  });

  it('refuses declared secret record operands in failure observations and tool provenance', async () => {
    const secretValue = 'synthetic-private-observation-credential';
    const observations: unknown[] = [];
    const port = Object.assign(async () => ({ ok: false as const, kind: 'plugins.settings.set' as const,
      errorCode: 'plugin_settings_unknown_key', error: 'plugin_settings_unknown_key' }), {
      admitInput: async ({ input }: Parameters<NonNullable<ActionExecutorDeps['pluginSettingsAdministrationAction']>>[0]) => {
        const parsed = PluginSettingsAdministrationSetActionInputV1Schema.parse(input);
        return parsed.localId === 'token' ? { ok: false as const, errorCode: 'plugin_settings_unknown_key', error: 'plugin_settings_unknown_key' } : null;
      },
    });
    const input = { pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'endpoint', value: secretValue };
    const executor = createActionExecutor({ pluginSettingsAdministrationAction: port, isActionApprovalRequired: () => false,
      interceptActionExecution: async request => ({ status: 'continue', input: { ...PluginSettingsAdministrationSetActionInputV1Schema.parse(request.input), localId: 'token' } }),
      observeActionExecution: observation => { observations.push(observation); },
    } as ActionExecutorDeps);
    expect(await executor.execute('plugins.settings.set', input, { surface: 'cli', authority: 'present_user', bypassApprovals: true,
      actionCaller: { kind: 'host' }, approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'session-1', toolCallId: 'tool-1', toolInput: input } }))
      .toMatchObject({ ok: false, errorCode: 'plugin_settings_unknown_key' });
    expect(observations).toHaveLength(1);
    expect(JSON.stringify(observations)).not.toContain(secretValue);
  });
  it('honors explicit Ask first for a UI setting write before effects and replays the approved intent', async () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'plugins.settings.set': { approvalRequiredSurfaces: ['ui'] } } });
    expect(isApprovalRequiredByActionsSettings('plugins.settings.set', settings,
      { surface: 'ui', authority: 'present_user' })).toBe(true);
    const write = Object.assign(vi.fn(async () => ({ ok: true, kind: 'plugins.settings.set' as const,
      data: { scope: { kind: 'account' as const }, target: { kind: 'account' as const },
        localId: 'enabled', revision: '8', application: { kind: 'live' as const } } })), { admitInput: async () => null });
    const executor = createActionExecutor({ pluginSettingsAdministrationAction: write,
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
    } as ActionExecutorDeps);
    const input = { pluginId: 'acme.settings', scope: { kind: 'account' as const },
      target: { kind: 'account' as const }, localId: 'enabled', value: true, expectedRevision: '7' };
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    expect(await executor.execute('plugins.settings.set', input, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(write).not.toHaveBeenCalled();
    expect(await executor.execute('plugins.settings.set', input, { ...context, bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { ok: true, data: { revision: '8' } } });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ input }));
  });
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
      details: { issues: [{ code: 'unrecognized_keys', path: [] }] },
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

  it('defaults plugin secret custody mutations to approval while retaining their API exclusion', async () => {
    const pluginSettingsAdministrationAction = vi.fn(async () => ({
      ok: true,
      kind: 'plugins.settings.secret.bind' as const,
      data: {
        localId: 'token',
        custody: 'account' as const,
        target: { kind: 'account' as const },
        revision: 'account-secret-r1:1',
        application: { kind: 'live' as const },
      },
    }));
    const executor = createActionExecutor({
      pluginSettingsAdministrationAction,
      approvalsCreate: async () => ({ artifactId: 'secret-approval' }),
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, ActionsSettingsV1Schema.parse({ v: 1 }), context),
    } as ActionExecutorDeps);
    const inputs = {
      'plugins.settings.secret.bind': {
        pluginId: 'acme.settings',
        localId: 'token',
        savedSecretId: 'saved-secret-1',
      },
      'plugins.settings.secret.unbind': {
        pluginId: 'acme.settings',
        localId: 'token',
      },
      'plugins.settings.secret.delete': {
        pluginId: 'acme.settings',
        localId: 'token',
      },
    } as const;
    const mutationActionIds = Object.keys(inputs) as Array<keyof typeof inputs>;
    const withoutApprovalCustody = createActionExecutor({ pluginSettingsAdministrationAction } as ActionExecutorDeps);

    for (const actionId of mutationActionIds) {
      await expect(withoutApprovalCustody.execute(actionId, inputs[actionId], {
        surface: 'plugin', authority: 'account_automation',
        actionCaller: { kind: 'plugin', pluginId: 'acme.settings' },
      })).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });

      await expect(executor.execute(actionId, inputs[actionId], {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'action_disabled',
        details: { surface: 'api', reason: 'unsupported_surface' },
      });

      await expect(executor.execute(actionId, inputs[actionId], {
        surface: 'plugin',
        serverId: 'server-1',
        actionRequestId: `settings-${actionId}`,
        authority: 'account_automation',
        actionCaller: {
          kind: 'plugin', pluginId: 'acme.settings', contributionLocalId: 'settings',
          sourceCustody: { kind: 'development', registeredRootId: 'settings-root-1' },
        },
      })).resolves.toEqual({
        ok: true,
        result: { kind: 'approval_request_created', artifactId: 'secret-approval', actionId },
      });
    }

    expect(pluginSettingsAdministrationAction).not.toHaveBeenCalled();

    await expect(executor.execute(
      'plugins.settings.secret.bind',
      inputs['plugins.settings.secret.bind'],
      {
        surface: 'cli',
        authority: 'present_user',
        bypassApprovals: true,
        actionCaller: { kind: 'host' },
      },
    )).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        kind: 'plugins.settings.secret.bind',
        data: {
          localId: 'token',
          custody: 'account',
          target: { kind: 'account' },
          revision: 'account-secret-r1:1',
          application: { kind: 'live' },
        },
      },
    });
    expect(pluginSettingsAdministrationAction).toHaveBeenCalledWith({
      actionId: 'plugins.settings.secret.bind',
      input: inputs['plugins.settings.secret.bind'],
      context: {
        surface: 'cli',
        authority: 'present_user',
        bypassApprovals: true,
        actionCaller: { kind: 'host' },
      },
    });
  });
});
