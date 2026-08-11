import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { SessionRuntimeActivityContributionHandle } from '@/session/runtimeActivity/types';

import type { EnhancedMode } from './loop';
import { Session } from './session';

/**
 * PLAN 4.9.1 step 2 is a DECIDING check, and it is decided by production wiring, not by the ledger.
 *
 * `createClaudeProviderActivityLedger` is fail-open on purpose - a ledger that was never told which
 * Claude session it speaks for cannot call anything foreign - so a test that arms the ledger itself
 * proves nothing about a runner that forgets to. These tests arm nothing: they drive `Session` the
 * way a launcher does and assert the gate is live afterwards.
 */

function createSessionClientStub(): SessionClientPort {
  return {
    sessionId: 'happy-session-id',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendSessionEvent: vi.fn(),
    sendClaudeSessionMessage: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => null,
    waitForMetadataUpdate: vi.fn(async () => false),
    waitForPendingEligibilityUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    updateMetadata: vi.fn(async () => {}),
    updateAgentState: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as SessionClientPort;
}

function createProviderTaskContributionHandle(): SessionRuntimeActivityContributionHandle {
  return {
    report: vi.fn(async () => {}),
    markUnknown: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

/** A `Session` built the way every Claude launcher builds it, with provider-task activity enabled. */
function createSessionWithProviderTaskActivity(): Session {
  return new Session({
    client: createSessionClientStub(),
    path: '/tmp',
    logPath: '/tmp/log',
    sessionId: null,
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
    runtimeActivityContributions: { providerTasks: createProviderTaskContributionHandle() },
  });
}

describe('Claude provider-task session ownership', () => {
  it('arms the identity gate from the session-found chokepoint, so every launcher inherits it', () => {
    const session = createSessionWithProviderTaskActivity();

    try {
      const ledger = session.getProviderTaskActivityLedger();
      expect(ledger).not.toBeNull();

      // The unified terminal, the local launcher and the remote launcher all report the Claude
      // session id through this ONE method; none of them arms the ledger itself.
      session.onSessionFound('claude-session-a');

      expect(ledger!.apply({ type: 'started', sessionId: 'claude-session-b', taskId: 'task_foreign' })).toBe(false);
      expect(ledger!.getActiveProviderTaskCount()).toBe(0);
      expect(ledger!.hasActiveProviderTasks()).toBe(false);

      expect(ledger!.apply({ type: 'started', sessionId: 'claude-session-a', taskId: 'task_own' })).toBe(true);
      expect(ledger!.getActiveProviderTaskCount()).toBe(1);
    } finally {
      session.cleanup();
    }
  });

  it('accumulates the session lineage, so a compact boundary does not orphan a live task', () => {
    const session = createSessionWithProviderTaskActivity();

    try {
      const ledger = session.getProviderTaskActivityLedger()!;

      session.onSessionFound('claude-session-before-compact');
      session.onSessionFound('claude-session-after-compact');

      // Both ids are ours. A task started before the compaction must not become foreign to its own
      // ledger the moment Claude mints a new session id.
      expect(ledger.apply({ type: 'started', sessionId: 'claude-session-before-compact', taskId: 'task_old' })).toBe(true);
      expect(ledger.apply({ type: 'started', sessionId: 'claude-session-after-compact', taskId: 'task_new' })).toBe(true);
      expect(ledger.getActiveProviderTaskCount()).toBe(2);

      expect(ledger.apply({ type: 'started', sessionId: 'claude-session-elsewhere', taskId: 'task_foreign' })).toBe(false);
      expect(ledger.getActiveProviderTaskCount()).toBe(2);
    } finally {
      session.cleanup();
    }
  });
});
