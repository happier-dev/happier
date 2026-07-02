import { describe, expect, it } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core/AgentBackend';
import type { RuntimeTurnMessageHandler, RuntimeTurnOperations } from './runtimeTurnOperations';
import {
  createLegacyAgentBackendFromRuntimeTurnOperations,
  createRuntimeTurnOperationsFromLegacyAgentBackend,
} from './runtimeTurnCompatAdapters.testkit';

describe('runtime-turn compatibility adapters', () => {
  it('adapts AgentBackend turn operations into the shared runtime-turn contract', async () => {
    const calls: string[] = [];
    const handlers = new Set<AgentMessageHandler>();
    const backend: AgentBackend = {
      async startSession(): Promise<StartSessionResult> {
        calls.push('startSession');
        return { sessionId: 'agent-start-session' as SessionId };
      },
      async loadSession(sessionId: SessionId): Promise<StartSessionResult> {
        calls.push(`loadSession:${sessionId}`);
        return { sessionId: `${sessionId}:loaded` as SessionId };
      },
      async sendPrompt(sessionId, prompt) {
        calls.push(`sendPrompt:${sessionId}:${prompt}`);
      },
      async sendSteerPrompt(sessionId, prompt) {
        calls.push(`sendSteerPrompt:${sessionId}:${prompt}`);
      },
      async cancel(sessionId) {
        calls.push(`cancel:${sessionId}`);
      },
      onMessage(handler) {
        calls.push('onMessage');
        handlers.add(handler);
      },
      offMessage(handler) {
        calls.push('offMessage');
        handlers.delete(handler);
      },
      async respondToPermission(requestId, approved) {
        calls.push(`respondToPermission:${requestId}:${approved}`);
      },
      async waitForResponseComplete(timeoutMs) {
        calls.push(`waitForResponseComplete:${timeoutMs ?? 'none'}`);
      },
      async dispose() {
        calls.push('dispose');
      },
    };

    const operations = createRuntimeTurnOperationsFromLegacyAgentBackend(backend);
    const receivedMessages: unknown[] = [];
    const unsubscribe = operations.subscribeRuntimeEvents((message) => {
      receivedMessages.push(message);
    });

    await operations.startOrLoadSession({ resumeId: 'agent-resume-session' });
    expect(operations.readSessionIdentity()).toEqual({ sessionId: 'agent-resume-session:loaded' });

    await operations.sendTurnPrompt('hello');
    await operations.steerInFlightTurn('nudge');
    await operations.waitForTurnCompletion({ timeoutMs: 123 });
    await operations.respondToPermission('perm-1', true);
    await operations.cancelTurn();
    handlers.forEach((handler) => handler({ type: 'status', status: 'running' } as never));
    unsubscribe();
    await operations.resetOrDisposeRuntime();

    expect(receivedMessages).toEqual([{ type: 'status', status: 'running' }]);
    expect(calls).toEqual([
      'onMessage',
      'loadSession:agent-resume-session',
      'sendPrompt:agent-resume-session:loaded:hello',
      'sendSteerPrompt:agent-resume-session:loaded:nudge',
      'waitForResponseComplete:123',
      'respondToPermission:perm-1:true',
      'cancel:agent-resume-session:loaded',
      'offMessage',
      'dispose',
    ]);
  });

  it('adapts shared runtime-turn operations into the legacy AgentBackend boundary', async () => {
    const calls: string[] = [];
    const handlers = new Set<RuntimeTurnMessageHandler>();
    let sessionId: string | null = null;
    const operations: RuntimeTurnOperations = {
      beginTurnLifecycle() {
        calls.push('beginTurnLifecycle');
      },
      async startOrLoadSession(opts) {
        calls.push(`startOrLoadSession:${opts?.resumeId ?? 'new'}`);
        sessionId = opts?.resumeId ? `${opts.resumeId}:turn` : 'turn-session';
      },
      async sendTurnPrompt(prompt) {
        calls.push(`sendTurnPrompt:${prompt}`);
      },
      async steerInFlightTurn(message) {
        calls.push(`steerInFlightTurn:${message}`);
      },
      async waitForTurnCompletion(opts) {
        calls.push(`waitForTurnCompletion:${opts?.timeoutMs ?? 'none'}`);
      },
      subscribeRuntimeEvents(handler) {
        calls.push('subscribeRuntimeEvents');
        handlers.add(handler);
        return () => {
          calls.push('unsubscribeRuntimeEvents');
          handlers.delete(handler);
        };
      },
      async respondToPermission(requestId, approved) {
        calls.push(`respondToPermission:${requestId}:${approved}`);
      },
      async cancelTurn() {
        calls.push('cancelTurn');
      },
      readSessionIdentity() {
        return { sessionId };
      },
      async updateSessionRuntimeConfig() {
        calls.push('updateSessionRuntimeConfig');
      },
      async resetOrDisposeRuntime() {
        calls.push('resetOrDisposeRuntime');
      },
    };

    const backend = createLegacyAgentBackendFromRuntimeTurnOperations(operations);
    const receivedMessages: unknown[] = [];
    const handler: AgentMessageHandler = (message) => {
      receivedMessages.push(message);
    };

    backend.onMessage(handler);
    await expect(backend.startSession()).resolves.toEqual({ sessionId: 'turn-session' });
    await backend.sendPrompt('turn-session' as SessionId, 'hello');
    await backend.sendSteerPrompt?.('turn-session' as SessionId, 'nudge');
    await backend.waitForResponseComplete?.(234);
    await backend.respondToPermission?.('perm-2', false);
    await backend.cancel('turn-session' as SessionId);
    handlers.forEach((runtimeHandler) => runtimeHandler({ type: 'status', status: 'idle' } as never));
    backend.offMessage?.(handler);
    await backend.dispose();

    expect(receivedMessages).toEqual([{ type: 'status', status: 'idle' }]);
    expect(calls).toEqual([
      'subscribeRuntimeEvents',
      'startOrLoadSession:new',
      'beginTurnLifecycle',
      'sendTurnPrompt:hello',
      'steerInFlightTurn:nudge',
      'waitForTurnCompletion:234',
      'respondToPermission:perm-2:false',
      'cancelTurn',
      'unsubscribeRuntimeEvents',
      'resetOrDisposeRuntime',
    ]);
  });
});
