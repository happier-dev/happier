import { describe, expect, it, vi } from 'vitest';
import { RuntimeEventV1Schema } from '@happier-dev/protocol';

import { surfacePrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';

import { createPiRpcRuntimeTurnState, handlePiRpcEvent, handlePiRpcResponse } from './eventHandlers';
import type { PiRpcEventHandlerContext } from './eventHandlers';

function createContext(overrides?: Partial<PiRpcEventHandlerContext>): PiRpcEventHandlerContext {
  return {
    disposed: false,
    messageHandlers: new Set(),
    pendingRequests: new Map(),
    openPromptRequestIds: new Set(),
    runtimeTurnState: createPiRpcRuntimeTurnState(),
    resolvePendingTurn: vi.fn(),
    rejectPendingTurn: vi.fn(),
    notePendingTurnActivity: vi.fn(),
    keepPendingTurnAliveAfterRetryingAgentEnd: vi.fn(() => false),
    keepPendingTurnAliveAfterRecoverableAssistantError: vi.fn(() => false),
    schedulePendingTurnCompletion: vi.fn(),
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

  it('rejects assistant error turns with runtime-auth classification metadata', () => {
    const classification = {
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'claude-primary',
      groupId: 'claude-main',
      resetsAtMs: null,
      retryAfterMs: 150_000,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
    const emitMessage = vi.fn();
    const rejectPendingTurn = vi.fn();
    const onRuntimeAuthFailure = vi.fn();
    const context = createContext({
      happierSessionId: 'happy-session-1',
      activeSessionId: 'pi-session-1',
      rejectPendingTurn,
      classifyRuntimeAuthFailure: vi.fn(() => classification),
      onRuntimeAuthFailure,
    } as Partial<PiRpcEventHandlerContext>);

    handlePiRpcEvent(context, emitMessage, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        stopReason: 'error',
        errorMessage: 'Usage limit reached. Please try again in 2m30s.',
      },
    });

    expect(emitMessage).toHaveBeenCalledWith({
      type: 'status',
      status: 'error',
      detail: 'Usage limit reached. Please try again in 2m30s.',
    });
    expect(rejectPendingTurn).toHaveBeenCalledWith(expect.objectContaining({
      runtimeAuthClassification: classification,
    }));
    expect(onRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      happierSessionId: 'happy-session-1',
      activeSessionId: 'pi-session-1',
      classification,
    }));
  });

  it('reports recoverable assistant capacity errors without terminalizing the turn', () => {
    const classification = {
      kind: 'capacity',
      serviceId: 'openai-codex',
      profileId: 'codex-primary',
      groupId: null,
      resetsAtMs: null,
      retryAfterMs: null,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
    const emitMessage = vi.fn();
    const rejectPendingTurn = vi.fn();
    const onRuntimeAuthFailure = vi.fn();
    const context = createContext({
      happierSessionId: 'happy-session-1',
      activeSessionId: 'pi-session-1',
      rejectPendingTurn,
      classifyRuntimeAuthFailure: vi.fn(() => classification),
      onRuntimeAuthFailure,
    } as Partial<PiRpcEventHandlerContext>);

    handlePiRpcEvent(context, emitMessage, {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'openai-codex',
        stopReason: 'error',
        errorMessage: 'server_is_overloaded',
      },
    });

    expect(onRuntimeAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      happierSessionId: 'happy-session-1',
      activeSessionId: 'pi-session-1',
      classification,
    }));
    expect(rejectPendingTurn).not.toHaveBeenCalled();
    expect(emitMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'status',
      status: 'error',
    }));
  });

  it('publishes a failed runtime turn for classified assistant auth failures', async () => {
    const classification = {
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'claude-primary',
      groupId: 'claude-main',
      resetsAtMs: null,
      retryAfterMs: 150_000,
      planType: null,
      rateLimits: null,
      source: 'stable_provider_message',
    };
    const publishRuntimeEvent = vi.fn();
    const context = createContext({
      happierSessionId: 'happy-session-1',
      activeSessionId: 'pi-session-1',
      classifyRuntimeAuthFailure: vi.fn(() => classification),
      publishRuntimeEvent,
      surfacePrimarySessionRuntimeIssue: async (input) => {
        await surfacePrimarySessionRuntimeIssue(input);
      },
    } as Partial<PiRpcEventHandlerContext>);

    handlePiRpcEvent(context, vi.fn(), {
      type: 'turn_start',
      turnId: 'pi-provider-turn-1',
    });
    handlePiRpcEvent(context, vi.fn(), {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        stopReason: 'error',
        errorMessage: 'Usage limit reached. Please try again in 2m30s.',
      },
    });
    handlePiRpcEvent(context, vi.fn(), {
      type: 'turn_end',
      turnId: 'pi-provider-turn-1',
    });

    await vi.waitFor(() => {
      const events = publishRuntimeEvent.mock.calls.map(([event]) => RuntimeEventV1Schema.parse(event));
      expect(events.some((event) => event.kind === 'turn-failed')).toBe(true);
    });

    const events = publishRuntimeEvent.mock.calls.map(([event]) => RuntimeEventV1Schema.parse(event));
    const turnStart = events.find((event) => event.kind === 'turn-start');
    const turnFailed = events.find((event) => event.kind === 'turn-failed');
    expect(turnFailed).toMatchObject({
      sessionId: 'happy-session-1',
      turnId: turnStart?.turnId,
      providerTurnId: 'pi-provider-turn-1',
      issue: expect.objectContaining({
        provider: 'pi',
        providerTurnId: 'pi-provider-turn-1',
      }),
    });
    expect(events.some((event) => event.kind === 'turn-complete')).toBe(false);
  });

  it('publishes usage stats when agent_end arrives without a pending turn to complete', () => {
    const publishUsageStatsBestEffort = vi.fn(async () => {});
    const schedulePendingTurnCompletion = vi.fn(() => false);
    const context = createContext({
      publishUsageStatsBestEffort,
      schedulePendingTurnCompletion,
    });

    handlePiRpcEvent(context, vi.fn(), { type: 'agent_end' });

    expect(schedulePendingTurnCompletion).toHaveBeenCalledOnce();
    expect(publishUsageStatsBestEffort).toHaveBeenCalledOnce();
  });

  it('publishes typed runtime turn events from Pi RPC turn boundaries', () => {
    const publishRuntimeEvent = vi.fn();
    const context = createContext({
      happierSessionId: 'happy-session-1',
      publishRuntimeEvent,
    } as Partial<PiRpcEventHandlerContext>);

    handlePiRpcEvent(context, vi.fn(), {
      type: 'turn_start',
      turnId: 'pi-provider-turn-1',
    });
    handlePiRpcEvent(context, vi.fn(), {
      type: 'turn_end',
      turnId: 'pi-provider-turn-1',
    });

    const events = publishRuntimeEvent.mock.calls.map(([event]) => RuntimeEventV1Schema.parse(event));
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'turn-start',
        sessionId: 'happy-session-1',
        turnId: expect.any(String),
        providerTurnId: 'pi-provider-turn-1',
      }),
      expect.objectContaining({
        kind: 'turn-complete',
        sessionId: 'happy-session-1',
        turnId: events[0]?.turnId,
        providerTurnId: 'pi-provider-turn-1',
      }),
    ]);
    expect(events[0]?.turnId).not.toBe('pi-provider-turn-1');
  });

  it('keeps runtime turn ids stable across per-line handler contexts', () => {
    const publishRuntimeEvent = vi.fn();
    const runtimeTurnState = createPiRpcRuntimeTurnState();

    handlePiRpcEvent(createContext({
      happierSessionId: 'happy-session-1',
      publishRuntimeEvent,
      runtimeTurnState,
    } as Partial<PiRpcEventHandlerContext>), vi.fn(), {
      type: 'turn_start',
      turnId: 'pi-provider-turn-1',
    });
    handlePiRpcEvent(createContext({
      happierSessionId: 'happy-session-1',
      publishRuntimeEvent,
      runtimeTurnState,
    } as Partial<PiRpcEventHandlerContext>), vi.fn(), {
      type: 'turn_end',
      turnId: 'pi-provider-turn-1',
    });

    const events = publishRuntimeEvent.mock.calls.map(([event]) => RuntimeEventV1Schema.parse(event));
    const turnStart = events.find((event) => event.kind === 'turn-start');
    const turnComplete = events.find((event) => event.kind === 'turn-complete');
    expect(turnComplete?.turnId).toBe(turnStart?.turnId);
    expect(turnComplete?.providerTurnId).toBe('pi-provider-turn-1');
  });
});
