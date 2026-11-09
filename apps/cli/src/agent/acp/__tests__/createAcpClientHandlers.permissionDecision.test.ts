import { describe, expect, it, vi } from 'vitest';

import { DefaultTransport } from '@/agent/transport';

import { createAcpClientHandlers } from '../createAcpClientHandlers';
import { createAcpTransportHandlerFromDefinition } from '../runtime/definition/transport';
import type { AcpPermissionHandler } from '../permissions/acpPermissionHandler';
import type { HandlerContext } from '../sessionUpdateHandlers';
import { createLegacyHandlerContextFixture } from './legacyToolRuntimeFixture';

function createHandlerContext(): HandlerContext {
  return createLegacyHandlerContextFixture();
}

describe('createAcpClientHandlers permission pre-prompt decisions', () => {
  it.each([false, true])('passes the plugin-resolved invocation to policy and transcript (awaitable=%s)', async (awaitable) => {
    const callbacks = {
      toolNameResolver: () => ({ toolName: 'Bash', input: { command: 'echo projected' } }),
    };
    const transport = createAcpTransportHandlerFromDefinition({ backendId: 'fixture', ...(awaitable ? {} : { callbacks }) });
    const emitted: unknown[] = [];
    const handlerContext = createLegacyHandlerContextFixture({ transport, emit: message => emitted.push(message) });
    let observed: unknown;
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined, transport, emit: () => undefined,
      ...(awaitable ? { resolveToolNameAwaitable: async () => callbacks.toolNameResolver() } : {}),
      permissionHandler: { handleToolCall: async (_id, toolName, input) => {
        observed = { toolName, input }; return { decision: 'denied' };
      } },
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: async () => undefined }),
      emitPermissionResponse: async () => undefined, clearTrackedToolCall: () => undefined,
      incrementToolCallCountSincePrompt: () => undefined, toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });
    await client.requestPermission({ sessionId: 'session-1', toolCall: {
      toolCallId: 'call', kind: 'other', title: 'Native wrapper', rawInput: { params: { command: 'echo projected' } },
    }, options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }] });
    expect(observed).toEqual({ toolName: 'Bash', input: { command: 'echo projected' } });
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'tool-call', toolName: 'Bash',
      args: expect.objectContaining({ command: 'echo projected' }) }));
  });

  it('returns a cancelled response when the provider cannot establish permission ownership', async () => {
    const handlerContext = createLegacyHandlerContextFixture();
    const effects: string[] = [];
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined, transport: new DefaultTransport('test'), emit: () => undefined,
      beforePermissionRequest: async () => { throw new Error('No originating turn'); },
      permissionHandler: { handleToolCall: async () => { effects.push('policy'); return { decision: 'approved' }; } },
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: async () => { effects.push('cancel'); } }),
      emitPermissionResponse: async () => { effects.push('response'); },
      clearTrackedToolCall: () => undefined, incrementToolCallCountSincePrompt: () => undefined,
      toolCalls: handlerContext.toolCalls, lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });

    await expect(client.requestPermission({ sessionId: 'session-1', toolCall: {
      toolCallId: 'call', kind: 'other', title: 'Read', rawInput: {},
    }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(effects).toEqual([]);
  });

  it.each([
    { awaitable: false, passthrough: false },
    { awaitable: true, passthrough: false },
    { awaitable: true, passthrough: true },
  ])('retains permission risk inference with native codec identity ($awaitable/$passthrough)', async ({ awaitable, passthrough }) => {
    let nativeName: string | undefined;
    const resolve = (request: { toolName: string }) => { nativeName = request.toolName; return passthrough ? request.toolName : null; };
    const transport = createAcpTransportHandlerFromDefinition({ backendId: 'fixture',
      ...(awaitable ? {} : { callbacks: { toolNameResolver: resolve } }) });
    const handlerContext = createLegacyHandlerContextFixture({ transport });
    let policyName: string | undefined;
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined, transport, emit: () => undefined,
      ...(awaitable ? { resolveToolNameAwaitable: async (request: { toolName: string }) => resolve(request) } : {}),
      permissionHandler: { handleToolCall: async (_id, name) => { policyName = name; return { decision: 'denied' }; } },
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: async () => undefined }),
      emitPermissionResponse: async () => undefined, clearTrackedToolCall: () => undefined,
      incrementToolCallCountSincePrompt: () => undefined, toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });
    await client.requestPermission({ sessionId: 'session-1', toolCall: {
      toolCallId: 'call', kind: 'read', title: 'Bash', rawInput: { command: 'pwd' },
    }, options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }] });
    expect(nativeName).toBe('read');
    expect(policyName).toBe('Bash');
  });

  it('cancels an unresolvable permission identity before consulting policy', async () => {
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'fixture', callbacks: { toolNameResolver: () => { throw new Error('Ambiguous tool identity'); } },
    });
    const handlerContext = createLegacyHandlerContextFixture({ transport });
    const order: string[] = [];
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined, transport, emit: () => undefined,
      permissionHandler: { handleToolCall: async () => { order.push('policy'); return { decision: 'approved' }; } },
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: async () => { order.push('cancel'); } }),
      emitPermissionResponse: async (_id, approved) => { order.push(approved ? 'allowed' : 'denied'); },
      clearTrackedToolCall: () => undefined, incrementToolCallCountSincePrompt: () => undefined,
      toolCalls: handlerContext.toolCalls, lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });
    await expect(client.requestPermission({ sessionId: 'session-1', toolCall: {
      toolCallId: 'call', kind: 'other', title: 'docs_file_read', rawInput: {},
    }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(order).toEqual(['cancel', 'denied']);
  });

  it('provides standard ACP permission title metadata to the leaf resolver without changing operands', async () => {
    let observed: Readonly<Record<string, unknown>> | undefined;
    const transport = createAcpTransportHandlerFromDefinition({
      backendId: 'fixture', callbacks: { toolNameResolver: request => { observed = request.input; return null; } },
    });
    const handlerContext = createLegacyHandlerContextFixture({ transport });
    const client = createAcpClientHandlers({
      onSessionUpdate: () => undefined, transport, emit: () => undefined,
      createHandlerContext: () => handlerContext,
      getToolNameContext: () => ({ recentPromptHadChangeTitle: false, toolCallCountSincePrompt: 0 }),
      getActiveSessionId: () => 'session-1',
      capturePermissionRequest: () => ({ scope: 'turn', isCurrent: () => true, cancel: async () => undefined }),
      emitPermissionResponse: async () => undefined, clearTrackedToolCall: () => undefined,
      incrementToolCallCountSincePrompt: () => undefined, toolCalls: handlerContext.toolCalls,
      lastSelectedPermissionOptionIdByToolCallId: new Map(),
    });
    const rawInput = { path: 'README.md', _acp: { title: 'mcp__docs__other_tool' } };
    await client.requestPermission({ sessionId: 'session-1', toolCall: {
      toolCallId: 'call', kind: 'other', title: 'mcp__docs__read_file', rawInput,
    }, options: [{ optionId: 'deny', kind: 'reject_once', name: 'Deny' }] });
    expect(observed).toEqual({ path: 'README.md', _acp: { title: 'mcp__docs__read_file', kind: 'other' } });
    expect(rawInput).toEqual({ path: 'README.md', _acp: { title: 'mcp__docs__other_tool' } });
  });

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


});
