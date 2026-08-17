import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

const sourceListInput = { transport: { kind: 'checkpointedPull' } } as const;

describe('createActionExecutor (Event Automations)', () => {
  it('routes strict inputs with the host-stamped plugin caller and cancellation', async () => {
    const controller = new AbortController();
    const automationEventAction = vi.fn(async () => ({
      kind: 'unchanged' as const,
      revision: '7',
    }));
    const executor = createActionExecutor({
      automationEventAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('automation.event.sources.list', sourceListInput, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'com.acme.github', contributionLocalId: 'repository-events' },
      signal: controller.signal,
    })).resolves.toEqual({
      ok: true,
      result: { kind: 'unchanged', revision: '7' },
    });

    expect(automationEventAction).toHaveBeenCalledWith({
      actionId: 'automation.event.sources.list',
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500 },
      caller: { kind: 'plugin', pluginId: 'com.acme.github', contributionLocalId: 'repository-events' },
      signal: controller.signal,
    });
  });

  it('rejects mutable host authority and non-plugin callers before the Automation owner', async () => {
    const automationEventAction = vi.fn(async () => ({}));
    const executor = createActionExecutor({
      automationEventAction,
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);

    await expect(executor.execute('automation.event.sources.list', {
      ...sourceListInput,
      accountId: 'caller-controlled-account',
    }, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'com.acme.github' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });

    await expect(executor.execute('automation.event.sources.list', sourceListInput, {
      surface: 'plugin',
      actionCaller: { kind: 'host' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'plugin_action_caller_required',
      error: 'plugin_action_caller_required',
    });
    expect(automationEventAction).not.toHaveBeenCalled();
  });
});
