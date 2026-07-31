import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';
import { resolveSessionPendingQueueMaxPopPerWake } from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';

import type { EnhancedMode } from './loop';
import type { Session } from './session';

/**
 * Canonical Claude session input consumer: local agent queue + daemon-owned
 * server pending-queue materialization.
 *
 * Every Claude launcher that pulls batches for a live session MUST consume
 * through this (not `session.queue` directly): a raw queue wait only ever sees
 * messages the UI managed to deliver over RPC, so server-side pending rows
 * queued mid-turn silently starve until a manual "Send now" once the UI direct
 * path misses (QA C-F2/A-F3 stuck/one-behind family — live repro
 * cmqb329qm044z: turn-end drain trigger fired, but the unified launcher waited
 * on the raw queue and no materialization could ever run).
 */
export function createClaudePendingAwareInputConsumer(
    session: Session,
    opts?: Readonly<{
        onMetadataUpdate?: (() => void | Promise<void>) | undefined;
    }>,
): SessionProviderInputConsumer<EnhancedMode, string> {
    const materializeNextPendingMessageSafely =
        typeof session.client.materializeNextPendingMessageSafely === 'function'
            ? session.client.materializeNextPendingMessageSafely.bind(session.client)
            : null;

    // Daemon-owned pending rows must keep the shared consumer's default
    // active-turn block. "Steer immediately" belongs to the explicit UI
    // send-now path, which writes to this local queue directly; applying that
    // setting here would consume ordinary pending rows before they can still
    // be edited or deleted.
    return createSessionProviderInputConsumer<EnhancedMode, string>({
        messageQueue: session.queue,
        session: {
            ...(materializeNextPendingMessageSafely
                ? {
                    materializeNextPendingMessageSafely: async (materializeOpts) => {
                        // Committed transcript messages queued locally must be processed
                        // before materializing additional server pending rows.
                        if (session.queue.size() > 0) return { type: 'no_pending' as const };
                        return await materializeNextPendingMessageSafely(materializeOpts);
                    },
                }
                : {}),
            popPendingMessage: async () => {
                if (session.queue.size() > 0) return false;
                if (!materializeNextPendingMessageSafely) {
                    return await session.client.popPendingMessage();
                }
                return (await materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).type === 'materialized';
            },
            shouldAttemptPendingMaterialization: () =>
                session.queue.size() <= 0
                && (session.client.shouldAttemptPendingMaterialization?.() ?? true),
            reconcilePendingQueueState: async (reconcileOpts) => {
                await session.client.reconcilePendingQueueState?.(reconcileOpts);
            },
            waitForMetadataUpdate: (signal) => session.client.waitForMetadataUpdate(signal),
        },
        pendingDrainMaxPopPerWake: resolveSessionPendingQueueMaxPopPerWake(session.accountSettings ?? null),
        ...(opts?.onMetadataUpdate ? { onMetadataUpdate: opts.onMetadataUpdate } : {}),
    });
}
