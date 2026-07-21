import { describe, expect, it } from 'vitest';

import type {
  AcpExtensionHandlerContext,
  AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';
import {
  BasePermissionHandler,
  type PermissionResult as BasePermissionResult,
} from '@/agent/permissions/BasePermissionHandler';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import {
  PermissionRequestCoordinator,
  type PermissionRequestCoordinatorStore,
} from '@/agent/permissions/permissionRequestCoordinator';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol';

import {
  GROK_ASK_USER_QUESTION_METHODS,
  buildGrokAskUserQuestionAcceptedResponse,
  buildGrokExtensionHandlers,
  parseGrokAskUserQuestionRequest,
} from './extensionHandlers';

type PermissionDecision = Awaited<ReturnType<AcpPermissionHandler['handleToolCall']>> & {
  answers?: Readonly<Record<string, readonly string[]>>;
};

class CapturingPermissionHandler implements AcpPermissionHandler {
  readonly calls: Array<Readonly<{ id: string; toolName: string; input: unknown }>> = [];

  constructor(private readonly decision: PermissionDecision) {}

  async handleToolCall(id: string, toolName: string, input: unknown): Promise<PermissionDecision> {
    this.calls.push({ id, toolName, input });
    return this.decision;
  }
}

class BaseBackedPermissionHandler extends BasePermissionHandler implements AcpPermissionHandler {
  protected getLogPrefix(): string {
    return '[GrokQuestionTest]';
  }

  handleToolCall(id: string, toolName: string, input: unknown): Promise<BasePermissionResult> {
    return this.requestPermissionDecision(id, toolName, input);
  }
}

class BaseBackedSession {
  readonly sessionId = 'session-1';
  readonly rpcHandlerManager = {
    handlers: new Map<string, (payload: unknown) => unknown>(),
    registerHandler: <TRequest, TResponse>(
      method: string,
      handler: (payload: TRequest) => TResponse | Promise<TResponse>,
    ): void => {
      this.rpcHandlerManager.handlers.set(method, handler as (payload: unknown) => unknown);
    },
  };
  agentState: Record<string, unknown> & {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
  } = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot(): typeof this.agentState {
    return this.agentState;
  }

  updateAgentState(updater: (state: typeof this.agentState) => typeof this.agentState): typeof this.agentState {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }
}

function context(overrides: Partial<AcpExtensionHandlerContext> = {}): AcpExtensionHandlerContext {
  return {
    method: 'x.ai/ask_user_question',
    sessionId: 'session-1',
    signal: new AbortController().signal,
    agentName: 'grok',
    ...overrides,
  };
}

function directPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    mode: 'default',
    questions: [
      {
        id: 'scope',
        question: 'Which scope?',
        options: [
          { id: 'workspace', label: 'Workspace', description: 'Use this workspace', preview: 'Workspace preview' },
          { id: 'session', label: 'Session', description: 'Use this session' },
        ],
      },
    ],
    ...overrides,
  };
}

function createCoordinatedPermissionHandler(): Readonly<{
  coordinator: PermissionRequestCoordinator<PermissionDecision>;
  permissionHandler: AcpPermissionHandler;
  completedRequestIds: readonly string[];
}> {
  const outstanding = new Map<string, Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
  }>>();
  const completedRequestIds: string[] = [];
  const store: PermissionRequestCoordinatorStore = {
    publishRequest: (request) => { outstanding.set(request.requestId, request); },
    completeRequest: ({ requestId }) => {
      completedRequestIds.push(requestId);
      outstanding.delete(requestId);
    },
    hasOutstandingRequest: (requestId) => outstanding.has(requestId),
    readOutstandingRequest: (requestId) => {
      const request = outstanding.get(requestId);
      return request
        ? {
            requestId,
            toolName: request.toolName,
            toolInput: request.toolInput,
            createdAt: request.createdAt,
          }
        : null;
    },
  };
  const coordinator = new PermissionRequestCoordinator<PermissionDecision>({ store });
  return {
    coordinator,
    completedRequestIds,
    permissionHandler: {
      async handleToolCall(id, toolName, input) {
        return await coordinator.requestDecision({ requestId: id, toolName, toolInput: input });
      },
    },
  };
}

