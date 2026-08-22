import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1,
} from '../../runtime/agentSessionLimitsV1.js';
import {
  PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE,
  createPluginActionInvocation,
  createPluginActionPresentUserGate,
  projectPluginActionUnavailableOutcomeCode,
} from './invocation.js';

function currentIntentAuthorizationFacts(generation = '7') {
  return {
    packageTrust: {
      packageIdentity: 'acme.action/actions/commit',
      reviewedPackageIdentity: 'acme.action/actions/commit',
    },
    generation: {
      targetGeneration: generation,
      desiredGeneration: generation,
      appliedGeneration: generation,
    },
    resourceSelections: [],
    scopedGrants: [],
    serviceAvailability: [],
    operatingSystemAuthorization: [],
  } as const;
}

function currentIntentResolution(generation = '7') {
  return {
    status: 'resolved' as const,
    action: Object.freeze({ generation }),
    policy: Object.freeze({
      qualifiedId: 'acme.action/actions/commit',
      generation,
      dangerLevel: 'writesRemote' as const,
      scopes: Object.freeze(['global']),
      surfaces: Object.freeze(['ui']),
      confirmation: Object.freeze({ title: 'Commit action' }),
      authorization: currentIntentAuthorizationFacts(generation),
      fingerprintContext: Object.freeze({ accountId: 'account-1' }),
    }),
  };
}

function createInvocation(params: Readonly<{
  generationSignal?: AbortSignal;
  isCurrent?: () => boolean;
  inputSchema?: object;
}> = {}) {
  return createPluginActionInvocation({
    pluginId: 'acme.action',
    localId: 'commit',
    generationSignal: params.generationSignal ?? new AbortController().signal,
    isCurrent: params.isCurrent ?? (() => true),
    ...(params.inputSchema === undefined ? {} : { inputSchema: params.inputSchema }),
  });
}

