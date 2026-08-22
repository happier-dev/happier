import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createAutomationEventActionExecutor,
  createPluginWebhookActionExecutor,
} = vi.hoisted(() => ({
  createAutomationEventActionExecutor: vi.fn(),
  createPluginWebhookActionExecutor: vi.fn(),
}));

vi.mock('@/plugins/runtime/automations/automationEventActionExecutor', () => ({
  createAutomationEventActionExecutor,
}));

vi.mock('@/plugins/runtime/webhooks/pluginWebhookActionExecutor', () => ({
  createPluginWebhookActionExecutor,
}));

import { createCliActionDeps } from './createCliActionDeps';

type AutomationEventAction = NonNullable<
  ReturnType<typeof createCliActionDeps>['automationEventAction']
>;

describe('createCliActionDeps Automation Event bindings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('threads exact materialization and immutable-generation currentness to the Event Action executor', () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const revalidatePluginActionCallerMaterialization = vi.fn(async () => true);
    const revalidatePluginActionCallerImmutableGeneration = vi.fn(async () => true);
    const resolveAutomationEventAdoptedDefinitionSet = vi.fn(() => null);
    createPluginWebhookActionExecutor.mockReturnValue(vi.fn());
    createAutomationEventActionExecutor.mockReturnValue(vi.fn());

    createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      resolveAutomationEventAdoptedDefinitionSet,
      revalidatePluginActionCallerMaterialization,
      revalidatePluginActionCallerImmutableGeneration,
    });

    expect(createPluginWebhookActionExecutor).toHaveBeenCalledWith({
      credentials,
      revalidateCallerMaterialization: revalidatePluginActionCallerMaterialization,
    });
    expect(createAutomationEventActionExecutor).toHaveBeenCalledWith({
      credentials,
      revalidateCallerMaterialization: revalidatePluginActionCallerMaterialization,
      revalidateCallerImmutableGeneration: revalidatePluginActionCallerImmutableGeneration,
      resolveAdoptedDefinitionSet: resolveAutomationEventAdoptedDefinitionSet,
    });
  });

  it('activates Event source Actions only when the runtime supplies the adopted-definition owner', async () => {
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const automationEventAction = vi.fn(async () => ({ kind: 'unchanged', revision: '7' }));
    const resolveAutomationEventAdoptedDefinitionSet = vi.fn(() => null);
    const params: Parameters<typeof createCliActionDeps>[0] & Readonly<{
      resolveAutomationEventAdoptedDefinitionSet: typeof resolveAutomationEventAdoptedDefinitionSet;
    }> = {
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      resolveAutomationEventAdoptedDefinitionSet,
    };

    const { resolveAutomationEventAdoptedDefinitionSet: _withoutOwner, ...withoutOwnerParams } = params;
    expect(createCliActionDeps(withoutOwnerParams).automationEventAction).toBeUndefined();
    expect(createAutomationEventActionExecutor).not.toHaveBeenCalled();

    createAutomationEventActionExecutor.mockReturnValue(automationEventAction);
    const deps = createCliActionDeps(params);

    expect(createAutomationEventActionExecutor).toHaveBeenCalledWith({
      credentials,
      resolveAdoptedDefinitionSet: resolveAutomationEventAdoptedDefinitionSet,
    });
    const listSourcesRequest = {
      actionId: 'automation.event.sources.list',
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 100 },
      caller: { kind: 'plugin', pluginId: 'com.acme.github' },
    } satisfies Parameters<AutomationEventAction>[0];
    await expect(deps.automationEventAction?.(listSourcesRequest)).resolves.toEqual({ kind: 'unchanged', revision: '7' });
    expect(automationEventAction).toHaveBeenCalledWith(listSourcesRequest);
  });
});
