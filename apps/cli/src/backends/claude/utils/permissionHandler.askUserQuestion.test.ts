import { describe, expect, it, vi } from 'vitest';

import type { SDKAssistantMessage } from '../sdk';
import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

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
});

