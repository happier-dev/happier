import { describe, expect, it, vi } from 'vitest';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CHANNELS_PLUGIN, PLUGIN_MANIFEST } from '@happier-dev/plugins-channels/manifest';
import type { PluginActionDangerLevelV2 } from '@happier-dev/protocol';

import { createTargetActionExecutor, fingerprintTargetActionPolicy, type ResolvedTargetAction } from './actionExecutor';
import { createUnavailablePluginInvocationServiceBinding } from './services/factory';
import { projectPluginFailureText } from '../lifecycle/utils';
import { createPluginInvocationSecretRedactor } from './services/logger';

function resolved(dangerLevel: PluginActionDangerLevelV2 = 'safe') {
  return {
    qualifiedId: 'acme.alpha/actions/run', pluginId: 'acme.alpha', localId: 'run', occurrenceId: '7',
    sourceCustody: { kind: 'development', registeredRootId: 'acme-alpha-root' },
    dangerLevel, scopes: ['global'], surfaces: ['cli'], hostAccess: [], input: { value: 'x' },
    policyFingerprint: 'b'.repeat(64),
  } as const;
}

it('keeps durable policy identity independent of the process-local occurrence', () => {
  const action = resolved('destructive');
  expect(fingerprintTargetActionPolicy(action)).toBe(fingerprintTargetActionPolicy({
    ...action,
    occurrenceId: '8',
  }));
});

function authorizationFacts(overrides: Readonly<{
  desiredGeneration?: string | null;
  appliedGeneration?: string | null;
}> = {}) {
  return {
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
      serviceBinding: createUnavailablePluginInvocationServiceBinding(action.occurrenceId, 'test-binding'),
    }),
    ...deps,
  });
}

