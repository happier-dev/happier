import { describe, expect, it, vi } from 'vitest';

import { DefaultTransport } from '@/agent/transport';

import { createAcpSdkClient } from '../createAcpSdkClient';
import type { AcpPermissionHandler } from '../permissions/acpPermissionHandler';
import type { HandlerContext } from '../sessionUpdateHandlers';

function createHandlerContext(): HandlerContext {
  return {
    transport: new DefaultTransport('test'),
    activeToolCalls: new Set(),
    finalizedToolCalls: new Set(),
    toolCallLifecycleStates: new Map(),
    toolCallStartTimes: new Map(),
    toolCallTimeouts: new Map(),
    toolCallIdToNameMap: new Map(),
    toolCallIdToInputMap: new Map(),
    idleTimeout: null,
    toolCallCountSincePrompt: 0,
    emit: () => undefined,
    emitIdleStatus: () => undefined,
    clearIdleTimeout: () => undefined,
    setIdleTimeout: () => undefined,
  };
}

describe('createAcpSdkClient permission pre-prompt decisions', () => {
  it('awaits async pre-prompt permission decisions before emitting user prompts', async () => {
    const emitted: unknown[] = [];
    const respondToPermission = vi.fn(async () => undefined);
    const fallbackHandleToolCall = vi.fn(async () => ({ decision: 'denied' as const }));
    const permissionHandler = {
      resolvePrePromptDecision: vi.fn(async () => ({ decision: 'approved' as const, rationale: 'plugin approved' })),
      handleToolCall: fallbackHandleToolCall,
    } as unknown as AcpPermissionHandler;
    const client = createAcpSdkClient({
      onSessionUpdate: () => undefined,
      transport: new DefaultTransport('test'),
      emit: (message) => {
        emitted.push(message);
      },
      permissionHandler,
      createHandlerContext,
      getToolNameContext: () => ({
        recentPromptHadChangeTitle: false,
        toolCallCountSincePrompt: 0,
      }),
      getActiveSessionId: () => 'session-1',
      cancel: vi.fn(async () => undefined),
      respondToPermission,
      clearTrackedToolCall: vi.fn(),
      incrementToolCallCountSincePrompt: vi.fn(),
      toolCallIdToNameMap: new Map(),
      toolCallIdToInputMap: new Map(),
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });

    await expect(client.requestPermission({
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'read',
        toolName: 'read',
        rawInput: { path: 'README.md' },
      },
      options: [
        { optionId: 'allow-once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
      ],
    } as never)).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow-once',
      },
    });

    expect(emitted).not.toContainEqual(expect.objectContaining({ type: 'permission-request' }));
    expect(fallbackHandleToolCall).not.toHaveBeenCalled();
    expect(respondToPermission).toHaveBeenCalledWith('tool-1', true);
  });
});
