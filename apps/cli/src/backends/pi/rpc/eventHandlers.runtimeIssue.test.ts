import { describe, expect, it, vi } from 'vitest';

import { handlePiRpcResponse } from './eventHandlers';
import type { PiRpcEventHandlerContext } from './eventHandlers';

function createContext(overrides?: Partial<PiRpcEventHandlerContext>): PiRpcEventHandlerContext {
  return {
    disposed: false,
    messageHandlers: new Set(),
    pendingRequests: new Map(),
    openPromptRequestIds: new Set(),
    resolvePendingTurn: vi.fn(),
    rejectPendingTurn: vi.fn(),
    publishUsageStatsBestEffort: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('Pi RPC runtime issue surfacing', () => {
  it('surfaces a failed primary turn when an open prompt response is rejected after request cleanup', () => {
    const emitMessage = vi.fn();
    const surfacePrimarySessionRuntimeIssue = vi.fn();
    const context = createContext({
      openPromptRequestIds: new Set(['prompt-1']),
      surfacePrimarySessionRuntimeIssue,
    } as Partial<PiRpcEventHandlerContext>);

    handlePiRpcResponse(context, emitMessage, {
      id: 'prompt-1',
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'quota exceeded',
    } as any);

    expect(surfacePrimarySessionRuntimeIssue).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'pi',
      cause: 'status_error',
      error: 'quota exceeded',
    }));
  });
});
