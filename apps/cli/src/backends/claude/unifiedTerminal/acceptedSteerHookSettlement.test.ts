import { describe, expect, it, vi } from 'vitest';

import type { SessionHookData } from '../utils/startHookServer';
import { createClaudeUnifiedHookLifecycleBridge } from './createClaudeUnifiedHookLifecycleBridge';
import { createClaudeUnifiedInputArbiter } from './createClaudeUnifiedInputArbiter';

describe('accepted steer hook settlement', () => {
  it('settles only the exact terminal-custody Pending localId when UserPromptSubmit precedes turn-end arming', async () => {
    const acceptedLocalIds: string[][] = [];
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
      await arbiter.observePromptCustodyByTerminal(injectedBatch!);
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
      expect(arbiter.snapshot()).toMatchObject({ terminalCustodyCount: 1, queuedCount: 1 });

      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        prompt: 'unrelated terminal prompt',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(acceptedLocalIds).toEqual([]);

      // This exact authenticated evidence arrives before any idle/turn-end lifecycle observation.
      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-session-id',
        prompt: 'exact accepted steer',
      });
      await vi.waitFor(() => {
        expect(acceptedLocalIds).toEqual([['d0c32266-56b9-4421-8b3a-56fcd6d1605b']]);
      });
      expect(arbiter.snapshot()).toMatchObject({ terminalCustodyCount: 0, queuedCount: 1 });

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
