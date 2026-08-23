import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginActionDangerLevelV2 } from '@happier-dev/protocol';

import { createTargetActionExecutor } from './actionExecutor';
import { createUnavailablePluginInvocationServiceBinding } from './services/factory';
import { projectPluginFailureText } from '../lifecycle/utils';

function resolved(dangerLevel: PluginActionDangerLevelV2 = 'safe') {
  return {
    qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', generation: '7',
    dangerLevel, scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { value: 'x' },
    policyFingerprint: 'b'.repeat(64),
  } as const;
}

function authorizationFacts(overrides: Readonly<{
  reviewedPackageIdentity?: string | null;
  desiredGeneration?: string | null;
  appliedGeneration?: string | null;
}> = {}) {
  return {
    packageTrust: {
      packageIdentity: 'acme.alpha/actions/run',
      reviewedPackageIdentity: overrides.reviewedPackageIdentity === undefined
        ? 'acme.alpha/actions/run'
        : overrides.reviewedPackageIdentity,
    },
    generation: {
      targetGeneration: '7',
      desiredGeneration: overrides.desiredGeneration === undefined ? '7' : overrides.desiredGeneration,
      appliedGeneration: overrides.appliedGeneration === undefined ? '7' : overrides.appliedGeneration,
    },
    resourceSelections: [],
    scopedGrants: [],
    operatingSystemAuthorization: [],
  } as const;
}

function createExecutor(
  deps: Omit<Parameters<typeof createTargetActionExecutor>[0], 'resolveHostBinding' | 'resolveAuthorizationFacts'>
    & Partial<Pick<Parameters<typeof createTargetActionExecutor>[0], 'resolveHostBinding' | 'resolveAuthorizationFacts'>>,
) {
  return createTargetActionExecutor({
    resolveAuthorizationFacts: () => authorizationFacts(),
    resolveHostBinding: async (action) => ({
      action,
      serviceBinding: createUnavailablePluginInvocationServiceBinding(action.generation, 'test-binding'),
    }),
    ...deps,
  });
}

