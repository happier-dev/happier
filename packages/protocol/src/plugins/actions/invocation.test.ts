import { describe, expect, it, vi } from 'vitest';

import { createPluginActionInvocation } from './invocation.js';

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

    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      code: 'plugin_action_aborted',
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

  it('projects rich PluginError and generic Error failures through the closed action result boundary', async () => {
    const nestedCause = new Error('credential secret');
    const richPluginError = Object.assign(new Error('provider credential is secret'), {
      name: 'PluginError',
      code: 'fixture_provider_failed',
      retryable: true,
      details: { credential: 'secret' },
      remediation: { kind: 'openSettings', path: 'accounts/acme' },
      diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
      cause: nestedCause,
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
    });
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

    expect(genericResult).toEqual({
      status: 'failed',
      code: 'plugin_action_execution_failed',
      message: 'upstream credential is secret',
    });
    expect(genericResult).not.toHaveProperty('cause');
  });
});
