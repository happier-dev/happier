import { describe, expect, it, vi } from 'vitest';

import type { SDKAssistantMessage } from '../sdk';
import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';
import type { PermissionRpcPayload } from './permissionRpc';
import type { StructuredQuestionResponseV1 } from '@happier-dev/protocol';

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

function askUserQuestionToolUseMessage(name: 'AskUserQuestion' | 'ask_user_question' = 'AskUserQuestion'): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_ask_1',
          name,
          input: {
            questions: [
              {
                header: 'OS',
                question: 'Which OS?',
                multiSelect: false,
                options: [
                  { label: 'macOS', description: 'Apple' },
                  { label: 'Linux', description: 'Linux' },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}

const defaultMode = { permissionMode: 'default' } as EnhancedMode;

async function expectResolvesWithin<T>(promise: Promise<T>, ms = 250): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe('PermissionHandler (AskUserQuestion)', () => {
  it('publishes Claude implicit freeform answers through the shared SDK permission path', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s-claude-freeform');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    const input = askUserQuestionToolUseMessage().message.content[0]!.input;
    const controller = new AbortController();

    const pending = handler.handleToolCall(
      'AskUserQuestion',
      input,
      defaultMode,
      { signal: controller.signal, toolUseId: 'toolu_ask_freeform_1' },
    );

    expect(client.getAgentStateSnapshot().requests.toolu_ask_freeform_1).toMatchObject({
      arguments: {
        questions: [
          expect.objectContaining({ freeform: {} }),
        ],
      },
    });

    await client.rpcHandlerManager.getHandler('permission')?.({
      id: 'toolu_ask_freeform_1',
      approved: false,
      reason: 'test complete',
    } satisfies PermissionRpcPayload);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('denies AskUserQuestion with the provided reason, and does not abort the remote loop', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(askUserQuestionToolUseMessage());

    const resultPromise = handler.handleToolCall(
      'AskUserQuestion',
      askUserQuestionToolUseMessage().message.content[0]!.input,
      defaultMode,
      { signal: new AbortController().signal },
    );

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({ id: 'toolu_ask_1', approved: false, reason: 'Not now' } as any);
    await expect(resultPromise).resolves.toMatchObject({ behavior: 'deny', message: 'Not now' });

    expect(handler.isAborted('toolu_ask_1')).toBe(false);
  });

  it.each(['AskUserQuestion', 'ask_user_question'] as const)('resolves duplicate %s waiters with one answer payload', async (toolName) => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    const input = askUserQuestionToolUseMessage(toolName).message.content[0]!.input as Record<string, unknown>;
    const sharedToolUseId = 'toolu_ask_duplicate_1';

    const first = handler.handleToolCall(
      toolName,
      input,
      defaultMode,
      { signal: new AbortController().signal, toolUseId: sharedToolUseId },
    );
    const second = handler.handleToolCall(
      toolName,
      input,
      defaultMode,
      { signal: new AbortController().signal, toolUseId: sharedToolUseId },
    );

    expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual([sharedToolUseId]);

    const legacyAnswers = { 'Which OS?': 'macOS' };
    const structuredAnswers = { 'Which OS?': ['macOS'] };
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: sharedToolUseId,
      approved: true,
      answers: legacyAnswers,
    } satisfies PermissionRpcPayload);

    const expected = {
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: legacyAnswers,
      },
    };
    await expect(expectResolvesWithin(Promise.all([first, second]))).resolves.toEqual([expected, expected]);
    expect(client.getAgentStateSnapshot().requests[sharedToolUseId]).toBeUndefined();
    expect(client.getAgentStateSnapshot().completedRequests[sharedToolUseId]).toMatchObject({
      status: 'approved',
      structuredAnswersV1: structuredAnswers,
    });
  });

  it('projects canonical multi/freeform answers to Claude scalar strings without prototype-key loss', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s-claude-answer-projection');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    const input = {
      questions: [
        { header: 'A', question: '__proto__', multiSelect: true, options: [{ label: 'A, B' }, { label: 'Line\nTwo' }], freeform: {} },
      ],
    };
    const pending = handler.handleToolCall(
      'AskUserQuestion',
      input,
      defaultMode,
      { signal: new AbortController().signal, toolUseId: 'toolu_projection_1' },
    );
    await client.rpcHandlerManager.getHandler<StructuredQuestionResponseV1>('session.structuredQuestion.respond.v1')?.({
      id: 'toolu_projection_1',
      structuredAnswersV1: { ['__proto__']: ['A, B', 'Line\nTwo'] },
    });

    const result = await pending;
    expect(result).toMatchObject({ behavior: 'allow' });
    const answers = (result as any).updatedInput.answers;
    expect(Object.getPrototypeOf(answers)).toBeNull();
    expect(Object.keys(answers)).toEqual(['__proto__']);
    expect(answers.__proto__).toBe('A, B, Line\nTwo');
  });
});
