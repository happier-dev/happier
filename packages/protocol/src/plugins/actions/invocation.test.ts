import { describe, expect, it, vi } from 'vitest';
import { createHostReviewedChildPortV1 } from '../../actions/executor/deploymentRoleChild.js';
import type { PluginActionContributionV2 } from './v2.js';

import {
  PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE,
  createPluginActionInvocation,
  createPluginActionPresentUserGate,
  fingerprintPluginActionCurrentIntent,
  projectPluginActionUnavailableOutcomeCode,
  readPluginActionFailureHandlerInvocation,
} from './invocation.js';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
} from './protocolComposableSchema.js';

function currentIntentAuthorizationFacts(generation = '7') {
  return {
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

function currentIntentResolution(occurrenceId = 'acme-action-occurrence-7') {
  return {
    status: 'resolved' as const,
    action: Object.freeze({ occurrenceId }),
    policy: Object.freeze({
      qualifiedId: 'acme.action/actions/commit',
      occurrenceId,
      dangerLevel: 'writesRemote' as const,
      scopes: Object.freeze(['global']),
      surfaces: Object.freeze(['ui']),
      confirmation: Object.freeze({ title: 'Commit action' }),
      authorization: currentIntentAuthorizationFacts('7'),
      fingerprintContext: Object.freeze({ accountId: 'account-1' }),
    }),
  };
}

type TestProtocolParser = (input: unknown) => Readonly<
  | { success: true; data: unknown }
  | {
    success: false;
    issues: readonly Readonly<{
      path: readonly (string | number)[];
      code: string;
      message: string;
    }>[];
  }
>;

function createInvocation(params: Readonly<{
  occurrenceSignal?: AbortSignal;
  isCurrent?: () => boolean;
  inputSchema?: object;
  inputParser?: TestProtocolParser;
  resultSchema?: object;
  resultParser?: TestProtocolParser;
  declaration?: Pick<PluginActionContributionV2, 'readOnly'>;
}> = {}) {
  return createPluginActionInvocation({
    pluginId: 'acme.action',
    localId: 'commit',
    declaration: params.declaration ?? {},
    occurrenceSignal: params.occurrenceSignal ?? new AbortController().signal,
    isCurrent: params.isCurrent ?? (() => true),
    ...(params.inputSchema === undefined ? {} : { inputSchema: params.inputSchema }),
    ...(params.inputParser === undefined ? {} : { inputParser: params.inputParser }),
    ...(params.resultSchema === undefined ? {} : { resultSchema: params.resultSchema }),
    ...(params.resultParser === undefined ? {} : { resultParser: params.resultParser }),
  });
}

describe('createPluginActionInvocation', () => {
  it.each([undefined, false, { op: 'eq', path: 'mode', value: 'read' }] as const)(
    'retains a started mutation outcome after cancellation (readOnly=%j)', async (readOnly) => {
      const caller = new AbortController();
      let resolveHandler!: (value: { nativeId: string }) => void;
      let handlerSignal!: AbortSignal;
      const pending = createInvocation({ declaration: { readOnly } }).invoke({ mode: 'write' }, {
        signal: caller.signal,
        handler: ({ signal }) => {
          handlerSignal = signal;
          return new Promise<{ nativeId: string }>((resolve) => { resolveHandler = resolve; });
        },
      });
      caller.abort();
      expect(handlerSignal.aborted).toBe(true);
      resolveHandler({ nativeId: 'native-1' });
      await expect(pending).resolves.toEqual({ status: 'executed', value: { nativeId: 'native-1' } });
    },
  );

  it('retains a started mutation native failure after cancellation', async () => {
    const caller = new AbortController();
    let rejectHandler!: (error: Error) => void;
    const pending = createInvocation({ declaration: {} }).invoke(null, {
      signal: caller.signal,
      handler: () => new Promise<never>((_resolve, reject) => { rejectHandler = reject; }),
    });
    caller.abort();
    const data = { name: 'PluginError', code: 'native_outcome_unknown', message: 'Native outcome is unknown', retryable: false };
    rejectHandler(Object.assign(new Error(data.message), data, { data }));
    await expect(pending).resolves.toEqual({ status: 'failed', code: data.code, message: data.message, retryable: false, data });
  });

  it('lets cancellation win for a matching input-sensitive read after input normalization', async () => {
    const caller = new AbortController();
    const pending = createInvocation({
      declaration: { readOnly: { op: 'eq', path: 'mode', value: 'read' } },
      inputParser: () => ({ success: true, data: { mode: 'read' } }),
    }).invoke({ mode: 'write' }, {
      signal: caller.signal,
      handler: () => new Promise<never>(() => {}),
    });
    caller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_aborted' });
  });

  it('cancels an open observation independently of its Action mutation declaration', async () => {
    const caller = new AbortController();
    const prepared = createInvocation({ declaration: {} }).prepare(null);
    if (prepared.kind !== 'ready') throw new Error('Expected admitted observation input');
    const pending = prepared.observe({ signal: caller.signal, handler: () => new Promise<never>(() => {}) });
    caller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_aborted' });
  });

  it('retains content-free field repair facts for general JSON Schema input refusals', async () => {
    const invocation = createInvocation({ inputSchema: {
      type: 'object', definitions: { scope: { type: 'string', enum: ['diff', 'all'] } },
      properties: { scope: { $ref: '#/definitions/scope' } }, required: ['scope'], additionalProperties: false,
    } });
    const handler = vi.fn(() => null);
    for (const testCase of [
      { input: { scope: 42 }, issue: { code: 'type', path: ['scope'], expected: 'string', message: expect.stringContaining('string') } },
      { input: { scope: 'private-rejected-value' }, issue: { code: 'enum', path: ['scope'], acceptedValues: ['diff', 'all'], message: expect.stringContaining('diff') } },
      { input: { 'private-unknown-key': 'private-rejected-value' }, issue: { code: 'required', path: ['scope'], expected: 'nonoptional', message: expect.stringMatching(/required/i) } },
      { input: { scope: 'diff', 'private-unknown-key': 'private-rejected-value' }, issue: { code: 'additionalProperties', path: [], message: expect.stringMatching(/unrecognized/i) } },
    ]) {
      const result = await invocation.invoke(testCase.input, { handler });
      expect(result).toMatchObject({ status: 'invalid', code: 'plugin_action_input_schema_invalid',
        issues: expect.arrayContaining([expect.objectContaining(testCase.issue)]) });
      expect(JSON.stringify(result)).not.toContain('private-');
    }
    expect(handler).not.toHaveBeenCalled();
    expect(await invocation.invoke({ scope: 'diff' }, { handler })).toMatchObject({ status: 'executed', value: null });
    const nested = createInvocation({ inputSchema: {
      type: 'object', definitions: { text: { type: 'string' } }, properties: { items: { type: 'array', items: {
        type: 'object', properties: { 'a/b~c': { $ref: '#/definitions/text' } }, required: ['a/b~c'], additionalProperties: false,
      } } }, required: ['items'], additionalProperties: false,
    } });
    expect(await nested.invoke({ items: [{ 'a/b~c': 42 }] }, { handler })).toMatchObject({
      status: 'invalid', issues: [{ code: 'type', path: ['items', 0, 'a/b~c'], expected: 'string' }],
    });
  });

  it('uses null as the canonical handler input only when an input-less Action omits input', async () => {
    const inputlessHandler = vi.fn(() => ({ accepted: true }));
    await expect(createInvocation().invoke(undefined, {
      handler: inputlessHandler,
    })).resolves.toEqual({ status: 'executed', value: { accepted: true } });
    expect(inputlessHandler).toHaveBeenCalledWith(expect.objectContaining({ input: null }));

    const nullSchemaHandler = vi.fn(() => ({ accepted: true }));
    await expect(createInvocation({ inputSchema: { type: 'null' } }).invoke(undefined, {
      handler: nullSchemaHandler,
    })).resolves.toMatchObject({
      status: 'invalid',
      code: 'plugin_action_input_schema_invalid',
    });
    expect(nullSchemaHandler).not.toHaveBeenCalled();
  });

  it('keeps durable current-intent identity independent of the process-local occurrence', () => {
    const input = {
      input: { title: 'ship it' },
      surface: 'ui',
      invocationSurface: 'ui',
    } as const;
    expect(fingerprintPluginActionCurrentIntent({
      ...input,
      policy: currentIntentResolution('occurrence-a').policy,
    })).toBe(fingerprintPluginActionCurrentIntent({
      ...input,
      policy: currentIntentResolution('occurrence-b').policy,
    }));
  });

  it.each([
    { scopes: ['global', 'session', 'message'], sessionId: undefined, status: 'admitted' },
    { scopes: ['session'], sessionId: undefined, status: 'unavailable' },
    { scopes: ['session'], sessionId: 'selected-session', status: 'admitted' },
  ] as const)('admits a global Action without Session context while preserving Session-only refusal: $scopes / $sessionId', async ({ scopes, sessionId, status }) => {
    const resolution = currentIntentResolution();
    const gate = createPluginActionPresentUserGate({
      resolve: () => ({ ...resolution, policy: { ...resolution.policy, scopes,
        dangerLevel: 'safe' as const, confirmation: undefined } }),
      requestCurrentIntent: async () => { throw new Error('Safe Action must not request confirmation'); },
    });
    const result = await gate.admit({ input: {}, surface: 'ui', invocationSurface: 'ui', sessionId });
    expect(result).toMatchObject(status === 'admitted' ? { status } : { status, code: 'plugin_action_session_required' });
  });

  it.each(['resolve', 'requestCurrentIntent', 'resolvedFailure'] as const)('retains typed provider causes at the present-user gate: %s', async phase => {
    const data = { name: 'PluginError' as const, code: 'provider_request_rejected',
      details: { nativeCause: { code: 'forbidden', httpStatusClass: '4xx' } } };
    // Protocol models the SDK-published error contract without importing the SDK.
    const error = Object.assign(new Error(data.code), { name: 'PluginError', code: data.code, retryable: false, data });
    const gate = createPluginActionPresentUserGate({
      resolve: () => {
        if (phase === 'resolve') throw error;
        if (phase === 'resolvedFailure') return { status: 'failed' as const, code: data.code, message: data.code, retryable: false, data };
        return currentIntentResolution();
      },
      requestCurrentIntent: async () => { throw error; },
    });
    await expect(gate.admit({ input: {}, surface: 'ui', invocationSurface: 'ui' }))
      .resolves.toMatchObject({ status: 'failed', code: data.code, retryable: false, data });
  });

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

  it('resolves admission once and prompts once for a non-safe client Action', async () => {
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
      action: { occurrenceId: 'acme-action-occurrence-7' },
    });

    expect(present).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledWith(expect.objectContaining({
      input: { title: 'ship it' },
      surface: 'ui',
      invocationSurface: 'ui',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it.each([true, false])('retains an admitted exact child without re-deciding policy (available=%s)', async available => {
    const present = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({
      status: 'approved' as const, fingerprint,
    }));
    const gate = createPluginActionPresentUserGate({
      resolve: () => {
        const resolved = currentIntentResolution();
        return { ...resolved, policy: { ...resolved.policy,
          ...(!available ? { availability: { status: 'unavailable' as const, code: 'plugin_account_execution_unavailable' } } : {}),
        } };
      },
      requestCurrentIntent: present,
    });
    const action = { pluginId: 'acme.action', localId: 'commit' };
    const input = { title: 'ship it' };
    const port = createHostReviewedChildPortV1({
      actionId: 'machines.managed.power.set', input: { homeId: 'home', managedId: 'managed' },
      context: { surface: 'ui', interactivePresentation: 'unavailable' },
      plan: { children: [{ action, role: 'power', input }] },
      policies: [{ action, role: 'power', surface: 'ui' }],
      reviewAdmitted: true,
      execute: async (_envelope, context) => ({ ok: true, result: await gate.admit({
        input, surface: 'ui', invocationSurface: 'ui', reviewedChildContext: context,
      }) }),
    });
    await expect(port.invoke({ action, role: 'power', input })).resolves.toMatchObject({
      ok: true, result: { status: 'admitted' },
    });
    expect(present).not.toHaveBeenCalled();
  });

  it.each(['exact', 'changed input', 'changed Action', 'serialized port'] as const)(
    'accepts only the existing private admitted Account operand: %s', async variant => {
      const input = { title: 'ship it' };
      const action = { pluginId: 'acme.action', localId: 'commit' };
      const port = createHostReviewedChildPortV1({ actionId: 'action.invoke', input: { action, input },
        context: {}, reviewAdmitted: true });
      const present = vi.fn(async () => ({ status: 'unavailable' as const, code: 'plugin_action_current_intent_unavailable' }));
      const gate = createPluginActionPresentUserGate({
        resolve: () => {
          const resolved = currentIntentResolution();
          return variant === 'changed Action' ? { ...resolved, policy: { ...resolved.policy, qualifiedId: 'acme.action/actions/other' } } : resolved;
        }, requestCurrentIntent: present,
      });
      const result = await gate.admit({ input: variant === 'changed input' ? { title: 'other' } : input,
        surface: 'ui', invocationSurface: 'ui', reviewedChildContext: {
          hostReviewedChild: variant === 'serialized port' ? { parent: port.parent, invoke: port.invoke } : port,
        } });
      expect(result.status).toBe(variant === 'exact' ? 'admitted' : 'unavailable');
      expect(present).toHaveBeenCalledTimes(variant === 'exact' ? 0 : 1);
    });

  it('admits a waived dangerous agent Action without current intent while retaining its danger metadata', async () => {
    const action = { committed: true };
    const gate = createPluginActionPresentUserGate({
      resolve: () => ({
        ...currentIntentResolution(),
        action,
        policy: { ...currentIntentResolution().policy, surfaces: ['agent'], approvalRequiredByActionSettings: false },
      }),
    });
    await expect(gate.admit({ input: { title: 'ship it' }, surface: 'agent', invocationSurface: 'agent' }))
      .resolves.toEqual({ status: 'admitted', action });
  });

  it('prompts for a safe Action only when the host stamps Action-settings approval', async () => {
    const present = vi.fn(async ({ fingerprint }: Readonly<{ fingerprint: string }>) => ({
      status: 'approved' as const,
      fingerprint,
    }));
    const gate = createPluginActionPresentUserGate({
      resolve: () => ({
        status: 'resolved' as const,
        action: Object.freeze({ occurrenceId: 'acme-action-occurrence-7' }),
        policy: Object.freeze({
          qualifiedId: 'acme.action/actions/commit',
          occurrenceId: 'acme-action-occurrence-7',
          dangerLevel: 'safe' as const,
          scopes: Object.freeze(['global']),
          surfaces: Object.freeze(['cli']),
          approvalRequiredByActionSettings: true as const,
          authorization: currentIntentAuthorizationFacts(),
        }),
      }),
      requestCurrentIntent: present,
    });

    await expect(gate.admit({
      input: { title: 'ship it' },
      surface: 'cli',
      invocationSurface: 'cli',
    })).resolves.toMatchObject({
      status: 'admitted',
      action: { occurrenceId: 'acme-action-occurrence-7' },
    });

    expect(present).toHaveBeenCalledOnce();
  });

  it.each(['api', 'cli', 'agent', 'mcp'] as const)('returns a %s Ask-first artifact without waiting for a target decision', async surface => {
    const present = vi.fn(async () => ({
      status: 'deferred',
      artifactId: 'approval-api-required-1',
    } as never));
    const resolve = vi.fn(() => ({
      status: 'resolved' as const,
      action: Object.freeze({ occurrenceId: 'acme-action-occurrence-7' }),
      policy: Object.freeze({
        qualifiedId: 'acme.action/actions/commit',
        occurrenceId: 'acme-action-occurrence-7',
        dangerLevel: 'safe' as const,
        scopes: Object.freeze(['global']),
        surfaces: Object.freeze([surface]),
        approvalRequiredByActionSettings: true as const,
        authorization: currentIntentAuthorizationFacts(),
      }),
    }));
    const gate = createPluginActionPresentUserGate({ resolve, requestCurrentIntent: present });

    await expect(gate.admit({
      input: { title: 'ship it' },
      surface,
      invocationSurface: surface,
    })).resolves.toEqual({
      status: 'deferred',
      artifactId: 'approval-api-required-1',
    });

    expect(present).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('fails closed when a background plugin caller tries to defer an Ask-first target Action', async () => {
    const gate = createPluginActionPresentUserGate({
      resolve: () => ({
        status: 'resolved' as const,
        action: Object.freeze({ occurrenceId: 'acme-action-occurrence-7' }),
        policy: Object.freeze({
          qualifiedId: 'acme.action/actions/commit',
          occurrenceId: 'acme-action-occurrence-7',
          dangerLevel: 'safe' as const,
          scopes: Object.freeze(['global']),
          surfaces: Object.freeze(['plugin']),
          approvalRequiredByActionSettings: true as const,
          authorization: currentIntentAuthorizationFacts(),
        }),
      }),
      requestCurrentIntent: async () => ({
        status: 'deferred' as const,
        artifactId: 'approval-plugin-required-1',
      }),
    });

    await expect(gate.admit({
      input: { title: 'ship it' },
      surface: 'plugin',
      invocationSurface: 'plugin',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_action_current_intent_unavailable',
      message: 'plugin_action_current_intent_unavailable',
    });
  });

  it('does not bypass a host-stamped Ask-first policy for a plugin Action', async () => {
    const present = vi.fn(async () => ({
      status: 'rejected' as const,
      code: 'plugin_action_current_intent_rejected',
    }));
    const gate = createPluginActionPresentUserGate({
      resolve: () => ({
        status: 'resolved' as const,
        action: Object.freeze({ occurrenceId: 'acme-action-occurrence-7' }),
        policy: Object.freeze({
          qualifiedId: 'acme.action/actions/commit',
          occurrenceId: 'acme-action-occurrence-7',
          dangerLevel: 'safe' as const,
          scopes: Object.freeze(['global']),
          surfaces: Object.freeze(['plugin']),
          approvalRequiredByActionSettings: true as const,
          authorization: currentIntentAuthorizationFacts(),
        }),
      }),
      requestCurrentIntent: present,
    });

    await expect(gate.admit({
      input: { title: 'ship it' },
      surface: 'plugin',
      invocationSurface: 'plugin',
    })).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_current_intent_rejected',
    });

    expect(present).toHaveBeenCalledOnce();
  });

  it('refuses declined consent and retains admitted work after approval', async () => {
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
    })).resolves.toMatchObject({ status: 'admitted', action: { occurrenceId: 'acme-action-occurrence-7' } });
  });

  it.each(['returned fingerprint', 'changed policy'] as const)('identifies a current-intent mismatch without exposing values: %s', async phase => {
    let approved = false;
    const gate = createPluginActionPresentUserGate({
      resolve: () => {
        const resolution = currentIntentResolution();
        return phase === 'changed policy' && approved
          ? { ...resolution, policy: { ...resolution.policy, fingerprintContext: { accountId: 'private-other-account' } } }
          : resolution;
      },
      requestCurrentIntent: async ({ fingerprint }) => {
        approved = true;
        return { status: 'approved', fingerprint: phase === 'returned fingerprint' ? 'private-other-fingerprint' : fingerprint };
      },
    });
    const result = await gate.admit({ input: { confidential: 'private-input' }, surface: 'ui', invocationSurface: 'ui' });
    expect(result).toEqual(phase === 'changed policy' ? { status: 'admitted', action: { occurrenceId: 'acme-action-occurrence-7' } }
      : { status: 'unavailable', code: 'plugin_action_current_intent_mismatch',
        message: 'plugin_action_current_intent_mismatch', data: { details: { currentIntentMismatch: { field: 'fingerprint_source' } } } });
  });

  it('refuses operands mutated while the person approves the original input', async () => {
    const input = { title: 'approved' };
    const gate = createPluginActionPresentUserGate({ resolve: () => currentIntentResolution(),
      requestCurrentIntent: async ({ fingerprint }) => {
        input.title = 'retargeted';
        return { status: 'approved', fingerprint };
      } });
    await expect(gate.admit({ input, surface: 'ui', invocationSurface: 'ui' }))
      .resolves.toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch' });
  });

  it.each(['matching', 'other failure', 'bare marker'] as const)('reads the dispatch proof only from its matching public failure envelope: %s', kind => {
    const data = kind === 'bare marker' ? { actionHandlerInvocation: 'notStarted' }
      : { name: 'PluginError', code: kind === 'matching' ? 'source_refused' : 'other_failure',
        message: 'Source refused', actionHandlerInvocation: 'notStarted' };
    expect(readPluginActionFailureHandlerInvocation({ code: 'source_refused', message: 'Source refused', data }))
      .toBe(kind === 'matching' ? 'notStarted' : undefined);
  });

  it('retains an admission mismatch detail before the handler can start', async () => {
    const invocation = createInvocation();
    const data = { details: { currentIntentMismatch: { field: 'fingerprint_source' } } };
    const prepared = invocation.prepare({});
    if (prepared.kind !== 'ready') throw new Error('Expected valid prepared input');
    const result = await prepared.invoke({ preDispatch: () => ({ status: 'unavailable',
      code: 'plugin_action_current_intent_mismatch', message: 'plugin_action_current_intent_mismatch', data }),
      handler: () => { throw new Error('Refused admission must not start the handler'); } });
    expect(result).toEqual({ status: 'unavailable', code: 'plugin_action_current_intent_mismatch',
      message: 'plugin_action_current_intent_mismatch', actionHandlerInvocation: 'notStarted', data });
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

  it('normalizes through the executable parser before schema parity and host pre-dispatch', async () => {
    const inputParser = vi.fn((input: unknown) => {
      if (typeof input !== 'object' || input === null || !('title' in input)) {
        return Object.freeze({
          success: false as const,
          issues: Object.freeze([Object.freeze({
            path: Object.freeze(['title']),
            code: 'invalid_type',
            message: 'Expected a title string',
          })]),
        });
      }
      return Object.freeze({
        success: true as const,
        data: Object.freeze({ title: String(input.title) }),
      });
    });
    const invocation = createInvocation({
      inputParser,
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: true,
      },
    });
    const preDispatch = vi.fn(() => null);
    const handler = vi.fn(() => ({ committed: true }));

    await expect(invocation.invoke({ title: 'Release', ignored: true }, {
      preDispatch,
      handler,
    })).resolves.toEqual({ status: 'executed', value: { committed: true } });
    expect(inputParser).toHaveBeenCalledOnce();
    expect(preDispatch).toHaveBeenCalledWith(expect.objectContaining({
      input: { title: 'Release' },
    }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      input: { title: 'Release' },
    }));

    inputParser.mockClear();
    preDispatch.mockClear();
    handler.mockClear();
    await expect(invocation.invoke({}, { preDispatch, handler })).resolves.toEqual({
      status: 'invalid',
      code: 'plugin_action_input_schema_invalid',
      message: 'Expected a title string',
      issues: [{ path: ['title'], code: 'invalid_type', message: 'Expected a title string' }],
    });
    expect(inputParser).toHaveBeenCalledOnce();
    expect(preDispatch).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses an executable-parser and emitted-schema disagreement before host pre-dispatch', async () => {
    const invocation = createInvocation({
      inputParser: () => Object.freeze({
        success: true as const,
        data: Object.freeze({ title: 42 }),
      }),
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    });
    const preDispatch = vi.fn(() => null);
    const handler = vi.fn(() => ({ committed: true }));

    await expect(invocation.invoke({ title: 'Release' }, {
      preDispatch,
      handler,
    })).resolves.toEqual({
      status: 'failed',
      code: 'plugin_action_schema_projection_mismatch',
      message: 'Plugin action executable input semantics disagree with the manifest inputSchema',
    });
    expect(preDispatch).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('normalizes handler results through the executable parser at the canonical invocation owner', async () => {
    const resultParser = vi.fn((input: unknown) => Object.freeze({
      success: true as const,
      data: Object.freeze({ title: String((input as { title?: unknown }).title ?? '') }),
    }));
    const invocation = createInvocation({
      resultParser,
      resultSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    });

    await expect(invocation.invoke(null, {
      handler: () => ({ title: 'Release', localOnly: true }),
    })).resolves.toEqual({ status: 'executed', value: { title: 'Release' } });
    expect(resultParser).toHaveBeenCalledOnce();

    await expect(createInvocation({
      resultParser: () => Object.freeze({ success: true as const, data: { title: 42 } }),
      resultSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    }).invoke(null, { handler: () => ({ title: 'Release' }) })).resolves.toEqual({
      status: 'executed',
      value: { title: 42 },
    });

    await expect(createInvocation({
      resultParser: () => { throw new Error('parser drift'); },
      resultSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
    }).invoke(null, { handler: () => ({ title: 'Release' }) })).resolves.toMatchObject({
      status: 'failed',
      code: 'plugin_action_schema_projection_mismatch',
      message: expect.stringContaining('resultSchema'),
    });
  });

  it('rehydrates canonical manifest schemas when no executable parser carrier is present', async () => {
    const inputSchema = defineProtocolObject({
      title: defineProtocolString({ minLength: 1 }),
    }, { policy: 'additive-open/drop' }).jsonSchema;
    const resultSchema = defineProtocolObject({
      accepted: defineProtocolLiteral(true),
    }, { policy: 'additive-open/drop' }).jsonSchema;
    const handler = vi.fn((handlerInput: { input: { title: string } }) => ({
      accepted: true,
      privateResult: handlerInput.input.title,
    }));
    const invocation = createInvocation({ inputSchema, resultSchema });

    await expect(invocation.invoke({ title: 'Release', privateInput: true }, { handler }))
      .resolves.toEqual({ status: 'executed', value: { accepted: true } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      input: { title: 'Release' },
    }));
  });

  it('prepares only consumed schema documents once, keeping result schemas out of input refusal and observation', async () => {
    // A registry builds one invocation per registered Action; compiling and
    // rehydrating every schema up front blocked the daemon for minutes.
    const schemaReads = { input: 0, result: 0 };
    const observed = <T extends object>(kind: keyof typeof schemaReads, schema: T): T => new Proxy(schema, {
      get(target, key, receiver) {
        schemaReads[kind] += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        schemaReads[kind] += 1;
        return Reflect.ownKeys(target);
      },
    });
    const inputSchema = observed('input', defineProtocolObject({
      title: defineProtocolString({ minLength: 1 }),
    }, { policy: 'additive-open/drop' }).jsonSchema);
    const resultSchema = observed('result', defineProtocolObject({
      accepted: defineProtocolLiteral(true),
    }, { policy: 'additive-open/drop' }).jsonSchema);
    const handler = vi.fn(() => ({ accepted: true }));

    const invocation = createInvocation({ inputSchema, resultSchema });
    expect(schemaReads).toEqual({ input: 0, result: 0 });

    await expect(invocation.invoke({ title: '' }, { handler }))
      .resolves.toMatchObject({ status: 'invalid', code: 'plugin_action_input_schema_invalid' });
    expect(handler).not.toHaveBeenCalled();
    expect(schemaReads.input).toBeGreaterThan(0);
    expect(schemaReads.result).toBe(0);
    const inputReads = schemaReads.input;
    const prepared = invocation.prepare({ title: 'Release' });
    if (prepared.kind !== 'ready') throw new Error('Expected admitted Action input');
    await expect(prepared.observe({ handler: () => undefined })).resolves.toEqual({ status: 'executed', value: null });
    expect(schemaReads).toEqual({ input: inputReads, result: 0 });

    await expect(invocation.invoke({ title: 'Release' }, { handler }))
      .resolves.toEqual({ status: 'executed', value: { accepted: true } });
    expect(schemaReads.input).toBe(inputReads);
    expect(schemaReads.result).toBeGreaterThan(0);
    const resultReads = schemaReads.result;
    await expect(invocation.invoke({ title: 'Release' }, { handler: () => ({ accepted: false }) }))
      .resolves.toMatchObject({ status: 'invalid', code: 'plugin_action_result_schema_invalid' });
    expect(schemaReads).toEqual({ input: inputReads, result: resultReads });
  });

  it('admits a deep-frozen declaration schema once across per-dispatch invocations, while mutable schemas stay observed', () => {
    // The UI builds one invocation per dispatch from an admitted, deep-frozen
    // manifest declaration (wire JSON, not a constructed protocol schema).
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const declared = () => JSON.parse(JSON.stringify(defineProtocolObject({
      title: defineProtocolString({ minLength: 1 }),
      count: defineProtocolObject({ value: defineProtocolString() }, { policy: 'closed' }),
    }, { policy: 'closed' }).jsonSchema)) as Record<string, unknown>;
    let reads = 0;
    const observed = <T extends object>(schema: T): T => new Proxy(schema, {
      get(target, key, receiver) { reads += 1; return Reflect.get(target, key, receiver); },
      ownKeys(target) { reads += 1; return Reflect.ownKeys(target); },
    });
    const dispatch = (inputSchema: object, input: unknown) => createInvocation({ inputSchema }).prepare(input).kind;

    // Workload: 1 cold dispatch, then 10 dispatches of the same admitted declaration.
    const frozen = observed(deepFreeze(declared()));
    expect(dispatch(frozen, { title: 'Release', count: { value: '1' } })).toBe('ready');
    reads = 0;
    for (let index = 0; index < 10; index += 1) {
      expect(dispatch(frozen, { title: 'Release', count: { value: '1' } })).toBe('ready');
      expect(dispatch(frozen, { title: '' , count: { value: '1' } })).toBe('settled');
    }
    expect(reads).toBe(0);

    // A mutable declaration (or one frozen only at its root) is still read on
    // every dispatch, and an edit replaces the admitted schema.
    for (const mutable of [declared(), Object.freeze(declared())]) {
      const schema = observed(mutable);
      expect(dispatch(schema, { title: 'Release', count: { value: '1' } })).toBe('ready');
      reads = 0;
      expect(dispatch(schema, { title: 'Release', count: { value: '1' } })).toBe('ready');
      expect(reads).toBeGreaterThan(0);
    }
    const edited = declared();
    expect(dispatch(edited, { title: 'Release', count: { value: '1' } })).toBe('ready');
    (edited.properties as Record<string, Record<string, unknown>>).title!.minLength = 10;
    expect(dispatch(edited, { title: 'Release', count: { value: '1' } })).toBe('settled');
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

  it.each([true, false])('preserves canonical host pre-dispatch failures without accepting unknown errors (typed=%s)', async (typed) => {
    const failureCause = { phase: 'deployment.target.admission.link.provider_identity', errorClass: 'Error', errorCode: null, httpStatus: null };
    const error = typed ? Object.assign(new Error('deployment_access_denied'), {
      name: 'PluginError', code: 'deployment_access_denied', retryable: false,
      data: { name: 'PluginError', code: 'deployment_access_denied', failureCause },
    }) : Object.assign(new Error('private admission detail'), { code: 'deployment_access_denied', data: { failureCause } });
    const handler = vi.fn(() => ({ committed: true }));
    const result = await createInvocation().invoke(null, { preDispatch: () => { throw error; }, handler });
    expect(result).toMatchObject(typed ? {
      status: 'failed', code: 'deployment_access_denied', data: { failureCause }, actionHandlerInvocation: 'notStarted',
    } : { status: 'unavailable', code: 'plugin_action_pre_dispatch_unavailable', actionHandlerInvocation: 'notStarted' });
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private admission detail');
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

  it('retains the validated outcome of a started mutation after cancellation', async () => {
    const caller = new AbortController();
    let resolveHandler!: (value: { nativeId: string }) => void;
    const resultSchema = defineProtocolObject({ nativeId: defineProtocolString() }, { policy: 'closed' });
    const pending = createInvocation({ declaration: {}, resultSchema: resultSchema.jsonSchema }).invoke(null, {
      signal: caller.signal,
      handler: ({ signal }) => new Promise<{ nativeId: string }>((resolve) => {
        resolveHandler = resolve;
        expect(signal.aborted).toBe(false);
      }),
    });
    caller.abort(new Error('creation was canceled after native submission'));
    resolveHandler({ nativeId: 'paid-native-1' });
    await expect(pending).resolves.toEqual({ status: 'executed', value: { nativeId: 'paid-native-1' } });
    await expect(createInvocation({ declaration: {}, resultSchema: resultSchema.jsonSchema }).invoke(null, {
      handler: () => ({ unrelated: true }),
    })).resolves.toMatchObject({ status: 'invalid' });
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
      occurrenceSignal: generation.signal,
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
      occurrenceSignal: generation.signal,
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
    const pending = createInvocation({ declaration: { readOnly: true } }).invoke(null, { signal: caller.signal, handler });
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
    const pending = createInvocation({ declaration: { readOnly: true } }).invoke(null, { signal: caller.signal, handler });

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
    const pending = createInvocation({ declaration: { readOnly: true } }).invoke(null, { signal: caller.signal, handler });
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
    const pending = createInvocation({ declaration: { readOnly: true }, occurrenceSignal: generation.signal }).invoke(null, {
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
    const pending = createInvocation({ declaration: { readOnly: true }, occurrenceSignal: generation.signal }).invoke(null, {
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

  it('projects canonical PluginError code and multibyte message text through the stable public boundary', async () => {
    const message = `ACTION_FAILURE_MARKER ${'🚫'.repeat(700)}`;
    const unstableCode = 'Provider Failure';
    const error = Object.assign(new Error(message), {
      name: 'PluginError',
      code: unstableCode,
      retryable: false,
      data: {
        name: 'PluginError',
        code: unstableCode,
        message,
      },
    });

    const result = await createInvocation().invoke(null, {
      handler: () => {
        throw error;
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      code: 'plugin_action_execution_failed',
    });
    if (result.status !== 'failed') throw new Error('Expected a canonical Action failure');
    expect(result.message).toBe(message);
  });

  it('preserves JSON-safe action failure data without an invented aggregate byte cap', async () => {
    const aboveFormerAggregateLimit = 'x'.repeat(1_024 * 1_024);
    const error = Object.assign(new Error('provider failed'), {
      name: 'PluginError',
      code: 'fixture_provider_failed',
      retryable: false,
      data: {
        name: 'PluginError',
        code: 'fixture_provider_failed',
        message: 'provider failed',
        details: { blob: aboveFormerAggregateLimit },
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
      data: {
        name: 'PluginError',
        code: 'fixture_provider_failed',
        message: 'provider failed',
        details: { blob: aboveFormerAggregateLimit },
      },
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