describe('target action executor', () => {
  it('settles blocking approval before returning ready and memoizes handler dispatch', async () => {
    let resolveApproval!: (value: Readonly<{ status: 'approved'; fingerprint: string }>) => void;
    const approval = new Promise<Readonly<{ status: 'approved'; fingerprint: string }>>((resolve) => {
      resolveApproval = resolve;
    });
    let approvalFingerprint = '';
    const invoke = vi.fn(async () => ({ status: 'executed' as const, value: { ok: true } }));
    const executor = createExecutor({
      resolve: () => resolved('destructive'),
      requestCurrentIntent: async ({ fingerprint }) => {
        approvalFingerprint = fingerprint;
        return await approval;
      },
      invoke,
    });

    const pendingPreparation = executor.prepare({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    });
    await vi.waitFor(() => expect(approvalFingerprint).not.toBe(''));
    expect(invoke).not.toHaveBeenCalled();
    resolveApproval({ status: 'approved', fingerprint: approvalFingerprint });
    const prepared = await pendingPreparation;
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') throw new Error('expected ready preparation');
    expect(invoke).not.toHaveBeenCalled();
    const first = prepared.run();
    const second = prepared.run();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'executed', value: { ok: true } },
      { status: 'executed', value: { ok: true } },
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('settles rejected blocking approval without returning a runnable handle', async () => {
    const invoke = vi.fn();
    const executor = createExecutor({
      resolve: () => resolved('destructive'),
      requestCurrentIntent: async () => ({
        status: 'rejected',
        code: 'plugin_action_current_intent_rejected',
      }),
      invoke,
    });

    await expect(executor.prepare({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({
      kind: 'settled',
      result: { status: 'unavailable', code: 'plugin_action_current_intent_rejected' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('resolves explicit authorization facts again after current-intent approval', async () => {
    let appliedGeneration = '7';
    const invoke = vi.fn(async () => ({ status: 'executed' as const, value: null }));
    const resolveAuthorizationFacts = vi.fn(() => authorizationFacts({ appliedGeneration }));
    const executor = createExecutor({
      resolve: () => resolved('destructive'),
      resolveAuthorizationFacts,
      requestCurrentIntent: async ({ fingerprint }) => {
        appliedGeneration = '6';
        return { status: 'approved', fingerprint };
      },
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({
      status: 'unavailable', code: 'plugin_action_generation_not_applied',
    });
    expect(resolveAuthorizationFacts).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not prompt for a safe no-access action and invokes exactly once', async () => {
    const requestCurrentIntent = vi.fn();
    const invoke = vi.fn(async () => ({ status: 'executed' as const, value: { ok: true } }));
    const executor = createExecutor({ resolve: () => resolved(), requestCurrentIntent, invoke });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
      .resolves.toEqual({ status: 'executed', value: { ok: true } });
    expect(requestCurrentIntent).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['writesLocal', 'writesRemote', 'externalSideEffect', 'destructive'] satisfies PluginActionDangerLevelV2[])('binds %s confirmation and re-evaluates before one invocation', async (dangerLevel) => {
    let generation = '7';
    const requestCurrentIntent = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({ status: 'approved' as const, fingerprint }));
    const invoke = vi.fn(async () => ({ status: 'executed' as const, value: null }));
    const executor = createExecutor({
      resolve: () => resolved(dangerLevel),
      resolveAuthorizationFacts: () => authorizationFacts({ desiredGeneration: generation, appliedGeneration: generation }),
      requestCurrentIntent, invoke,
    });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'executed' });
    expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects prompt reuse and stale generation without invocation', async () => {
    let generation = '7';
    const invoke = vi.fn();
    const executor = createExecutor({
      resolve: () => resolved('destructive'),
      resolveAuthorizationFacts: () => authorizationFacts({ desiredGeneration: generation, appliedGeneration: generation }),
      requestCurrentIntent: async ({ fingerprint }) => { generation = '8'; return { status: 'approved', fingerprint }; },
      invoke,
    });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'unavailable' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects when the host binding changes after approval', async () => {
    let selection = 'account-1';
    const invoke = vi.fn();
    const executor = createExecutor({
      resolve: () => resolved('writesRemote'),
      resolveHostBinding: async (action) => ({
        action: { ...action, accountId: selection },
        serviceBinding: createUnavailablePluginInvocationServiceBinding(action.generation, `binding-${selection}`),
      }),
      requestCurrentIntent: async ({ fingerprint }) => { selection = 'account-2'; return { status: 'approved', fingerprint }; },
      invoke,
    });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects when a dynamically resolved HostAccess scope changes after approval', async () => {
    let requestFingerprint = 'scope-one';
    const invoke = vi.fn();
    const executor = createExecutor({
      resolve: () => resolved('writesRemote'),
      resolveHostBinding: async (action) => ({
        action: {
          ...action,
          hostAccess: [{
            id: 'api',
            required: true,
            status: 'available' as const,
            requestFingerprint,
          }],
        },
        serviceBinding: createUnavailablePluginInvocationServiceBinding(action.generation, 'binding'),
      }),
      requestCurrentIntent: async ({ fingerprint }) => {
        requestFingerprint = 'scope-two';
        return { status: 'approved', fingerprint };
      },
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes only the twice-resolved current service binding to invocation', async () => {
    let binding = 'first';
    const invoke = vi.fn(async (_action, _args, serviceBinding) => ({
      status: 'executed' as const,
      value: serviceBinding.id,
    }));
    const executor = createExecutor({
      resolve: () => resolved('writesRemote'),
      resolveHostBinding: async (action) => ({
        action,
        serviceBinding: createUnavailablePluginInvocationServiceBinding(action.generation, binding),
      }),
      requestCurrentIntent: async ({ fingerprint }) => {
        binding = 'second';
        return { status: 'approved', fingerprint };
      },
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'executed', value: 'second' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects a service binding issued for another generation', async () => {
    const invoke = vi.fn();
    const executor = createExecutor({
      resolve: () => resolved(),
      resolveHostBinding: async (action) => ({
        action,
        serviceBinding: createUnavailablePluginInvocationServiceBinding('8', 'stale-binding'),
      }),
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_generation_retired' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects when the host cannot resolve a required selection', async () => {
    const invoke = vi.fn();
    const executor = createExecutor({
      resolve: () => resolved(),
      resolveHostBinding: async () => null,
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_selection_unavailable' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('marks only failures proved before target handler invocation', async () => {
    const missingInvoke = vi.fn();
    const missing = createExecutor({
      resolve: () => null,
      invoke: missingInvoke,
    });

    await expect(missing.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_action_handler_missing',
      message: 'plugin_action_handler_missing',
      actionHandlerInvocation: 'notStarted',
    });
    expect(missingInvoke).not.toHaveBeenCalled();

    const invoked = createExecutor({
      resolve: () => resolved(),
      invoke: async () => {
        throw new Error('transport failed after handler entry');
      },
    });
    const result = await invoked.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    });

    expect(result).toEqual({
      status: 'failed',
      code: 'plugin_action_execution_failed',
      message: 'transport failed after handler entry',
    });
    expect(result).not.toHaveProperty('actionHandlerInvocation');
  });

  it('rejects an action when its referenced optional host resource is unselected', async () => {
    const invoke = vi.fn(async () => ({ status: 'executed' as const, value: null }));
    const executor = createExecutor({
      resolve: () => resolved(),
      resolveHostBinding: async (action) => ({
        action: {
          ...action,
          hostAccess: [{
            id: 'selected-mcp',
            required: false,
            status: 'denied' as const,
            code: 'plugin_host_access_resource_not_selected',
            requestFingerprint: 'selected-mcp-scope',
          }],
        },
        serviceBinding: createUnavailablePluginInvocationServiceBinding(action.generation, 'unselected-binding'),
      }),
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_host_access_resource_not_selected',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('preserves a coded stale-generation failure from final host binding', async () => {
    const invoke = vi.fn();
    const executor = createExecutor({
      resolve: () => resolved(),
      resolveHostBinding: async () => {
        throw new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
      },
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toEqual({
      status: 'failed',
      code: 'plugin_generation_stale',
      message: 'Plugin generation is stale',
      actionHandlerInvocation: 'notStarted',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('emits failure-isolated diagnostics for pre-invocation denial', async () => {
    const diagnostic = vi.fn(async () => { throw new Error('sink offline'); });
    const executor = createExecutor({ resolve: () => resolved('destructive'), invoke: vi.fn(), diagnostic });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'ui' }))
      .resolves.toMatchObject({ status: 'unavailable' });
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ qualifiedId: 'acme.alpha/actions/run', status: 'unavailable' }));
  });

  it('normalizes requester rejection, cancellation, and invocation throws without escaping the final owner', async () => {
    const invoke = vi.fn(async () => { throw new Error('handler escaped'); });
    const requesterFailure = createExecutor({
      resolve: () => resolved('destructive'), invoke,
      requestCurrentIntent: async () => { throw new Error('presenter offline'); },
    });
    await expect(requesterFailure.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
    expect(invoke).not.toHaveBeenCalled();

    const aborted = new AbortController();
    const cancellation = createExecutor({
      resolve: () => resolved('destructive'), invoke,
      requestCurrentIntent: async () => { aborted.abort('caller stopped'); throw new Error('caller stopped'); },
    });
    await expect(cancellation.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli', signal: aborted.signal }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_aborted' });

    const invocationFailure = createExecutor({
      resolve: () => resolved(), invoke,
    });
    await expect(invocationFailure.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'failed', code: 'plugin_action_execution_failed' });
  });

  it('projects only the canonical failure fields when an invocation returns richer metadata', async () => {
    const cause = new Error('provider credential is secret');
    const richFailure = Object.freeze({
      status: 'failed' as const,
      code: 'fixture_provider_failed',
      message: 'provider credential is secret',
      retryable: true,
      // Author vocabulary belongs inside the canonical `data` payload. These
      // top-level copies are not the contract and never reach a caller.
      details: { credential: 'secret' },
      remediation: { kind: 'reauthenticate' },
      diagnostics: [{ code: 'fixture_diagnostic' }],
      cause,
    });
    const executor = createExecutor({
      resolve: () => resolved(),
      invoke: async () => richFailure,
    });

    const result = await executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    });

    expect(result).toEqual({
      status: 'failed',
      code: 'fixture_provider_failed',
      message: 'provider credential is secret',
      retryable: true,
    });
    expect(result).not.toBe(richFailure);
    expect(result).not.toHaveProperty('cause');
  });

  it('carries a canonical failure payload and redacts its scoped secrets in place', async () => {
    // The invocation credential redactor is the same user-secret boundary that
    // already owns the failure code and message. A published payload crosses
    // to the caller, but not as an unredacted route out of that invocation.
    const executor = createExecutor({
      resolve: () => resolved(),
      invoke: async () => ({
        status: 'failed' as const,
        code: 'fixture_provider_failed',
        message: 'provider rejected the publish',
        retryable: true,
        data: {
          name: 'PluginError',
          code: 'fixture_provider_failed',
          details: {
            authorization: 'Bearer scoped-secret',
            attempts: 2,
            trace: ['scoped-secret', null],
          },
        },
      }),
      redactFailureText: (_action, value) => value.replaceAll('scoped-secret', '[redacted]'),
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toEqual({
      status: 'failed',
      code: 'fixture_provider_failed',
      message: 'provider rejected the publish',
      retryable: true,
      data: {
        name: 'PluginError',
        code: 'fixture_provider_failed',
        details: {
          authorization: 'Bearer [redacted]',
          attempts: 2,
          trace: ['[redacted]', null],
        },
      },
    });
  });

  it('withholds only the failure payload when scoped redaction is unavailable', async () => {
    const executor = createExecutor({
      resolve: () => resolved(),
      invoke: async () => ({
        status: 'failed' as const,
        code: 'fixture_provider_failed',
        message: 'provider rejected the publish',
        retryable: false,
        data: { name: 'PluginError', code: 'fixture_provider_failed' },
      }),
      redactFailureText: () => {
        throw new Error('redactor unavailable');
      },
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toEqual({
      status: 'failed',
      code: 'plugin_action_execution_failed',
      message: 'plugin_action_execution_failed',
      retryable: false,
    });
  });

  it('uses the stable failure code when diagnostic redaction fails', async () => {
    const executor = createExecutor({
      resolve: () => resolved(),
      invoke: async () => {
        throw new Error('plugin-controlled failure detail');
      },
      redactFailureText: () => {
        throw new Error('redactor unavailable');
      },
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha',
      localId: 'run',
      input: {},
      surface: 'cli',
    })).resolves.toEqual({
      status: 'failed',
      code: 'plugin_action_execution_failed',
      message: 'plugin_action_execution_failed',
    });
  });

  it('projects scoped target-action failure text through the bounded diagnostics owner', async () => {
    const scopedMessage = `scoped failure ${'🚫'.repeat(700)}`;
    const executor = createExecutor({
      resolve: () => resolved(),
      invoke: async () => {
        throw new Error('unredacted provider failure');
      },
      redactFailureText: (_action, value) => (
        value === 'plugin_action_execution_failed' ? value : scopedMessage
      ),
    });

    const result = await executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    });

    if (result.status !== 'failed') throw new Error('Expected target-action failure');
    expect(result).toEqual({
      status: 'failed',
      code: 'plugin_action_execution_failed',
      message: projectPluginFailureText(new Error(scopedMessage)),
    });
    expect(new TextEncoder().encode(result.message).byteLength).toBeLessThanOrEqual(2_048);
  });

  it('falls back when a scoped failure code is not a bounded stable taxonomy', async () => {
    const executor = createExecutor({
      resolve: () => resolved(),
      invoke: async () => ({
        status: 'failed' as const,
        code: `provider.${'x'.repeat(120)}`,
        message: 'provider failure',
      }),
      redactFailureText: (_action, value) => value,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({
      status: 'failed',
      code: 'plugin_action_execution_failed',
    });
  });

  it('does not invoke after an explicit current-intent decline', async () => {
    const invoke = vi.fn();
    const executor = createExecutor({
      resolve: () => resolved('destructive'), invoke,
      requestCurrentIntent: async () => ({ status: 'rejected', code: 'plugin_action_current_intent_rejected' }),
    });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_rejected' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not reuse approval after the current Action confirmation changes', async () => {
    let body = 'Events in the history gap are not replayed.';
    const invoke = vi.fn();
    const executor = createExecutor({
      resolve: () => ({
        ...resolved('writesLocal'),
        confirmation: { title: 'Start a new baseline', body },
      }),
      requestCurrentIntent: async ({ fingerprint }) => {
        body = 'A changed confirmation must be approved again.';
        return { status: 'approved', fingerprint };
      },
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({
      status: 'unavailable', code: 'plugin_action_current_intent_mismatch',
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
