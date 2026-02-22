import { describe, expect, it } from 'vitest';

import type { EnhancedMode } from '../loop';
import type { SDKAssistantMessage } from '../sdk';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

describe('PermissionHandler (mode parameter precedence)', () => {
  const askUserQuestionToolUseMessage = (): SDKAssistantMessage => ({
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
  });

  const exitPlanModeToolUseMessage = (): SDKAssistantMessage => ({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_plan_1',
          name: 'ExitPlanMode',
          input: { plan: 'p1' },
        },
      ],
    },
  });

  it('auto-allows tool calls when mode.permissionMode is bypassPermissions even if handler state is default', async () => {
    const { session } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const controller = new AbortController();
    const mode = { permissionMode: 'bypassPermissions' } as EnhancedMode;

    await expect(
      handler.handleToolCall('Read', { file_path: '/tmp/file.txt' }, mode, { signal: controller.signal }),
    ).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('does not auto-allow AskUserQuestion when mode.permissionMode is bypassPermissions', async () => {
    const { session, client } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(askUserQuestionToolUseMessage());

    const controller = new AbortController();
    const mode = { permissionMode: 'bypassPermissions' } as EnhancedMode;

    const resultPromise = handler.handleToolCall(
      'AskUserQuestion',
      askUserQuestionToolUseMessage().message.content[0]!.input,
      mode,
      { signal: controller.signal },
    );

    expect(Object.keys(client.agentState.requests)).toEqual(['toolu_ask_1']);

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({ id: 'toolu_ask_1', approved: true, answers: { 'Which OS?': 'macOS' } } as any);
    await expect(resultPromise).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: expect.objectContaining({ answers: { 'Which OS?': 'macOS' } }),
    });
  });

  it('does not auto-allow ExitPlanMode when mode.permissionMode is bypassPermissions', async () => {
    const { session, client } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.onMessage(exitPlanModeToolUseMessage());

    const controller = new AbortController();
    const mode = { permissionMode: 'bypassPermissions' } as EnhancedMode;

    const resultPromise = handler.handleToolCall('ExitPlanMode', { plan: 'p1' }, mode, { signal: controller.signal });

    expect(Object.keys(client.agentState.requests)).toEqual(['toolu_plan_1']);

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeDefined();

    await permissionRpc?.({ id: 'toolu_plan_1', approved: true } as any);
    await expect(resultPromise).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'p1' } });
  });

  it('auto-allows edit tools when mode.permissionMode is acceptEdits even if handler state is default', async () => {
    const { session } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const controller = new AbortController();
    const mode = { permissionMode: 'acceptEdits' } as EnhancedMode;

    await expect(
      handler.handleToolCall(
        'Edit',
        { file_path: '/tmp/file.txt', old_string: 'a', new_string: 'b' },
        mode,
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('reset clears bypassPermissions so default mode requires a permission request', async () => {
    const { session, client } = createPermissionHandlerSessionStub();
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    handler.handleModeChange('bypassPermissions');
    handler.reset();

    handler.onMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'test-tool-2',
            name: 'Bash',
            input: { command: 'rm -rf /' },
          },
        ],
      },
    } as any);

    const controller = new AbortController();
    const mode = { permissionMode: 'default' } as EnhancedMode;
    void handler.handleToolCall('Bash', { command: 'rm -rf /' }, mode, { signal: controller.signal });

    expect(Object.keys(client.agentState.requests)).toEqual(['test-tool-2']);
  });
});
