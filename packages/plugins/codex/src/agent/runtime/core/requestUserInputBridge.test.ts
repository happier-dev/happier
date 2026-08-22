import { describe, expect, it, vi } from 'vitest';

import { createCodexRequestUserInputBridge } from './requestUserInputBridge.js';

type RequestPermissionDecision = Parameters<typeof createCodexRequestUserInputBridge>[0]['requestPermissionDecision'];

describe('createCodexRequestUserInputBridge', () => {
  it('requests permission and resumes Codex with the selected approval option', async () => {
    const requestPermissionDecision = vi
      .fn()
      .mockResolvedValue({ decision: 'approved_for_session' }) satisfies NonNullable<RequestPermissionDecision>;
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const logger = { debug: vi.fn() };

    const bridge = createCodexRequestUserInputBridge({
      requestPermissionDecision,
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

    expect(requestPermissionDecision).toHaveBeenCalledWith({
      toolCallId: 'call_1',
      toolName: 'mcp__playwright__browser_navigate',
      input: expect.objectContaining({
        url: 'https://example.com',
        requestUserInput: expect.any(Object),
      }),
    });

    expect(continueSession).toHaveBeenCalledWith('Approve this Session');
  });

  it('falls back to a valid option label when the expected approval label is missing', async () => {
    const requestPermissionDecision = vi
      .fn()
      .mockResolvedValue({ decision: 'approved' }) satisfies NonNullable<RequestPermissionDecision>;
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const logger = { debug: vi.fn() };

    const bridge = createCodexRequestUserInputBridge({
      requestPermissionDecision,
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

    expect(requestPermissionDecision).toHaveBeenCalled();
    expect(continueSession).toHaveBeenCalledWith('Allow');
  });

  it('ignores request_user_input prompts that are not MCP tool approvals', async () => {
    const requestPermissionDecision = vi
      .fn()
      .mockResolvedValue({ decision: 'approved' }) satisfies NonNullable<RequestPermissionDecision>;
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const logger = { debug: vi.fn() };

    const bridge = createCodexRequestUserInputBridge({
      requestPermissionDecision,
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

    expect(requestPermissionDecision).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
  });

  it('never resumes Codex with a positive option after a denied decision', async () => {
    const requestPermissionDecision = vi
      .fn()
      .mockResolvedValue({ decision: 'denied' }) satisfies NonNullable<RequestPermissionDecision>;
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const logger = { debug: vi.fn() };

    const bridge = createCodexRequestUserInputBridge({
      requestPermissionDecision,
      continueSession,
      logger,
    });

    await bridge.onCodexEvent({
      type: 'request_user_input',
      call_id: 'call_deny_only_positive',
      turn_id: '1',
      questions: [
        {
          id: 'mcp_tool_call_approval_call_deny_only_positive',
          header: 'Approve app tool call?',
          question: 'Allow this action?',
          options: [{ label: 'Approve Once', description: 'Run the tool and continue.' }],
        },
      ],
    });

    expect(requestPermissionDecision).toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
  });

  it('resolves the decline label from the approval question, not a sibling question', async () => {
    const requestPermissionDecision = vi
      .fn()
      .mockResolvedValue({ decision: 'denied' }) satisfies NonNullable<RequestPermissionDecision>;
    const continueSession = vi.fn().mockResolvedValue(undefined);
    const logger = { debug: vi.fn() };

    const bridge = createCodexRequestUserInputBridge({
      requestPermissionDecision,
      continueSession,
      logger,
    });

    await bridge.onCodexEvent({
      type: 'request_user_input',
      call_id: 'call_sibling',
      turn_id: '1',
      questions: [
        {
          id: 'note',
          header: 'Note',
          question: 'Any release note?',
          options: [{ label: 'Approve the design doc' }],
        },
        {
          id: 'mcp_tool_call_approval_call_sibling',
          header: 'Approve app tool call?',
          question: 'Allow this action?',
          options: [
            { label: 'Approve Once', description: 'Run the tool and continue.' },
            { label: 'Deny', description: 'Decline this tool call and continue.' },
          ],
        },
      ],
    });

    expect(continueSession).toHaveBeenCalledWith('Deny');
  });
});
