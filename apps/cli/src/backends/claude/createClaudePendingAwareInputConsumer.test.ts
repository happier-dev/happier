import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import {
  blocksPendingMaterializationDuringActiveTurn,
  type PendingMaterializationActiveTurnPolicy,
} from '@/api/session/pendingMaterializationActiveTurnPolicy';
import type { MaterializeNextPendingResult } from '@/api/session/sessionClientPort';

import { createClaudePendingAwareInputConsumer } from './createClaudePendingAwareInputConsumer';
import type { EnhancedMode } from './loop';
import type { Session } from './session';

type PendingMaterializationCallOptions = {
  activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
};

/**
 * Boundary fake for the session client. The active-turn gate defers to the canonical
 * policy helper the real client uses (`sessionClient.isPendingMaterializationBlocked`)
 * so the caller-supplied policy — not a re-implementation of it — decides the outcome.
 */
function createSessionHarness(accountSettings: Record<string, unknown> | null) {
  const turn = { active: false };
  const isMaterializationBlocked = (opts?: PendingMaterializationCallOptions) =>
    turn.active && blocksPendingMaterializationDuringActiveTurn(opts?.activeTurnDeliveryPolicy);
  const materializeNextPendingMessageSafely = vi.fn<(
    opts?: PendingMaterializationCallOptions,
  ) => Promise<MaterializeNextPendingResult>>(async () => ({ type: 'no_pending' }));
  const session = {
    queue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    accountSettings,
    client: {
      materializeNextPendingMessageSafely,
      popPendingMessage: vi.fn(async () => false),
      shouldAttemptPendingMaterialization: vi.fn((opts?: PendingMaterializationCallOptions) =>
        !isMaterializationBlocked(opts)),
      reconcilePendingQueueState: vi.fn(async () => false),
      waitForMetadataUpdate: vi.fn(async () => false),
    },
  } as unknown as Session;

  return { session, materializeNextPendingMessageSafely, isMaterializationBlocked, turn };
}

describe('createClaudePendingAwareInputConsumer', () => {
  it.each([
    { label: 'the account setting is missing', accountSettings: null },
    {
      label: 'busy steering uses immediate direct delivery',
      accountSettings: { sessionBusySteerSendPolicy: 'steer_immediately' },
    },
    {
      label: 'busy steering uses server pending',
      accountSettings: { sessionBusySteerSendPolicy: 'server_pending' },
    },
  ])('holds server-pending rows until the active turn ends when $label', async ({ accountSettings }) => {
    const { session, materializeNextPendingMessageSafely, turn } = createSessionHarness(accountSettings);
    turn.active = true;
    const consumer = createClaudePendingAwareInputConsumer(session);

    await expect(consumer.drainPending({
      reason: 'test-active-turn',
    })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'materialization_blocked',
    });
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();

    turn.active = false;
    await expect(consumer.drainPending({
      reason: 'test-turn-ended',
    })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'no_pending',
    });
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
    });
  });

  it('keeps waitForNextInput from materializing server pending until the active turn ends', async () => {
    const {
      session,
      materializeNextPendingMessageSafely,
      isMaterializationBlocked,
      turn,
    } = createSessionHarness({
      sessionBusySteerSendPolicy: 'steer_immediately',
    });
    const pendingMode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
    } as EnhancedMode;
    turn.active = true;
    let releaseMetadataUpdate: ((value: boolean) => void) | undefined;
    session.client.waitForMetadataUpdate = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseMetadataUpdate = resolve;
    }));
    materializeNextPendingMessageSafely.mockImplementation(async (opts) => {
      if (isMaterializationBlocked(opts)) {
        return { type: 'no_pending' as const };
      }
      session.queue.push('server pending after turn', pendingMode);
      return {
        type: 'materialized' as const,
        localId: 'pending-local-id',
        seq: 42,
        content: null,
      };
    });
    const consumer = createClaudePendingAwareInputConsumer(session);
    const abortController = new AbortController();
    let waitResolved = false;

    const inputPromise = consumer.waitForNextInput({
      abortSignal: abortController.signal,
    }).then((input) => {
      waitResolved = true;
      return input;
    });

    await vi.waitFor(() => {
      expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(1);
      expect(releaseMetadataUpdate).toBeTypeOf('function');
    });
    expect(waitResolved).toBe(false);
    expect(session.queue.size()).toBe(0);
    expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(1, {
      reconcileWhenEmpty: 'skip',
    });

    turn.active = false;
    releaseMetadataUpdate?.(true);

    await expect(inputPromise).resolves.toEqual(expect.objectContaining({
      message: 'server pending after turn',
      mode: pendingMode,
    }));
    expect(materializeNextPendingMessageSafely).toHaveBeenNthCalledWith(2, {
      reconcileWhenEmpty: 'skip',
    });
  });

  it('still delivers direct-steer messages from the local queue while a turn is active', async () => {
    const { session, materializeNextPendingMessageSafely, turn } = createSessionHarness({
      sessionBusySteerSendPolicy: 'steer_immediately',
    });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
    } as EnhancedMode;
    // The active-turn hold applies to daemon-owned pending rows only: "steer immediately"
    // sends arrive on this local queue and must still reach the running turn.
    turn.active = true;
    session.queue.push('steer the active turn', mode);

    const consumer = createClaudePendingAwareInputConsumer(session);

    await expect(consumer.waitForNextInput({
      abortSignal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({
      message: 'steer the active turn',
      mode,
    }));
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
  });
});
