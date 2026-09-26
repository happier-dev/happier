import { describe, expect, it, vi } from 'vitest';

import type { SessionHookData } from '../utils/startHookServer';
import { createClaudeUnifiedHookLifecycleBridge } from './createClaudeUnifiedHookLifecycleBridge';
import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';
import { createClaudeUnifiedAcceptedPromptTranscriptDiscovery } from './acceptedPromptTranscriptDiscovery';

describe('accepted steer hook settlement', () => {
  it.each(['idle', 'running'] as const)('uses an early submit hook as acceptance only for a new turn (injection state: %s)', async (turnState) => {
    let hook: ((data: SessionHookData) => void) | undefined;
    const accepted: string[] = [];
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      evaluateInFlightSteer: async () => ({ steer: true }),
      injectPrompt: async (batch) => {
        hook?.({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-session', prompt: batch.message });
        return { status: 'injected', at: Date.now(), bytesWritten: batch.message.length };
      },
      onPromptAccepted: (batch) => { accepted.push(batch.message); },
    });
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => { hook = callback; return () => { hook = undefined; }; },
      arbiter,
      completionQuiescenceMs: 0,
    });
    try {
      bridge.start({ abortSignal: new AbortController().signal });
      arbiter.observeLifecycle({ type: 'turn_state', state: turnState });
      arbiter.observeLifecycle({ type: 'output' });
      await arbiter.enqueueUiMessage({
        message: 'early hook prompt', origin: { kind: 'ui_pending' }, userMessageLocalIds: ['early-hook-local'],
      });
      await arbiter.drainWhenSafe();
      expect(accepted).toEqual(turnState === 'idle' ? ['early hook prompt'] : []);
      expect(arbiter.snapshot().providerAcceptancePendingCount).toBe(turnState === 'idle' ? 0 : 1);
    } finally {
      bridge.dispose();
      await arbiter.dispose();
    }
  });

  it.each([false, true])('retains a queued steer through UserPromptSubmit until absorption (terminal custody observed: %s)', async (terminalCustodyObserved) => {
    const acceptedLocalIds: string[][] = [];
    const discovery = createClaudeUnifiedAcceptedPromptTranscriptDiscovery({
      acceptedPromptWindowMs: 5_000,
      nowMs: () => 10_000,
    });
    let injectedBatch: Parameters<ReturnType<typeof createClaudeUnifiedInputArbiter>['observePromptCustodyByTerminal']>[0] | null = null;
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    const arbiter = createClaudeUnifiedInputArbiter({
      quietPeriodMs: 0,
      busyTurnFallbackWakeMs: 60_000,
      evaluateInFlightSteer: vi.fn(async () => ({ steer: true as const })),
      injectPrompt: vi.fn(async (batch) => {
        injectedBatch = batch;
        return {
          status: 'injected' as const,
          at: 10_000,
          bytesWritten: batch.message.length,
          inFlightSteer: true,
        };
      }),
      onPromptAccepted: (batch) => {
        acceptedLocalIds.push([...(batch.userMessageLocalIds ?? [])]);
      },
      onProviderAcceptancePending: (batch) => {
        discovery.recordAcceptedPrompt({
          message: batch.message,
          deliveryIdentity: { localIds: batch.userMessageLocalIds },
        });
      },
    });
    const bridge = createClaudeUnifiedHookLifecycleBridge({
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      arbiter,
      completionQuiescenceMs: 0,
    });

    try {
      arbiter.observeLifecycle({ type: 'turn_state', state: 'running', observedAtMs: 10_000 });
      await arbiter.enqueueUiMessage({
        message: 'exact accepted steer',
        origin: { kind: 'ui_pending' },
        pendingProviderAction: 'steer',
        userMessageLocalIds: ['d0c32266-56b9-4421-8b3a-56fcd6d1605b'],
      });
      await arbiter.drainWhenSafe();
      expect(injectedBatch).not.toBeNull();
      if (terminalCustodyObserved) await arbiter.observePromptCustodyByTerminal(injectedBatch!);
      await arbiter.enqueueUiMessage({
        message: 'neighbor pending prompt',
        origin: { kind: 'ui_pending' },
        pendingProviderAction: 'steer',
        userMessageLocalIds: ['neighbor-local-id'],
      });

      bridge.start({ abortSignal: new AbortController().signal });
      const hook = subscribedHook;
      if (!hook) throw new Error('Claude session hook subscription was not registered');

      // TUI custody and generic active-turn output are not provider acceptance.
      arbiter.observeLifecycle({ type: 'output', observedAtMs: 10_001 });
      expect(acceptedLocalIds).toEqual([]);
      const retained = { terminalCustodyCount: terminalCustodyObserved ? 1 : 0, queuedCount: terminalCustodyObserved ? 1 : 2 };
      expect(arbiter.snapshot()).toMatchObject(retained);

      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        prompt: 'unrelated terminal prompt',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acceptedLocalIds).toEqual([]);

      // Claude Code invokes this hook while the prompt is still in its native queue.
      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        prompt: 'exact accepted steer',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acceptedLocalIds).toEqual([]);
      expect(arbiter.snapshot()).toMatchObject(retained);
      expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBe(terminalCustodyObserved ? 'd0c32266-56b9-4421-8b3a-56fcd6d1605b' : null);

      const queueRow = {
        type: 'queue-operation', sessionId: 'claude-session-id',
        content: 'exact accepted steer', timestamp: new Date(10_000).toISOString(),
      };
      expect(discovery.findMatchingTranscript([{ ...queueRow, operation: 'enqueue' }])).toBeNull();
      expect(discovery.findMatchingTranscript([{ ...queueRow, operation: 'remove', reason: 'absorbed_mid_turn' }])).toBeNull();
      const match = discovery.findMatchingTranscript([{
        type: 'attachment', uuid: 'absorbed-steer', parentUuid: 'preceding-tool-result',
        isSidechain: false, sessionId: queueRow.sessionId, timestamp: queueRow.timestamp,
        attachment: {
          type: 'queued_command', prompt: queueRow.content, commandMode: 'prompt',
          origin: { kind: 'human' }, timestamp: queueRow.timestamp,
        },
      }]);
      expect(match?.deliveryIdentity?.localIds).toEqual(['d0c32266-56b9-4421-8b3a-56fcd6d1605b']);
      await arbiter.confirmPromptAcceptedByProviderIf((batch) => (
        batch.userMessageLocalIds?.[0] === match?.deliveryIdentity?.localIds?.[0]
      ));
      expect(acceptedLocalIds).toEqual([['d0c32266-56b9-4421-8b3a-56fcd6d1605b']]);
      expect(arbiter.snapshot()).toMatchObject({ terminalCustodyCount: 0, queuedCount: 1 });
      expect(arbiter.readPendingInputInterruptAndRunLocalId()).toBeNull();

      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        prompt: 'exact accepted steer',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acceptedLocalIds).toEqual([['d0c32266-56b9-4421-8b3a-56fcd6d1605b']]);
      expect(arbiter.snapshot()).toMatchObject({ queuedCount: 1 });
    } finally {
      bridge.dispose();
      await arbiter.dispose();
    }
  });
});
