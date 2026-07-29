import { describe, expect, it, vi } from 'vitest';

import {
  GROK_ACP_HISTORY,
  createGrokConversationRollbackControl,
  projectGrokUserMessageProviderCheckpoint,
} from './historyControls.js';

describe('Grok history controls', () => {
  it('captures only the official user-message promptIndex coordinate', () => {
    expect(projectGrokUserMessageProviderCheckpoint({
      text: 'prompt',
      _meta: { modelId: 'grok-4.5', promptIndex: 7 },
    })).toEqual({ kind: 'grok_prompt_index', promptIndex: 7 });
    expect(projectGrokUserMessageProviderCheckpoint({
      text: 'prompt',
      _meta: { promptIndex: -1 },
    })).toBeNull();
    expect(projectGrokUserMessageProviderCheckpoint({
      text: 'prompt',
      promptIndex: 7,
    })).toBeNull();
  });

  it('forks the whole session without a target and an exact turn inclusively with its prompt index', () => {
    expect(GROK_ACP_HISTORY.fork?.methods).toEqual([
      'x.ai/session/fork',
      '_x.ai/session/fork',
    ]);
    expect(GROK_ACP_HISTORY.fork?.buildParams({
      sourceProviderSessionId: 'grok-session-1',
      sourceCwd: '/source',
      newCwd: '/fork',
    })).toEqual({
      sourceSessionId: 'grok-session-1',
      sourceCwd: '/source',
      newCwd: '/fork',
    });
    expect(GROK_ACP_HISTORY.fork?.buildParams({
      sourceProviderSessionId: 'grok-session-1',
      sourceCwd: '/source',
      newCwd: '/fork',
      providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 7 },
    })).toEqual({
      sourceSessionId: 'grok-session-1',
      sourceCwd: '/source',
      newCwd: '/fork',
      targetPromptIndex: 7,
    });
    expect(GROK_ACP_HISTORY.fork?.readProviderSessionId({
      newSessionId: 'grok-session-2',
    })).toBe('grok-session-2');
  });

  it('accepts only an exact nonempty provider session identity from fork', () => {
    expect(GROK_ACP_HISTORY.fork?.readProviderSessionId({
      newSessionId: ' padded-provider-id ',
    })).toBeNull();
    expect(GROK_ACP_HISTORY.fork?.readProviderSessionId({
      newSessionId: '',
    })).toBeNull();
    expect(GROK_ACP_HISTORY.fork?.readProviderSessionId({
      newSessionId: 7,
    })).toBeNull();
  });

  it('rewinds once to the selected prompt with conversation_only scope', async () => {
    const requestExtension = vi.fn(async (methods: readonly string[]) => (
      methods[0] === 'x.ai/rewind/points'
        ? { points: [] }
        : { success: true }
    ));
    const control = createGrokConversationRollbackControl({
      getProviderSessionId: () => 'grok-session-1',
      requestExtension,
    });
    const result = await control.rollback({
      operationId: 'operation-1',
      target: { kind: 'beforeTurn', turnId: 'turn-2' },
      affectedTurns: [{
        turnId: 'turn-2',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 },
      }],
      providerSessionId: 'grok-session-1',
      runtimeIncarnationId: 'runtime-1',
    });

    expect(result).toEqual({ status: 'applied' });
    expect(requestExtension).toHaveBeenCalledTimes(2);
    expect(requestExtension).toHaveBeenNthCalledWith(1, [
      'x.ai/rewind/points',
    ], {
      sessionId: 'grok-session-1',
    }, expect.any(Object));
    expect(requestExtension).toHaveBeenNthCalledWith(2, [
      'x.ai/rewind/execute',
    ], {
      sessionId: 'grok-session-1',
      targetPromptIndex: 4,
      force: true,
      mode: 'conversation_only',
    }, expect.any(Object));
  });

  it('uses the observed legacy rewind namespace after a non-destructive probe', async () => {
    const requestExtension = vi.fn(async (methods: readonly string[]) => {
      if (methods[0] === 'x.ai/rewind/points') {
        throw { code: -32601, message: 'Method not found' };
      }
      if (methods[0] === '_x.ai/rewind/points') return { points: [] };
      return { success: true };
    });
    const control = createGrokConversationRollbackControl({
      getProviderSessionId: () => 'grok-session-1',
      requestExtension,
    });

    await expect(control.rollback({
      operationId: 'operation-1',
      target: { kind: 'beforeTurn', turnId: 'turn-2' },
      affectedTurns: [{
        turnId: 'turn-2',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 },
      }],
      providerSessionId: 'grok-session-1',
      runtimeIncarnationId: 'runtime-1',
    })).resolves.toEqual({ status: 'applied' });

    expect(requestExtension).toHaveBeenCalledTimes(3);
    expect(requestExtension.mock.calls.map(([methods]) => methods)).toEqual([
      ['x.ai/rewind/points'],
      ['_x.ai/rewind/points'],
      ['_x.ai/rewind/execute'],
    ]);
  });

  it('does not issue a destructive rewind when neither namespace probe succeeds', async () => {
    const requestExtension = vi.fn(async () => {
      throw { code: -32601, message: 'Method not found' };
    });
    const control = createGrokConversationRollbackControl({
      getProviderSessionId: () => 'grok-session-1',
      requestExtension,
    });

    await expect(control.rollback({
      operationId: 'operation-1',
      target: { kind: 'beforeTurn', turnId: 'turn-2' },
      affectedTurns: [{
        turnId: 'turn-2',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 },
      }],
      providerSessionId: 'grok-session-1',
      runtimeIncarnationId: 'runtime-1',
    })).resolves.toMatchObject({
      status: 'unavailable',
      retryable: false,
    });

    expect(requestExtension.mock.calls.map(([methods]) => methods)).toEqual([
      ['x.ai/rewind/points'],
      ['_x.ai/rewind/points'],
    ]);
  });

  it.each([
    {
      label: 'an untyped method-not-found code',
      error: { code: -32601, message: '"Method not found": x.ai/rewind/execute' },
    },
    {
      label: 'an untyped method-not-found Error',
      error: new Error('Method not found'),
    },
    {
      label: 'a spoofed RequestError name and method-not-found code',
      error: Object.assign(new Error('Method not found'), {
        name: 'RequestError',
        code: -32601,
      }),
    },
  ])('does not retry destructive rewind after $label', async ({ error }) => {
    const requestExtension = vi.fn(async (methods: readonly string[]) => {
      if (methods[0] === 'x.ai/rewind/points') return { points: [] };
      throw error;
    });
    const control = createGrokConversationRollbackControl({
      getProviderSessionId: () => 'grok-session-1',
      requestExtension,
    });

    await expect(control.rollback({
      operationId: 'operation-1',
      target: { kind: 'beforeTurn', turnId: 'turn-2' },
      affectedTurns: [{
        turnId: 'turn-2',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 },
      }],
      providerSessionId: 'grok-session-1',
      runtimeIncarnationId: 'runtime-1',
    })).resolves.toMatchObject({ status: 'outcomeUnknown' });

    expect(requestExtension).toHaveBeenCalledTimes(2);
    expect(requestExtension.mock.calls.filter(([methods]) => (
      methods[0].endsWith('/rewind/execute')
    ))).toHaveLength(1);
  });

  it('does not report rollback applied without an authoritative successful rewind response', async () => {
    const request = {
      operationId: 'operation-1',
      target: { kind: 'beforeTurn' as const, turnId: 'turn-2' },
      affectedTurns: [{
        turnId: 'turn-2',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 },
      }],
      providerSessionId: 'grok-session-1',
      runtimeIncarnationId: 'runtime-1',
    };
    const responseAfterProbe = (response: unknown) => vi.fn(async (methods: readonly string[]) => (
      methods[0] === 'x.ai/rewind/points'
        ? { points: [] }
        : response
    ));
    const rejected = createGrokConversationRollbackControl({
      getProviderSessionId: () => 'grok-session-1',
      requestExtension: responseAfterProbe({
        success: false,
        error: 'Cannot rewind to this prompt',
      }),
    });
    const ambiguous = createGrokConversationRollbackControl({
      getProviderSessionId: () => 'grok-session-1',
      requestExtension: responseAfterProbe({}),
    });

    await expect(rejected.rollback(request)).resolves.toMatchObject({
      status: 'rejected',
      retryable: false,
    });
    await expect(ambiguous.rollback(request)).resolves.toMatchObject({
      status: 'outcomeUnknown',
    });
  });

  it('fails closed before a destructive request when the target coordinate is absent or ambiguous', async () => {
    const requestExtension = vi.fn();
    const control = createGrokConversationRollbackControl({
      getProviderSessionId: () => 'grok-session-1',
      requestExtension,
    });
    const base = {
      operationId: 'operation-1',
      target: { kind: 'beforeTurn' as const, turnId: 'turn-2' },
      providerSessionId: 'grok-session-1',
      runtimeIncarnationId: 'runtime-1',
    };

    await expect(control.rollback({
      ...base,
      affectedTurns: [{ turnId: 'turn-2' }],
    })).resolves.toMatchObject({ status: 'rejected' });
    await expect(control.rollback({
      ...base,
      affectedTurns: [
        { turnId: 'turn-2', providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 } },
        { turnId: 'turn-3', providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 } },
      ],
    })).resolves.toMatchObject({ status: 'rejected' });
    expect(requestExtension).not.toHaveBeenCalled();
  });

  it('reports an ambiguous destructive transport outcome without retrying', async () => {
    const requestExtension = vi.fn(async (methods: readonly string[]) => {
      if (methods[0] === 'x.ai/rewind/points') return { points: [] };
      throw new Error('connection lost after send');
    });
    const control = createGrokConversationRollbackControl({
      getProviderSessionId: () => 'grok-session-1',
      requestExtension,
    });
    const result = await control.rollback({
      operationId: 'operation-1',
      target: { kind: 'beforeTurn', turnId: 'turn-2' },
      affectedTurns: [{
        turnId: 'turn-2',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 },
      }],
      providerSessionId: 'grok-session-1',
      runtimeIncarnationId: 'runtime-1',
    });

    expect(result).toMatchObject({ status: 'outcomeUnknown' });
    expect(requestExtension).toHaveBeenCalledTimes(2);
    expect(requestExtension.mock.calls.filter(([methods]) => (
      methods[0].endsWith('/rewind/execute')
    ))).toHaveLength(1);
  });

  it('rechecks the provider session after probing and before destructive execution', async () => {
    let providerSessionId = 'grok-session-1';
    const requestExtension = vi.fn(async () => {
      providerSessionId = 'grok-session-2';
      return { points: [] };
    });
    const control = createGrokConversationRollbackControl({
      getProviderSessionId: () => providerSessionId,
      requestExtension,
    });

    await expect(control.rollback({
      operationId: 'operation-1',
      target: { kind: 'beforeTurn', turnId: 'turn-2' },
      affectedTurns: [{
        turnId: 'turn-2',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 },
      }],
      providerSessionId: 'grok-session-1',
      runtimeIncarnationId: 'runtime-1',
    })).resolves.toMatchObject({
      status: 'rejected',
      retryable: false,
    });

    expect(requestExtension.mock.calls.map(([methods]) => methods)).toEqual([
      ['x.ai/rewind/points'],
    ]);
  });

  it('rechecks cancellation after probing and before destructive execution', async () => {
    const controller = new AbortController();
    const requestExtension = vi.fn(async () => {
      controller.abort();
      return { points: [] };
    });
    const control = createGrokConversationRollbackControl({
      getProviderSessionId: () => 'grok-session-1',
      requestExtension,
    });

    await expect(control.rollback({
      operationId: 'operation-1',
      target: { kind: 'beforeTurn', turnId: 'turn-2' },
      affectedTurns: [{
        turnId: 'turn-2',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 4 },
      }],
      providerSessionId: 'grok-session-1',
      runtimeIncarnationId: 'runtime-1',
    }, { signal: controller.signal })).resolves.toMatchObject({
      status: 'unavailable',
      retryable: false,
    });

    expect(requestExtension.mock.calls.map(([methods]) => methods)).toEqual([
      ['x.ai/rewind/points'],
    ]);
  });
});
