import { describe, expect, it, vi } from 'vitest';

import type { SDKAssistantMessage } from '../sdk';
import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';
import type { PermissionRpcPayload } from './permissionRpc';

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

function askUserQuestionToolUseMessage(): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_ask_1',
          name: 'AskUserQuestion',
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

  it('resolves duplicate AskUserQuestion waiters with one answer payload', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');

    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    const input = askUserQuestionToolUseMessage().message.content[0]!.input as Record<string, unknown>;
    const sharedToolUseId = 'toolu_ask_duplicate_1';

    const first = handler.handleToolCall(
      'AskUserQuestion',
      input,
      defaultMode,
      { signal: new AbortController().signal, toolUseId: sharedToolUseId },
    );
    const second = handler.handleToolCall(
      'AskUserQuestion',
      input,
      defaultMode,
      { signal: new AbortController().signal, toolUseId: sharedToolUseId },
    );

    expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual([sharedToolUseId]);

    const answers = { q1: 'macOS' };
    await client.rpcHandlerManager.getHandler('permission')?.({
      id: sharedToolUseId,
      approved: true,
      answers,
    } satisfies PermissionRpcPayload);

    const expected = {
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers,
      },
    };
    await expect(expectResolvesWithin(Promise.all([first, second]))).resolves.toEqual([expected, expected]);
    expect(client.getAgentStateSnapshot().requests[sharedToolUseId]).toBeUndefined();
    expect(client.getAgentStateSnapshot().completedRequests[sharedToolUseId]).toMatchObject({
      status: 'approved',
      answers,
    });
  });
});