describe('createPluginActionInvocation', () => {
  it('projects only an unproved unavailable cancellation or retirement to outcome unknown', () => {
    expect(projectPluginActionUnavailableOutcomeCode(
      'plugin_action_aborted',
      undefined,
    )).toBe(PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE);
    expect(projectPluginActionUnavailableOutcomeCode(
      'plugin_action_generation_retired',
      undefined,
    )).toBe(PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE);
    expect(projectPluginActionUnavailableOutcomeCode(
      'plugin_action_aborted',
      'notStarted',
    )).toBe('plugin_action_aborted');
    expect(projectPluginActionUnavailableOutcomeCode(
      'plugin_action_generation_retired',
      'notStarted',
    )).toBe('plugin_action_generation_retired');
    expect(projectPluginActionUnavailableOutcomeCode(
      'plugin_action_current_intent_rejected',
      undefined,
    )).toBe('plugin_action_current_intent_rejected');
  });

  it('prompts once for a non-safe client Action and admits only its freshly resolved policy', async () => {
    const present = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({
      status: 'approved' as const,
      fingerprint,
    }));
    const resolve = vi.fn(() => currentIntentResolution());
    const gate = createPluginActionPresentUserGate({ resolve, requestCurrentIntent: present });

    await expect(gate.admit({
      input: { title: 'ship it' },
      surface: 'ui',
      invocationSurface: 'ui',
    })).resolves.toMatchObject({
      status: 'admitted',
      action: { generation: '7' },
    });

    expect(present).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(present).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'ui',
      invocationSurface: 'ui',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('does not admit a rejected or retired present-user Action', async () => {
    const rejected = createPluginActionPresentUserGate({
      resolve: () => currentIntentResolution(),
      requestCurrentIntent: async () => ({
        status: 'rejected' as const,
        code: 'plugin_action_current_intent_rejected',
      }),
    });
    await expect(rejected.admit({
      input: null,
      surface: 'ui',
      invocationSurface: 'ui',
    })).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_current_intent_rejected',
    });

    let current = true;
    const retired = createPluginActionPresentUserGate({
      resolve: () => current
        ? {
          ...currentIntentResolution(),
          isCurrent: () => current,
        }
        : {
          status: 'unavailable' as const,
          code: 'plugin_action_generation_retired',
        },
      requestCurrentIntent: async ({ fingerprint }: Readonly<{ fingerprint: string }>) => {
        current = false;
        return { status: 'approved' as const, fingerprint };
      },
    });
    await expect(retired.admit({
      input: null,
      surface: 'ui',
      invocationSurface: 'ui',
    })).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_generation_retired',
    });
  });

  it('rejects SDK byte ceilings and unsafe integers before Action dispatch', async () => {
    const invocation = createInvocation({
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', 'x-happier-max-utf8-bytes': 4 },
          payload: { 'x-happier-max-serialized-utf8-bytes': 6 },
          sequence: {
            type: 'integer',
            minimum: Number.MIN_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
        required: ['title', 'payload', 'sequence'],
        additionalProperties: false,
      },
    });
    const handler = vi.fn(() => ({ accepted: true }));

    await expect(invocation.invoke({
      title: 'éé',
      payload: 'éé',
      sequence: Number.MAX_SAFE_INTEGER,
    }, { handler })).resolves.toEqual({ status: 'executed', value: { accepted: true } });

    for (const input of [
      { title: 'ééé', payload: 'éé', sequence: 1 },
      { title: 'éé', payload: 'ééé', sequence: 1 },
      { title: 'éé', payload: 'éé', sequence: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(invocation.invoke(input, { handler })).resolves.toMatchObject({
        status: 'invalid',
        code: 'plugin_action_input_schema_invalid',
      });
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs host pre-dispatch only after input-schema admission and preserves its unavailable result', async () => {
    const invocation = createInvocation({
      inputSchema: {
        type: 'object',
        properties: { credentialRef: { type: 'string' } },
        required: ['credentialRef'],
        additionalProperties: false,
      },
    });
    const preDispatch = vi.fn(() => Object.freeze({
      status: 'unavailable' as const,
      code: 'plugin_action_form_connected_account_options_unavailable',
      message: 'The selected Connected Account is no longer available for this Action form',
    }));
    const handler = vi.fn(() => ({ committed: true }));

    await expect(invocation.invoke({ credentialRef: 'account-1' }, {
      preDispatch,
      handler,
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_action_form_connected_account_options_unavailable',
      message: 'The selected Connected Account is no longer available for this Action form',
      actionHandlerInvocation: 'notStarted',
    });
    expect(preDispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: { credentialRef: 'account-1' },
      qualifiedId: 'acme.action/actions/commit',
      signal: expect.any(AbortSignal),
    }));
    expect(handler).not.toHaveBeenCalled();

    preDispatch.mockClear();
    await expect(invocation.invoke({}, { preDispatch, handler })).resolves.toMatchObject({
      status: 'invalid',
      code: 'plugin_action_input_schema_invalid',
    });
    expect(preDispatch).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not enter the handler when caller cancellation wins during host pre-dispatch', async () => {
    const caller = new AbortController();
    const preDispatch = vi.fn(() => new Promise<never>(() => {}));
    const handler = vi.fn(() => ({ committed: true }));
    const pending = createInvocation().invoke(null, {
      signal: caller.signal,
      preDispatch,
      handler,
    });
    expect(preDispatch).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();

    caller.abort(new Error('caller stopped before action dispatch'));

    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_aborted',
      actionHandlerInvocation: 'notStarted',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('proves non-start when cancellation arrives after pre-dispatch but before handler entry', async () => {
    const caller = new AbortController();
    const handler = vi.fn(() => ({ committed: true }));

    await expect(createInvocation().invoke(null, {
      signal: caller.signal,
      preDispatch: () => {
        caller.abort(new Error('caller stopped after admission'));
        return null;
      },
      handler,
    })).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_aborted',
      actionHandlerInvocation: 'notStarted',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps a synchronous non-thenable handler result after same-turn caller cancellation', async () => {
    const caller = new AbortController();
    const handler = vi.fn(() => ({ committed: true }));
    const invocation = createInvocation();

    const pending = invocation.invoke(null, { signal: caller.signal, handler });
    expect(handler).toHaveBeenCalledOnce();

    caller.abort(new Error('caller stopped'));

    await expect(pending).resolves.toEqual({ status: 'executed', value: { committed: true } });
  });

  it('keeps a deferred handler fulfillment that settles before same-turn caller cancellation', async () => {
    const caller = new AbortController();
    let resolveHandler!: (value: { committed: true }) => void;
    const handler = vi.fn(() => new Promise<{ committed: true }>((resolve) => {
      resolveHandler = resolve;
    }));
    const pending = createInvocation().invoke(null, { signal: caller.signal, handler });
    expect(handler).toHaveBeenCalledOnce();

    resolveHandler({ committed: true });
    caller.abort(new Error('caller stopped'));

    await expect(pending).resolves.toEqual({ status: 'executed', value: { committed: true } });
  });

  it('keeps a known handler fulfillment authoritative when its generation retires immediately later', async () => {
    const generation = new AbortController();
    let current = true;
    let resolveHandler!: (value: { committed: true }) => void;
    const handler = vi.fn(() => new Promise<{ committed: true }>((resolve) => {
      resolveHandler = resolve;
    }));
    const pending = createInvocation({
      generationSignal: generation.signal,
      isCurrent: () => current,
    }).invoke(null, { handler });
    expect(handler).toHaveBeenCalledOnce();

    // The handler's fulfillment is known before the registration/generation
    // retires. Rewriting it as unavailable would invite a blind retry.
    resolveHandler({ committed: true });
    current = false;
    generation.abort(new Error('generation retired after handler fulfillment'));

    await expect(pending).resolves.toEqual({ status: 'executed', value: { committed: true } });
  });

  it('keeps a canonical non-retryable handler failure when its generation retires immediately after settlement', async () => {
    const generation = new AbortController();
    let current = true;
    const committedFailure = Object.assign(new Error('the effect committed but the provider rejected it'), {
      name: 'PluginError',
      code: 'fixture_effect_committed_failure',
      retryable: false,
      data: {
        name: 'PluginError',
        code: 'fixture_effect_committed_failure',
        message: 'the effect committed but the provider rejected it',
        retryable: false,
      },
    });
    const pending = createInvocation({
      generationSignal: generation.signal,
      isCurrent: () => current,
    }).invoke(null, {
      handler: () => {
        // The rejection settles first. This queued retirement exposes the old
        // post-settlement reclassification without making cancellation win the
        // handler race.
        queueMicrotask(() => {
          current = false;
          generation.abort(new Error('generation retired after target settlement'));
        });
        throw committedFailure;
      },
    });

    await expect(pending).resolves.toEqual({
      status: 'failed',
      code: 'fixture_effect_committed_failure',
      message: 'the effect committed but the provider rejected it',
      retryable: false,
      data: {
        name: 'PluginError',
        code: 'fixture_effect_committed_failure',
        message: 'the effect committed but the provider rejected it',
        retryable: false,
      },
    });
  });

  it('keeps caller cancellation that settles before a deferred handler fulfillment', async () => {
    const caller = new AbortController();
    let resolveHandler!: (value: { committed: true }) => void;
    const handler = vi.fn(() => new Promise<{ committed: true }>((resolve) => {
      resolveHandler = resolve;
    }));
    const pending = createInvocation().invoke(null, { signal: caller.signal, handler });
    expect(handler).toHaveBeenCalledOnce();

    caller.abort(new Error('caller stopped'));
    resolveHandler({ committed: true });

    await expect(pending).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_action_aborted',
      message: 'Plugin action invocation was aborted',
    });
  });

  it('keeps cancellation during synchronous handler entry terminal over an already-settled Promise', async () => {
    const caller = new AbortController();
    const handler = vi.fn(() => {
      caller.abort(new Error('caller stopped during handler entry'));
      return Promise.resolve({ committed: true });
    });
    const pending = createInvocation().invoke(null, { signal: caller.signal, handler });

    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_aborted',
    });
  });

  it('observes a deferred handler rejection after caller cancellation wins', async () => {
    const caller = new AbortController();
    let rejectHandler!: (error: Error) => void;
    const handler = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectHandler = reject;
    }));
    const pending = createInvocation().invoke(null, { signal: caller.signal, handler });
    expect(handler).toHaveBeenCalledOnce();

    caller.abort(new Error('caller stopped'));
    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_aborted',
    });

    rejectHandler(new Error('late handler rejection'));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('keeps caller cancellation terminal when generation retires later in the same turn', async () => {
    const caller = new AbortController();
    const generation = new AbortController();
    const handler = vi.fn(() => new Promise<never>(() => {}));
    const pending = createInvocation({ generationSignal: generation.signal }).invoke(null, {
      signal: caller.signal,
      handler,
    });
    expect(handler).toHaveBeenCalledOnce();

    caller.abort(new Error('caller stopped'));
    generation.abort(new Error('generation retired'));

    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_aborted',
    });
  });

  it('keeps generation retirement terminal when it precedes caller cancellation in the same turn', async () => {
    const caller = new AbortController();
    const generation = new AbortController();
    const handler = vi.fn(() => new Promise<never>(() => {}));
    const pending = createInvocation({ generationSignal: generation.signal }).invoke(null, {
      signal: caller.signal,
      handler,
    });
    expect(handler).toHaveBeenCalledOnce();

    generation.abort(new Error('generation retired'));
    caller.abort(new Error('caller stopped'));

    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_generation_retired',
    });
  });

  it('carries a canonical PluginError retryable and data through the action failure projection', async () => {
    const nestedCause = new Error('credential secret');
    // Protocol cannot construct the SDK's PluginError class, so the fixture
    // reproduces exactly what its constructor publishes - including the `data`
    // representation the canonical recognizer proves the contract from.
    const richPluginError = Object.assign(new Error('provider credential is secret'), {
      name: 'PluginError',
      code: 'fixture_provider_failed',
      retryable: true,
      details: { credential: 'secret' },
      remediation: { kind: 'openSettings', path: 'accounts/acme' },
      diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
      cause: nestedCause,
      data: {
        name: 'PluginError',
        code: 'fixture_provider_failed',
        message: 'provider credential is secret',
        retryable: true,
        details: { credential: 'secret' },
        remediation: { kind: 'openSettings', path: 'accounts/acme' },
        diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
      },
    });

    const pluginResult = await createInvocation().invoke(null, {
      handler: () => {
        throw richPluginError;
      },
    });

    expect(pluginResult).toEqual({
      status: 'failed',
      code: 'fixture_provider_failed',
      message: 'provider credential is secret',
      retryable: true,
      data: {
        name: 'PluginError',
        code: 'fixture_provider_failed',
        message: 'provider credential is secret',
        retryable: true,
        details: { credential: 'secret' },
        remediation: { kind: 'openSettings', path: 'accounts/acme' },
        diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
      },
    });
    // `cause` is an Error, not contract data: it never becomes a JSON payload.
    expect(pluginResult).not.toHaveProperty('cause');

    const genericError = Object.assign(new Error('upstream credential is secret'), {
      details: { credential: 'secret' },
      cause: nestedCause,
    });
    const genericResult = await createInvocation().invoke(null, {
      handler: () => {
        throw genericError;
      },
    });

    // An ordinary Error has no contract behind it, so nothing but the host
    // taxonomy and its message crosses.
    expect(genericResult).toEqual({
      status: 'failed',
      code: 'plugin_action_execution_failed',
      message: 'upstream credential is secret',
    });
    expect(genericResult).not.toHaveProperty('cause');
    expect(genericResult).not.toHaveProperty('data');
  });

  it('omits action failure data that exceeds the shared Action JSON byte bound', async () => {
    // The bound is the same one every Action input and result already passes;
    // an oversized payload drops only `data`, never the proven failure code.
    const oversized = 'x'.repeat(
      AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates
        .jsonValueMaxJsonBytes,
    );
    const error = Object.assign(new Error('provider failed'), {
      name: 'PluginError',
      code: 'fixture_provider_failed',
      retryable: false,
      data: {
        name: 'PluginError',
        code: 'fixture_provider_failed',
        message: 'provider failed',
        details: { blob: oversized },
      },
    });

    await expect(createInvocation().invoke(null, {
      handler: () => {
        throw error;
      },
    })).resolves.toEqual({
      status: 'failed',
      code: 'fixture_provider_failed',
      message: 'provider failed',
      retryable: false,
    });
  });

  it('refuses an author failure code from an Error that only borrows the PluginError name', async () => {
    // One recognizer decides what a canonical PluginError is. An ordinary Error
    // carrying the name and a `code` property has none of the contract behind
    // it, so it must not publish an author-chosen failure code to callers.
    const lookalike = Object.assign(new Error('provider credential is secret'), {
      name: 'PluginError',
      code: 'fixture_provider_failed',
    });

    await expect(createInvocation().invoke(null, {
      handler: () => {
        throw lookalike;
      },
    })).resolves.toEqual({
      status: 'failed',
      code: 'plugin_action_execution_failed',
      message: 'provider credential is secret',
    });
  });
});