describe('target action executor', () => {
  it('redacts registered values from successful agent results without secret-use declarations', async () => {
    const raw = 'registered-value-"quoted"\nsecond-line';
    const scope = { pluginId: 'acme.alpha', occurrenceId: '7', correlationId: 'success-redaction' };
    const redactor = createPluginInvocationSecretRedactor();
    redactor.beginInvocation(scope, new AbortController().signal);
    redactor.registerRaw(scope, raw);
    const executor = createExecutor({
      resolve: () => ({ ...resolved(), surfaces: ['agent'] }),
      invoke: async () => ({ status: 'executed', value: {
        plain: raw, json: JSON.stringify({ echo: raw }), nested: [{ [raw]: raw }], ordinary: 'visible',
        ['__proto__']: 'ordinary-prototype-key',
      } }),
      redactFailureText: (_action, value) => redactor.redact(scope, value),
    });
    try {
      await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'agent' }))
        .resolves.toEqual({ status: 'executed', value: {
          plain: '[REDACTED]', json: '{"echo":"[REDACTED]"}',
          nested: [{ '[REDACTED]': '[REDACTED]' }], ordinary: 'visible',
          ['__proto__']: 'ordinary-prototype-key',
        } });
    } finally { redactor.completeInvocation(scope); }
  });

  it.each(['same_spec', 'changed_spec', 'changed_input', 'changed_origin', 'changed_authority'] as const)(
    'retains the admitted operand and implementation while later selection changes: %s', async scenario => {
      let adopted = false;
      const invoke = vi.fn(async (_action: ResolvedTargetAction) => ({ status: 'executed' as const, value: 'current implementation' }));
      const receipts: unknown[] = [];
      const executor = createExecutor({
        resolve: () => ({
          ...resolved('writesRemote'),
          occurrenceId: adopted ? '8' : '7',
          pluginVersion: adopted ? '0.0.2' : '0.0.1',
          confirmation: { title: adopted && scenario === 'changed_spec' ? 'Different effect' : 'Run effect' },
          input: { value: adopted && scenario === 'changed_input' ? 'different' : 'original' },
          sourceCustody: { kind: 'development', registeredRootId: adopted && scenario === 'changed_origin' ? 'other-root' : 'original-root' },
          accountId: adopted && scenario === 'changed_authority' ? 'other-account' : 'original-account',
        }),
        resolveAuthorizationFacts: () => ({ ...authorizationFacts(), generation: {
          targetGeneration: adopted ? '8' : '7', desiredGeneration: adopted ? '8' : '7', appliedGeneration: adopted ? '8' : '7',
        } }),
        requestCurrentIntent: async ({ fingerprint }) => {
          adopted = true;
          return { status: 'approved', fingerprint, artifactId: 'authenticated-decision',
            settleExecution: async receipt => { receipts.push(receipt); } };
        },
        invoke,
      });
      const prepared = await executor.prepare({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'original' }, surface: 'cli' });
      expect(prepared.kind).toBe('ready');
      if (prepared.kind !== 'ready') throw new Error('Approved operation was not admitted');
      expect(invoke).not.toHaveBeenCalled();
      await expect(Promise.all([prepared.run(), prepared.run()])).resolves.toEqual([
        { status: 'executed', value: 'current implementation' }, { status: 'executed', value: 'current implementation' },
      ]);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]?.[0]).toMatchObject({ occurrenceId: '7', input: { value: 'original' },
        accountId: 'original-account', sourceCustody: { registeredRootId: 'original-root' } });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ artifactId: 'authenticated-decision', execution: { ok: true, effectAttempted: true } });
    },
  );

  it.each(['agent', 'mcp'] as const)('requests approval for Channels management on %s and dispatches the existing handler once after approval', async (surface) => {
    const localId = 'connection/pairing-cancel-v1';
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    if (!parsed.ok) throw new Error('Channels manifest admission failed.');
    const declaration = normalizePluginManifestV2(parsed.manifest).contributes.actions.find((action) => action.id === localId);
    if (!declaration) throw new Error('Missing Channels pairing cancellation declaration.');
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: CHANNELS_PLUGIN });
    const actionInput = { generationId: 'retired-pairing', challengeId: 'unknown-challenge' };
    let dispatches = 0;
    let approvalFingerprint = '';
    let approvalRequested!: () => void;
    const requestedApproval = new Promise<void>((resolve) => { approvalRequested = resolve; });
    let approve!: (decision: Readonly<{ status: 'approved'; fingerprint: string }>) => void;
    const decision = new Promise<Readonly<{ status: 'approved'; fingerprint: string }>>((resolve) => { approve = resolve; });
    const executor = createExecutor({
      resolve: () => ({
        ...resolved(),
        qualifiedId: `happier.channels/actions/${localId}`,
        pluginId: 'happier.channels', localId,
        dangerLevel: declaration.dangerLevel,
        scopes: declaration.scopes,
        surfaces: declaration.surfaces,
        confirmation: declaration.confirmation,
        input: actionInput,
      }),
      requestCurrentIntent: async ({ fingerprint, invocationSurface }) => {
        expect(invocationSurface).toBe(surface);
        approvalFingerprint = fingerprint;
        approvalRequested();
        return await decision;
      },
      // The host binding is the boundary; the actual Channels activation and
      // registered handler remain real, including its pairing proof checks.
      invoke: async () => {
        dispatches += 1;
        return { status: 'executed', value: await testkit.invokeAction(localId, actionInput, { surface }) };
      },
    });
    const request = { pluginId: 'happier.channels', localId, input: actionInput, surface };
    try {
      const pending = executor.prepare(request);
      await expect(Promise.race([
        requestedApproval.then(() => 'approvalRequested'),
        pending.then((prepared) => prepared.kind),
      ])).resolves.toBe('approvalRequested');
      expect(dispatches).toBe(0);
      approve({ status: 'approved', fingerprint: approvalFingerprint });
      const prepared = await pending;
      if (prepared.kind !== 'ready') throw new Error('Approved Channels management did not become runnable.');
      await expect(Promise.all([prepared.run(), prepared.run()])).resolves.toEqual([
        { status: 'executed', value: { kind: 'notCancelled', reason: 'restarted' } },
        { status: 'executed', value: { kind: 'notCancelled', reason: 'restarted' } },
      ]);
      expect(dispatches).toBe(1);
    } finally {
      await testkit.dispose();
    }
  });

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

  it('retains authorization facts admitted before approval without another lookup', async () => {
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
      status: 'executed', value: null,
    });
    expect(resolveAuthorizationFacts).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
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

  it.each(['writesLocal', 'writesRemote', 'externalSideEffect', 'destructive'] satisfies PluginActionDangerLevelV2[])('binds %s confirmation before one invocation', async (dangerLevel) => {
    let generation = '7';
    const requestCurrentIntent = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({ status: 'approved' as const, fingerprint }));
    const invoke = vi.fn(async () => ({ status: 'executed' as const, value: null }));
    const executor = createExecutor({
      resolve: () => ({ ...resolved(dangerLevel), confirmation: { title: 'Run effect' }, approvalRequiredByActionSettings: true }),
      resolveAuthorizationFacts: () => authorizationFacts({ desiredGeneration: generation, appliedGeneration: generation }),
      requestCurrentIntent, invoke,
    });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: { value: 'x' }, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'executed' });
    expect(requestCurrentIntent).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps admitted generation facts when selection changes during approval', async () => {
    let generation = '7';
    const invoke = vi.fn(async () => ({ status: 'executed' as const, value: null }));
    const executor = createExecutor({
      resolve: () => resolved('destructive'),
      resolveAuthorizationFacts: () => authorizationFacts({ desiredGeneration: generation, appliedGeneration: generation }),
      requestCurrentIntent: async ({ fingerprint }) => { generation = '8'; return { status: 'approved', fingerprint }; },
      invoke,
    });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'executed', value: null });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('keeps the admitted host binding when later selection changes', async () => {
    let selection = 'account-1';
    const invoke = vi.fn(async (action: ResolvedTargetAction) => ({ status: 'executed' as const, value: action.accountId ?? null }));
    const executor = createExecutor({
      resolve: () => resolved('writesRemote'),
      resolveHostBinding: async (action) => ({
        action: { ...action, accountId: selection },
        serviceBinding: createUnavailablePluginInvocationServiceBinding(action.occurrenceId, `binding-${selection}`),
      }),
      requestCurrentIntent: async ({ fingerprint }) => { selection = 'account-2'; return { status: 'approved', fingerprint }; },
      invoke,
    });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'executed', value: 'account-1' });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('keeps the admitted HostAccess scope when later resolution changes', async () => {
    let requestFingerprint = 'scope-one';
    const invoke = vi.fn(async (action: ResolvedTargetAction) => ({ status: 'executed' as const,
      value: action.hostAccess[0]?.requestFingerprint ?? null }));
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
        serviceBinding: createUnavailablePluginInvocationServiceBinding(action.occurrenceId, 'binding'),
      }),
      requestCurrentIntent: async ({ fingerprint }) => {
        requestFingerprint = 'scope-two';
        return { status: 'approved', fingerprint };
      },
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'executed', value: 'scope-one' });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('passes the originally admitted service binding to invocation', async () => {
    let binding = 'first';
    const invoke = vi.fn(async (_action, _args, serviceBinding) => ({
      status: 'executed' as const,
      value: serviceBinding.id,
    }));
    const executor = createExecutor({
      resolve: () => resolved('writesRemote'),
      resolveHostBinding: async (action) => ({
        action,
        serviceBinding: createUnavailablePluginInvocationServiceBinding(action.occurrenceId, binding),
      }),
      requestCurrentIntent: async ({ fingerprint }) => {
        binding = 'second';
        return { status: 'approved', fingerprint };
      },
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toMatchObject({ status: 'executed', value: 'first' });
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
        serviceBinding: createUnavailablePluginInvocationServiceBinding(action.occurrenceId, 'unselected-binding'),
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
    const error = new PluginError({ code: 'plugin_generation_stale', message: 'Plugin generation is stale' });
    const executor = createExecutor({
      resolve: () => resolved(),
      resolveHostBinding: async () => {
        throw error;
      },
      invoke,
    });

    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toEqual({
      status: 'failed',
      code: 'plugin_generation_stale',
      message: 'Plugin generation is stale',
      retryable: false,
      data: error.data,
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
    // A requester exception is a typed not-started failure, not a missing requester.
    await expect(requesterFailure.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'failed', code: 'plugin_action_execution_failed' });
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

  it.each(['resolve', 'resolveHostBinding'] as const)('retains typed cause data when %s throws before invocation', async phase => {
    const nativeCause = { httpStatusClass: '4xx', code: 'forbidden' } as const;
    const error = new PluginError({ code: 'provider_request_rejected', details: { nativeCause } });
    const executor = createExecutor({ resolve: () => resolved(),
      invoke: async () => { throw new Error('Admission failure must not invoke the handler'); },
      ...(phase === 'resolve' ? { resolve: () => { throw error; } }
        : { resolveHostBinding: async () => { throw error; } }),
    });
    await expect(executor.execute({ pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli' }))
      .resolves.toMatchObject({ status: 'failed', code: 'provider_request_rejected', retryable: false,
        data: { code: 'provider_request_rejected', details: { nativeCause } } });
  });

  it('retains thrown native PluginError codes and causes through the final invocation boundary', async () => {
    const nativeCause = { httpStatusClass: '4xx', code: 'forbidden' } as const;
    const error = new PluginError({ code: 'native_access_refused', retryable: false,
      details: { nativeCause, privateResponse: 'scoped-secret' } });
    const executor = createExecutor({
      resolve: () => resolved(),
      invoke: async () => { throw error; },
      redactFailureText: (_action, value) => value.replaceAll('scoped-secret', '[redacted]'),
    });
    await expect(executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    })).resolves.toEqual({ status: 'failed', code: 'native_access_refused', message: 'native_access_refused',
      retryable: false, data: { name: 'PluginError', code: 'native_access_refused', retryable: false,
        details: { nativeCause, privateResponse: '[redacted]' } } });
  });

  it('redacts admitted deeply nested failure data without falling back to a recursive privacy projection', async () => {
    let data: JsonValue = 'scoped-secret';
    const depth = 12_000;
    for (let index = 0; index < depth; index += 1) {
      data = [data];
    }
    const executor = createExecutor({
      resolve: () => resolved(),
      invoke: async () => ({
        status: 'failed' as const,
        code: 'fixture_provider_failed',
        message: 'provider rejected the publish',
        data,
      }),
      redactFailureText: (_action, value) => value.replaceAll('scoped-secret', '[redacted]'),
    });

    const result = await executor.execute({
      pluginId: 'acme.alpha', localId: 'run', input: {}, surface: 'cli',
    });

    expect(result).toMatchObject({
      status: 'failed',
      code: 'fixture_provider_failed',
    });
    if (result.status !== 'failed') throw new Error('Expected target-action failure');
    let projected = result.data;
    for (let index = 0; index < depth; index += 1) {
      if (!Array.isArray(projected)) throw new Error('Expected a preserved nested failure payload');
      projected = projected[0];
    }
    expect(projected).toBe('[redacted]');
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

  it('retains ordinary scoped target-action failure text through the diagnostics owner', async () => {
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
    expect(result.message).toBe(scopedMessage);
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

  it('retains the reviewed operation when confirmation copy later changes', async () => {
    let body = 'Events in the history gap are not replayed.';
    const invoke = vi.fn(async () => ({ status: 'executed' as const, value: null }));
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
      status: 'executed', value: null,
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
