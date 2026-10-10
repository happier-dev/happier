import { describe, expect, it, vi } from 'vitest';

import { DefaultTransport } from '@/agent/transport';

import { createAcpClientHandlers } from '../createAcpClientHandlers';
import type { AcpPermissionHandler } from '../permissions/acpPermissionHandler';
import type { HandlerContext } from '../sessionUpdateHandlers';
import { createLegacyHandlerContextFixture } from './legacyToolRuntimeFixture';

function createHandlerContext(): HandlerContext {
  return createLegacyHandlerContextFixture();
}

describe('createAcpClientHandlers permission pre-prompt decisions', () => {
  it('surfaces a recoverable Workflow interaction capacity failure to the ACP turn owner', async () => {
    const capacityError = Object.assign(
      new Error('Workflow interaction exceeds durable capacity'),
      { code: 'workflow_interaction_capacity_exceeded', recoverable: true as const },
    );
    const cancel = vi.fn(async (_failure?: Error) => undefined);
    const handlerContext = createHandlerContext();
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined,
      transport: new DefaultTransport('test'),
      emit: () => undefined,
      permissionHandler: { handleToolCall: async () => { throw capacityError; } },
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel }),
      emitPermissionResponse: vi.fn(async () => undefined),
      clearTrackedToolCall: vi.fn(),
      incrementToolCallCountSincePrompt: vi.fn(),
      toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });

    await client.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-capacity', kind: 'write', toolName: 'Write' },
      options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
    } as never);

    expect(cancel).toHaveBeenCalledWith(capacityError);
  });

  it('starts cancellation before publishing a denied permission response', async () => {
    const order: string[] = [];
    const handlerContext = createHandlerContext();
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined,
      transport: new DefaultTransport('test'),
      emit: () => undefined,
      permissionHandler: { handleToolCall: async () => ({ decision: 'denied' as const }) },
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: async () => { order.push('cancel'); } }),
      emitPermissionResponse: async () => { order.push('response'); },
      clearTrackedToolCall: () => { order.push('terminalize'); },
      incrementToolCallCountSincePrompt: () => undefined,
      toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });

    await client.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', kind: 'write' },
      options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }],
    } as never);

    expect(order).toEqual(['cancel', 'response']);
  });

  it('denies permission requests when no permission handler is wired', async () => {
    const emitted: unknown[] = [];
    const emitPermissionResponse = vi.fn(async () => undefined);
    const clearTrackedToolCall = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const handlerContext = createHandlerContext();
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined,
      transport: new DefaultTransport('test'),
      emit: (message) => {
        emitted.push(message);
      },
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({
        recentPromptHadChangeTitle: false,
        toolCallCountSincePrompt: 0,
      }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel }),
      emitPermissionResponse,
      clearTrackedToolCall,
      incrementToolCallCountSincePrompt: vi.fn(),
      toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });

    await expect(client.requestPermission({
      toolCall: {
        toolCallId: 'tool-1',
        kind: 'write',
        toolName: 'write',
        rawInput: { path: 'README.md' },
      },
      options: [
        { optionId: 'allow-once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
      ],
    } as never)).resolves.toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'reject-once',
      },
    });

    expect(emitted).not.toContainEqual(expect.objectContaining({ type: 'permission-request' }));
    expect(emitPermissionResponse).toHaveBeenCalledWith('tool-1', false);
    expect(cancel).toHaveBeenCalledWith(undefined);
  });

  it('preserves an exact nonblank opaque tool-call id across permission correlation', async () => {
    const opaqueToolCallId = ' tool\ncall ';
    const emitted: unknown[] = [];
    const emitPermissionResponse = vi.fn(async () => undefined);
    const clearTrackedToolCall = vi.fn();
    const handlerContext = createHandlerContext();
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined,
      transport: new DefaultTransport('test'),
      emit: (message) => { emitted.push(message); },
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({
        recentPromptHadChangeTitle: false,
        toolCallCountSincePrompt: 0,
      }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: vi.fn(async () => undefined) }),
      emitPermissionResponse,
      clearTrackedToolCall,
      incrementToolCallCountSincePrompt: vi.fn(),
      toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });

    await client.requestPermission({
      toolCall: {
        toolCallId: opaqueToolCallId,
        kind: 'write',
        rawInput: { path: 'README.md' },
      },
      options: [{ optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }],
    } as never);

    expect(emitPermissionResponse).toHaveBeenCalledWith(opaqueToolCallId, false);
    expect(emitted).not.toContainEqual(expect.objectContaining({ type: 'permission-request' }));
  });

  it('awaits async pre-prompt permission decisions before emitting user prompts', async () => {
    const emitted: unknown[] = [];
    const emitPermissionResponse = vi.fn(async () => undefined);
    const fallbackHandleToolCall = vi.fn(async () => ({ decision: 'denied' as const }));
    const permissionHandler = {
      resolvePrePromptDecision: vi.fn(async () => ({ decision: 'approved' as const, rationale: 'plugin approved' })),
      handleToolCall: fallbackHandleToolCall,
    } as unknown as AcpPermissionHandler;
    const handlerContext = createHandlerContext();
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined,
      transport: new DefaultTransport('test'),
      emit: (message) => {
        emitted.push(message);
      },
      permissionHandler,
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({
        recentPromptHadChangeTitle: false,
        toolCallCountSincePrompt: 0,
      }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: vi.fn(async () => undefined) }),
      emitPermissionResponse,
      clearTrackedToolCall: vi.fn(),
      incrementToolCallCountSincePrompt: vi.fn(),
      toolCalls: handlerContext.toolCalls,
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
    expect(emitPermissionResponse).toHaveBeenCalledWith('tool-1', true);
  });

  it('does not count a permission observation as a second distinct tool call', async () => {
    const handlerContext = createHandlerContext();
    handlerContext.toolCalls.handleRawUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read README',
      kind: 'read',
      status: 'pending',
    });
    const incrementToolCallCountSincePrompt = vi.fn();
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined,
      transport: new DefaultTransport('test'),
      emit: () => undefined,
      permissionHandler: { handleToolCall: async () => ({ decision: 'approved' as const }) },
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 1 }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: vi.fn(async () => undefined) }),
      emitPermissionResponse: vi.fn(async () => undefined),
      clearTrackedToolCall: vi.fn(),
      incrementToolCallCountSincePrompt,
      toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });

    await client.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', kind: 'read' },
      options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }],
    } as never);

    expect(incrementToolCallCountSincePrompt).not.toHaveBeenCalled();
  });

  it.each([
    ['async pre-prompt rejection', {
      resolvePrePromptDecision: async () => { throw new Error('resolver failed'); },
      handleToolCall: async () => ({ decision: 'approved' as const }),
    }],
    ['synchronous immediate-decision throw', {
      getImmediateDecision: () => { throw new Error('immediate failed'); },
      handleToolCall: async () => ({ decision: 'approved' as const }),
    }],
  ] as const)('cancels and terminalizes when %s fails', async (_label, permissionHandler) => {
    const order: string[] = [];
    const handlerContext = createHandlerContext();
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined,
      transport: new DefaultTransport('test'),
      emit: () => undefined,
      permissionHandler,
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: async () => { order.push('cancel'); } }),
      emitPermissionResponse: async () => { order.push('response'); },
      clearTrackedToolCall: () => { order.push('terminalize'); },
      incrementToolCallCountSincePrompt: vi.fn(),
      toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });

    await expect(client.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-failure', kind: 'read' },
      options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow' }],
    } as never)).resolves.toEqual({ outcome: { outcome: 'cancelled' } });

    expect(order).toEqual(['cancel', 'response']);
  });
});
