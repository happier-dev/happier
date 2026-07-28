import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';

describe('createAcpRuntime (status error surfacing)', () => {
  it('surfaces non-abort status:error as sanitized primary-session failure', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const sent: ACPMessageData[] = [];
    const failedTurns: unknown[] = [];
    const session = {
      ...createBasicSessionClientWithOverrides({
        sendAgentMessage: (_provider, body) => {
          sent.push(body);
        },
      }),
      sessionTurnLifecycle: {
        beginTurn: async () => ({ turnId: 'session-turn-1' }),
        attachProviderTurnId: async () => {},
        appendTranscriptAnchors: async () => {},
        completeTurn: async () => {},
        failTurn: async (record: unknown) => {
          failedTurns.push(record);
        },
        cancelTurn: async () => {},
        endSession: async () => {},
        markRollbackEligible: async () => {},
        markRolledBack: async () => {},
        touchActiveTurn: async () => {},
        hasActiveTurn: () => false,
      },
    };

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(sent.some((msg) => msg.type === 'message' && msg.message.includes('Model not found'))).toBe(false);
    await expect.poll(() => sent.some((msg) => msg.type === 'turn_failed')).toBe(true);
    expect(sent.some((msg) => msg.type === 'turn_aborted')).toBe(false);
    expect(failedTurns).toEqual([
      expect.objectContaining({
        provider: 'pi',
        issue: expect.objectContaining({
          source: 'provider_status_error',
          sanitizedPreview: 'Provider reported an error',
        }),
      }),
    ]);
    expect(JSON.stringify(failedTurns)).not.toContain('Model not found');
  });

  it('flushes pending permission requests on status:error', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const flushReasons: string[] = [];

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: createBasicSessionClientWithOverrides(),
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: {
        ...createApprovedPermissionHandler(),
        abortPendingRequestsAndFlush: async (reason: string) => {
          flushReasons.push(reason);
        },
      },
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(flushReasons).toEqual(['ACP runtime status:error']);
  });

  it('does not surface abort-like status:error detail as a transcript message', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });

    const sent: ACPMessageData[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({
      type: 'status',
      status: 'error',
      detail: 'Error: OpenCode session aborted\n    at Object.cancel (/tmp/runtime.ts:10:1)',
    } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();

    expect(sent.some((msg) => msg.type === 'message' && msg.message.includes('OpenCode session aborted'))).toBe(false);
    expect(sent.some((msg) => msg.type === 'message' && msg.message.includes('at Object.cancel'))).toBe(false);
    expect(sent.some((msg) => msg.type === 'turn_aborted')).toBe(true);
  });

  it('opens and fails a lifecycle turn when status:error arrives before task_started', async () => {
    const backend = createFakeAcpRuntimeBackend({ sessionId: 'sess_main' });
    const mutations: SessionTurnMutationV1[] = [];
    const sessionTurnLifecycle = createSessionTurnLifecycle({
      sessionId: 'happy-session-1',
      createId: () => 'turn-1',
      now: () => 123,
      enqueueSessionTurn: async (mutation) => {
        mutations.push(mutation);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session: {
        ...createBasicSessionClientWithOverrides(),
        sessionTurnLifecycle,
      },
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
    await Promise.resolve();
    await Promise.resolve();

    await expect.poll(() => mutations).toEqual([
      expect.objectContaining({
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'pi',
      }),
      expect.objectContaining({
        action: 'fail',
        turnId: 'session-turn:turn-1',
        provider: 'pi',
        issue: expect.objectContaining({
          source: 'provider_status_error',
        }),
      }),
    ]);
  });
});