describe('Grok xAI question codec', () => {
  it.each(GROK_ASK_USER_QUESTION_METHODS)('parses direct payloads for %s', (method) => {
    const parsed = parseGrokAskUserQuestionRequest(directPayload(), context({ method }));
    expect(parsed).toMatchObject({
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      askUserQuestionInput: {
        questions: [
          {
            id: 'scope',
            header: 'Question',
            question: 'Which scope?',
            multiSelect: false,
            options: [
              { label: 'Workspace', description: 'Use this workspace' },
              { label: 'Session', description: 'Use this session' },
            ],
          },
        ],
      },
    });
  });

  it.each([
    ['x.ai/ask_user_question', '_x.ai/ask_user_question'],
    ['_x.ai/ask_user_question', 'x.ai/ask_user_question'],
  ] as const)('accepts observed outer %s / inner %s alias-family wrappers', (outer, inner) => {
    const parsed = parseGrokAskUserQuestionRequest({
      method: inner,
      params: directPayload(),
    }, context({ method: outer }));
    expect(parsed.toolCallId).toBe('tool-1');
  });

  it.each([
    [directPayload({ sessionId: 'foreign' }), context(), 'session'],
    [directPayload(), context({ sessionId: null }), 'bound'],
    [directPayload({ toolCallId: '' }), context(), 'tool'],
    [directPayload({ toolCallId: '   ' }), context(), 'tool'],
    [{ method: 'unknown/ask', params: directPayload() }, context(), 'method'],
    [directPayload({ mode: 'unsafe' }), context(), 'mode'],
    [directPayload({ unexpected: true }), context(), 'payload'],
  ])('rejects invalid correlation or shape (%s)', (payload, handlerContext, expected) => {
    expect(() => parseGrokAskUserQuestionRequest(
      payload as Record<string, unknown>,
      handlerContext as AcpExtensionHandlerContext,
    )).toThrow(expected as string);
  });

  it.each([
    [[{ question: '', options: [{ label: 'A' }] }], 'question'],
    [[{ question: 'Same?', options: [{ label: 'A' }] }, { question: 'Same?', options: [{ label: 'B' }] }], 'question'],
    [[{ id: 'same', question: 'One?', options: [{ label: 'A' }] }, { id: 'same', question: 'Two?', options: [{ label: 'B' }] }], 'correlation'],
    [[{ id: 'Two?', question: 'One?', options: [{ label: 'A' }] }, { id: 'second', question: 'Two?', options: [{ label: 'B' }] }], 'correlation'],
    [[{ question: 'Question?', options: [{ label: 'A' }, { label: 'A' }] }], 'label'],
  ])('rejects ambiguous questions before UI publication', (questions, expected) => {
    expect(() => parseGrokAskUserQuestionRequest(
      directPayload({ questions }),
      context(),
    )).toThrow(expected);
  });

  it('publishes the canonical freeform affordance for an official zero-option question', () => {
    const parsed = parseGrokAskUserQuestionRequest(directPayload({
      questions: [{ id: 'details', question: 'Describe the change', options: [] }],
    }), context());

    expect(parsed.askUserQuestionInput.questions).toEqual([
      {
        id: 'details',
        header: 'Question',
        question: 'Describe the change',
        multiSelect: false,
        options: [],
        freeform: { placeholder: 'Other' },
      },
    ]);
  });

  it('rejects payloads whose published question snapshot exceeds the shared size budget', () => {
    const label = 'x'.repeat(1_100);
    const options = Array.from(
      { length: 128 },
      (_, index) => ({ id: `option-${index}`, label: `${index}-${label}` }),
    );

    try {
      parseGrokAskUserQuestionRequest(directPayload({
        questions: [{ question: 'Choose?', options }],
      }), context());
      throw new Error('expected Grok question payload rejection');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'GrokAskUserQuestionCodecError',
        code: 'GROK_QUESTION_PAYLOAD_TOO_LARGE',
      });
    }
  });

  it('preserves comma-bearing labels, freeform notes, and reserved record keys as exact data', () => {
    const parsed = parseGrokAskUserQuestionRequest(directPayload({
      questions: [
        {
          id: '__proto__',
          question: 'constructor',
          multiSelect: true,
          options: [
            { label: 'Washington, D.C.' },
            { label: 'Remote' },
          ],
        },
      ],
    }), context());
    const answers = Object.create(null) as Record<string, readonly string[]>;
    answers.__proto__ = ['Washington, D.C.', 'Typed\nvalue'];

    const response = buildGrokAskUserQuestionAcceptedResponse(parsed, answers);
    expect(response.outcome).toBe('accepted');
    expect(Object.getPrototypeOf(response.answers)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(response.answers, 'constructor')).toBe(true);
    expect(response.answers.constructor).toEqual(['Washington, D.C.', 'Other']);
    expect(Object.getPrototypeOf(response.annotations)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(response.annotations, 'constructor')).toBe(true);
    expect(response.annotations?.constructor).toEqual({ notes: 'Typed\nvalue' });
  });

  it('maps approved canonical answers to exact xAI text keys and preview annotations', async () => {
    const permissionHandler = new CapturingPermissionHandler({
      decision: 'approved',
      answers: { 'Which scope?': ['Workspace'] },
    });
    const result = await buildGrokExtensionHandlers({ permissionHandler }).requests![
      'x.ai/ask_user_question'
    ]!(directPayload(), context());

    expect(permissionHandler.calls).toEqual([
      {
        id: 'tool-1',
        toolName: 'AskUserQuestion',
        input: {
          _grokCorrelation: {
            v: 1,
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          questions: [
            {
              id: 'scope',
              header: 'Question',
              question: 'Which scope?',
              multiSelect: false,
              options: [
                { label: 'Workspace', description: 'Use this workspace' },
                { label: 'Session', description: 'Use this session' },
              ],
              freeform: { placeholder: 'Other' },
            },
          ],
        },
      },
    ]);
    expect(result).toEqual({
      outcome: 'accepted',
      answers: { 'Which scope?': ['Workspace'] },
      annotations: { 'Which scope?': { preview: 'Workspace preview' } },
    });
  });

  it('maps exact freeform text to the official Other answer and notes annotation', async () => {
    const typed = '  Keep commas, exactly\nand preserve the newline  ';
    const permissionHandler = new CapturingPermissionHandler({
      decision: 'approved',
      answers: { details: [typed] },
    });
    const result = await buildGrokExtensionHandlers({ permissionHandler }).requests![
      'x.ai/ask_user_question'
    ]!(directPayload({
      questions: [{ id: 'details', question: 'Describe the change', options: [] }],
    }), context());

    expect(result).toEqual({
      outcome: 'accepted',
      answers: { 'Describe the change': ['Other'] },
      annotations: { 'Describe the change': { notes: typed } },
    });
  });

  it('preserves a known option and maps one mixed freeform answer without delimiter encoding', async () => {
    const typed = 'A custom, multiline\nlocation';
    const session = new BaseBackedSession();
    const permissionHandler = new BaseBackedPermissionHandler(session as unknown as ApiSessionClient);
    const result = buildGrokExtensionHandlers({ permissionHandler }).requests![
      'x.ai/ask_user_question'
    ]!(directPayload({
      questions: [{
        id: 'locations',
        question: 'Where?',
        multiSelect: true,
        options: [{ label: 'Washington, D.C.' }, { label: 'Remote' }],
      }],
    }), context());
    const rpc = session.rpcHandlerManager.handlers.get(
      SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
    );
    await rpc!({
      id: 'tool-1',
      structuredAnswersV1: { locations: ['Washington, D.C.', typed] },
    });

    await expect(result).resolves.toEqual({
      outcome: 'accepted',
      answers: { 'Where?': ['Washington, D.C.', 'Other'] },
      annotations: { 'Where?': { notes: typed } },
    });
  });

  it('rejects multiple freeform values that cannot fit the singular xAI notes annotation', () => {
    const parsed = parseGrokAskUserQuestionRequest(directPayload({
      questions: [{
        id: 'locations',
        question: 'Where?',
        multiSelect: true,
        options: [{ label: 'Remote' }],
      }],
    }), context());

    expect(() => buildGrokAskUserQuestionAcceptedResponse(parsed, {
      locations: ['First typed value', 'Second typed value'],
    })).toThrow('freeform');
  });

  it('keeps an exact known Other option without manufacturing freeform notes', () => {
    const parsed = parseGrokAskUserQuestionRequest(directPayload({
      questions: [{ id: 'choice', question: 'Choose?', options: [{ label: 'Other' }] }],
    }), context());

    expect(buildGrokAskUserQuestionAcceptedResponse(parsed, { choice: ['Other'] })).toEqual({
      outcome: 'accepted',
      answers: { 'Choose?': ['Other'] },
    });
  });

  it('rejects a known Other option combined with unmatched freeform text', () => {
    const parsed = parseGrokAskUserQuestionRequest(directPayload({
      questions: [{
        id: 'choice', question: 'Choose?', multiSelect: true,
        options: [{ label: 'Other' }, { label: 'Remote' }],
      }],
    }), context());

    expect(() => buildGrokAskUserQuestionAcceptedResponse(parsed, {
      choice: ['Other', 'Typed custom value'],
    })).toThrow(/ambiguous/i);
  });

  it.each(['denied', 'abort'] as const)('returns only cancelled for a %s decision', async (decision) => {
    const permissionHandler = new CapturingPermissionHandler({ decision });
    await expect(buildGrokExtensionHandlers({ permissionHandler }).requests![
      '_x.ai/ask_user_question'
    ]!(directPayload(), context({ method: '_x.ai/ask_user_question' }))).resolves.toEqual({
      outcome: 'cancelled',
    });
  });

  it.each([
    ['missing answer', {}],
    ['empty answer', { scope: [] }],
    ['whitespace-only freeform answer', { scope: ['   '] }],
    ['extra answer key', { scope: ['Workspace'], unexpected: ['Session'] }],
    ['multiple answers for a single-select question', { scope: ['Workspace', 'Session'] }],
  ])('keeps the live waiter retryable when a modern %s is rejected before coordinator commit', async (_case, invalidAnswers) => {
    const session = new BaseBackedSession();
    const permissionHandler = new BaseBackedPermissionHandler(session as unknown as ApiSessionClient);
    const extensionPromise = buildGrokExtensionHandlers({ permissionHandler }).requests![
      'x.ai/ask_user_question'
    ]!(directPayload(), context());
    const rpc = session.rpcHandlerManager.handlers.get(
      SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
    );
    expect(rpc).toBeDefined();

    await expect(rpc!({
      id: 'tool-1',
      structuredAnswersV1: invalidAnswers,
    })).rejects.toBeDefined();
    expect(session.agentState.requests['tool-1']).toBeDefined();
    expect(session.agentState.completedRequests['tool-1']).toBeUndefined();

    await rpc!({
      id: 'tool-1',
      structuredAnswersV1: { scope: ['Workspace'] },
    });
    await expect(extensionPromise).resolves.toEqual({
      outcome: 'accepted',
      answers: { 'Which scope?': ['Workspace'] },
      annotations: { 'Which scope?': { preview: 'Workspace preview' } },
    });
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(expect.objectContaining({
      status: 'approved',
      decision: 'approved',
      structuredAnswersV1: { scope: ['Workspace'] },
    }));
  });

  it('completes a multi-question request with repeated display headers and mixed id/text answer keys', async () => {
    const session = new BaseBackedSession();
    const permissionHandler = new BaseBackedPermissionHandler(session as unknown as ApiSessionClient);
    const extensionPromise = buildGrokExtensionHandlers({ permissionHandler }).requests![
      'x.ai/ask_user_question'
    ]!(directPayload({
      questions: [
        { id: 'first', question: 'First question?', options: [{ label: 'A' }] },
        { id: 'second', question: 'Second question?', options: [{ label: 'B' }] },
      ],
    }), context());
    const rpc = session.rpcHandlerManager.handlers.get(
      SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
    );

    await rpc!({
      id: 'tool-1',
      structuredAnswersV1: { first: ['A'], 'Second question?': ['B'] },
    });
    await expect(extensionPromise).resolves.toEqual({
      outcome: 'accepted',
      answers: { 'First question?': ['A'], 'Second question?': ['B'] },
    });
    expect(session.agentState.completedRequests['tool-1']).toEqual(expect.objectContaining({
      structuredAnswersV1: { first: ['A'], 'Second question?': ['B'] },
    }));
  });

  it('rejects a conflicting repeated tool id through the canonical permission coordinator contract', async () => {
    const { coordinator, permissionHandler } = createCoordinatedPermissionHandler();
    const handler = buildGrokExtensionHandlers({ permissionHandler }).requests!['x.ai/ask_user_question']!;
    const first = handler(directPayload(), context());
    const conflicting = handler(directPayload({
      questions: [{ id: 'scope', question: 'Different?', options: [{ label: 'A' }] }],
    }), context());
    await expect(conflicting).rejects.toThrow('different tool input');
    const responseContext = coordinator.getLocallyOwnedLiveResponseContext('tool-1');
    if (!responseContext) throw new Error('Expected the first Grok question to own a live waiter');
    coordinator.completeResponse({
      context: responseContext,
      completion: {
        result: { decision: 'approved', answers: { scope: ['Workspace'] } },
        completedRequest: { status: 'approved', decision: 'approved' },
      },
    });
    await expect(first).resolves.toMatchObject({ outcome: 'accepted' });
  });

  it('rejects a repeated tool id when only provider-owned correlation fields differ', async () => {
    const { coordinator, permissionHandler } = createCoordinatedPermissionHandler();
    const handler = buildGrokExtensionHandlers({ permissionHandler }).requests!['x.ai/ask_user_question']!;
    const first = handler(directPayload(), context());
    const conflicting = handler(directPayload({
      mode: 'plan',
      questions: [{
        id: 'scope',
        question: 'Which scope?',
        options: [
          { id: 'workspace-v2', label: 'Workspace', description: 'Use this workspace', preview: 'Changed preview' },
          { id: 'session', label: 'Session', description: 'Use this session' },
        ],
      }],
    }), context());

    await expect(conflicting).rejects.toThrow('different tool input');
    const responseContext = coordinator.getLocallyOwnedLiveResponseContext('tool-1');
    if (!responseContext) throw new Error('Expected the first Grok question to remain live');
    coordinator.completeResponse({
      context: responseContext,
      completion: {
        result: { decision: 'approved', answers: { scope: ['Workspace'] } },
        completedRequest: { status: 'approved', decision: 'approved' },
      },
    });
    await expect(first).resolves.toMatchObject({ outcome: 'accepted' });
  });

  it('shares one canonical decision for an identical repeated tool id', async () => {
    const { coordinator, permissionHandler, completedRequestIds } = createCoordinatedPermissionHandler();
    const handler = buildGrokExtensionHandlers({ permissionHandler }).requests!['x.ai/ask_user_question']!;
    const first = handler(directPayload(), context());
    const repeated = handler(directPayload(), context());

    const responseContext = coordinator.getLocallyOwnedLiveResponseContext('tool-1');
    if (!responseContext) throw new Error('Expected repeated Grok question waiters to remain live');
    coordinator.completeResponse({
      context: responseContext,
      completion: {
        result: { decision: 'approved', answers: { scope: ['Workspace'] } },
        completedRequest: { status: 'approved', decision: 'approved' },
      },
    });

    await expect(Promise.all([first, repeated])).resolves.toEqual([
      expect.objectContaining({ outcome: 'accepted' }),
      expect.objectContaining({ outcome: 'accepted' }),
    ]);
    expect(completedRequestIds).toEqual(['tool-1']);
  });

  it('never returns accepted after the extension lifecycle aborts', async () => {
    const abortController = new AbortController();
    let resolveDecision: ((value: PermissionDecision) => void) | null = null;
    const permissionHandler: AcpPermissionHandler = {
      handleToolCall: async () => await new Promise<PermissionDecision>((resolve) => { resolveDecision = resolve; }),
    };
    const result = buildGrokExtensionHandlers({ permissionHandler }).requests![
      'x.ai/ask_user_question'
    ]!(directPayload(), context({ signal: abortController.signal }));
    abortController.abort(new Error('runtime disposed'));
    resolveDecision!({ decision: 'approved', answers: { scope: ['Workspace'] } });
    await expect(result).rejects.toThrow('runtime disposed');
  });
});
