import { describe, expect, it, vi } from 'vitest';

import { createCodexRequestUserInputBridge } from './codexRequestUserInputBridge';

describe('createCodexRequestUserInputBridge', () => {
  it('requests permission and resumes Codex with the selected approval option', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved_for_session' }),
    };
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const logger = { debug: vi.fn() };

    const bridge = createCodexRequestUserInputBridge({
      permissionHandler: permissionHandler as any,
      continueSession,
      logger,
    });

    await bridge.onCodexEvent({
      type: 'raw_response_item',
      item: {
        type: 'function_call',
        name: 'mcp__playwright__browser_navigate',
        arguments: '{"url":"https://example.com"}',
        call_id: 'call_1',
      },
    });

    await bridge.onCodexEvent({
      type: 'request_user_input',
      call_id: 'call_1',
      turn_id: '1',
      questions: [
        {
          id: 'mcp_tool_call_approval_call_1',
          header: 'Approve app tool call?',
          question: 'Allow this action?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Approve Once', description: 'Run the tool and continue.' },
            { label: 'Approve this Session', description: 'Run the tool and remember this choice for this session.' },
            { label: 'Deny', description: 'Decline this tool call and continue.' },
            { label: 'Cancel', description: 'Cancel this tool call' },
          ],
        },
      ],
    });

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'call_1',
      'mcp__playwright__browser_navigate',
      expect.objectContaining({
        url: 'https://example.com',
        requestUserInput: expect.any(Object),
      }),
    );

    // approved_for_session -> Approve this Session
    expect(continueSession).toHaveBeenCalledWith('Approve this Session');
  });

  it('falls back to a valid option label when the expected approval label is missing', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved' }),
    };
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const logger = { debug: vi.fn() };

    const bridge = createCodexRequestUserInputBridge({
      permissionHandler: permissionHandler as any,
      continueSession,
      logger,
    });

    await bridge.onCodexEvent({
      type: 'raw_response_item',
      item: {
        type: 'function_call',
        name: 'mcp__playwright__browser_navigate',
        arguments: '{"url":"https://example.com"}',
        call_id: 'call_2',
      },
    });

    await bridge.onCodexEvent({
      type: 'request_user_input',
      call_id: 'call_2',
      turn_id: '1',
      questions: [
        {
          id: 'mcp_tool_call_approval_call_2',
          header: 'Approve app tool call?',
          question: 'Allow this action?',
          options: [
            { label: 'Allow', description: 'Run the tool and continue.' },
            { label: 'Reject', description: 'Decline this tool call and continue.' },
          ],
        },
      ],
    });

    expect(permissionHandler.handleToolCall).toHaveBeenCalled();
    expect(continueSession).toHaveBeenCalledWith('Allow');
  });

  it('ignores request_user_input prompts that are not MCP tool approvals', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved' }),
    };
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const logger = { debug: vi.fn() };

    const bridge = createCodexRequestUserInputBridge({
      permissionHandler: permissionHandler as any,
      continueSession,
      logger,
    });

    await bridge.onCodexEvent({
      type: 'request_user_input',
      call_id: 'call_1',
      questions: [
        {
          id: 'some_other_prompt',
          header: 'Question',
          question: 'Hello?',
          options: [],
        },
      ],
    });

    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
  });
});
