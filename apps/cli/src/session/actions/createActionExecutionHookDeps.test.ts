import { describe, expect, it, vi } from 'vitest';
import {
  ActionExecuteAfterHookPayloadSchema,
  ActionExecuteBeforeHookPayloadSchema,
} from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({
  intercept: vi.fn(),
  observe: vi.fn(),
  release: vi.fn(async () => {}),
  tryAcquireLease: vi.fn(),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  tryAcquireAuthoritativePluginRuntimeRegistryLease: mocks.tryAcquireLease,
}));
vi.mock('@/plugins/runtime/hooks/execution/dispatchExecutionInterceptionHooks', () => ({
  interceptActionExecutionThroughRuntimeRegistry: mocks.intercept,
  observeActionExecutionThroughRuntimeRegistry: mocks.observe,
}));

import { createActionExecutionHookDeps } from './createActionExecutionHookDeps';

describe('createActionExecutionHookDeps', () => {
  it('projects a full internal plugin caller to the strict public caller shape for before and after hooks', async () => {
    let beforePayload: unknown;
    let afterPayload: unknown;
    mocks.tryAcquireLease.mockReturnValue({
      registry: {} as never,
      release: mocks.release,
    });
    mocks.intercept.mockImplementation(async (params: Readonly<{ payload: unknown }>) => {
      const { payload } = params;
      beforePayload = payload;
      // Strict parsing is the public ABI boundary: extra authority must fail.
      const parsed = ActionExecuteBeforeHookPayloadSchema.parse(payload);
      return { status: 'continue', input: parsed.input };
    });
    mocks.observe.mockImplementation(async (params: Readonly<{ payload: unknown }>) => {
      const { payload } = params;
      afterPayload = payload;
      ActionExecuteAfterHookPayloadSchema.parse(payload);
    });

    const fullCaller = {
      kind: 'plugin' as const,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
      materialization: {
        pluginId: 'acme.channels',
        machineId: 'machine-1',
        materializationId: 'materialization-current',
      },
    };
    const context = {
      surface: 'plugin' as const,
      defaultSessionId: 'session-1',
      actionCaller: fullCaller,
    };
    const deps = createActionExecutionHookDeps();
    if (!deps.interceptActionExecution || !deps.observeActionExecution) {
      throw new Error('expected Action hook dependencies');
    }

    await expect(deps.interceptActionExecution({
      actionId: 'session.title.set',
      input: { sessionId: 'session-1', title: 'Updated' },
      context,
      caller: fullCaller,
    })).resolves.toEqual({
      status: 'continue',
      input: { sessionId: 'session-1', title: 'Updated' },
    });
    await deps.observeActionExecution({
      actionId: 'session.title.set',
      input: { sessionId: 'session-1', title: 'Updated' },
      context,
      caller: fullCaller,
      result: { ok: true, result: { updated: true } },
    });

    for (const payload of [beforePayload, afterPayload]) {
      expect(payload).toEqual(expect.objectContaining({
        invocation: expect.objectContaining({
          caller: { kind: 'plugin', pluginId: 'acme.channels' },
        }),
      }));
      const caller = (payload as { invocation: { caller: Record<string, unknown> } }).invocation.caller;
      expect(caller).not.toHaveProperty('contributionLocalId');
      expect(caller).not.toHaveProperty('materialization');
    }
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('preserves the api surface in before and after hook payloads', async () => {
    const observedSurfaces: string[] = [];
    mocks.tryAcquireLease.mockReturnValue({
      registry: {} as never,
      release: mocks.release,
    });
    mocks.intercept.mockImplementation(async (params: Readonly<{ payload: unknown }>) => {
      const parsed = ActionExecuteBeforeHookPayloadSchema.parse(params.payload);
      observedSurfaces.push(parsed.invocation.surface);
      return { status: 'continue', input: parsed.input };
    });
    mocks.observe.mockImplementation(async (params: Readonly<{ payload: unknown }>) => {
      const parsed = ActionExecuteAfterHookPayloadSchema.parse(params.payload);
      observedSurfaces.push(parsed.invocation.surface);
    });
    const deps = createActionExecutionHookDeps();
    if (!deps.interceptActionExecution || !deps.observeActionExecution) {
      throw new Error('expected Action hook dependencies');
    }
    const context = {
      surface: 'api' as const,
      authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const },
    };

    await deps.interceptActionExecution({
      actionId: 'machines.list',
      input: {},
      context,
      caller: context.actionCaller,
    });
    await deps.observeActionExecution({
      actionId: 'machines.list',
      input: {},
      context,
      caller: context.actionCaller,
      result: { ok: true, result: { machines: [] } },
    });

    expect(observedSurfaces).toEqual(['api', 'api']);
  });
});
