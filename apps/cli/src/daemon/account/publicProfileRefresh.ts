import type { ActionExecuteResult } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PublicProfileMutationResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';

import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '../lifecycle/singleFlightIntervalLoop';
import type { DaemonServerWorkScheduler } from '../serverWork';

type RefreshContext = Readonly<{ surface: 'cli'; signal: AbortSignal }>;

/** Captured Account Actions project state; this participant never owns profile admission. */
export type PublicProfileRefreshActions = Readonly<{
  readMaintenanceState(context: RefreshContext): Promise<
    | Readonly<{ kind: 'published'; computedAtMs: number | null }>
    | Readonly<{ kind: 'inactive' }>
  >;
  /** The shared Action executor owns CLI authorization and facts-only preparation. */
  refresh(context: RefreshContext): Promise<ActionExecuteResult>;
}>;

export function startPublicProfileRefresh(params: Readonly<{
  actions: PublicProfileRefreshActions;
  scheduler: DaemonServerWorkScheduler;
  signal: AbortSignal;
  onError?: (error: unknown) => void;
}>): SingleFlightIntervalLoopHandle {
  const dayMs = 24 * 60 * 60 * 1_000;
  const loop = startSingleFlightIntervalLoop({
    intervalMs: dayMs,
    unref: true,
    onError: params.onError,
    task: async loopSignal => {
      const signal = AbortSignal.any([loopSignal, params.signal]);
      let nextAutomaticRunAfterMs: number | null = dayMs;
      const outcome = await params.scheduler.enqueue({
        key: 'publicProfileRefresh',
        purpose: 'accountMaintenance',
        kind: 'latestStateWrite',
        payload: null,
        payloadBytes: 0,
        run: async () => {
          if (signal.aborted) {
            nextAutomaticRunAfterMs = null;
            return { status: 'suppressed', reason: 'account_retired' };
          }
          const context = { surface: 'cli', signal } as const;
          const state = await params.actions.readMaintenanceState(context);
          if (signal.aborted) {
            nextAutomaticRunAfterMs = null;
            return { status: 'suppressed', reason: 'account_retired' };
          }
          if (state.kind !== 'published') return { status: 'suppressed', reason: 'not_published' };
          const untilDueMs = state.computedAtMs === null ? 0 : state.computedAtMs + dayMs - Date.now();
          if (untilDueMs > 0) {
            nextAutomaticRunAfterMs = untilDueMs;
            return { status: 'suppressed', reason: 'not_due' };
          }
          const result = await params.actions.refresh(context);
          if (signal.aborted) {
            nextAutomaticRunAfterMs = null;
            return { status: 'suppressed', reason: 'account_retired' };
          }
          if (!result.ok) return { status: 'suppressed', reason: result.errorCode };
          if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
            return { status: 'suppressed', reason: 'approval_required' };
          }
          const mutation = PublicProfileMutationResultV1Schema.safeParse(result.result);
          if (!mutation.success) return { status: 'suppressed', reason: 'invalid_action_output' };
          if (mutation.data.kind !== 'updated') return { status: 'suppressed', reason: mutation.data.reason };
          const record = mutation.data.record;
          if (!record || record.state !== 'published' || record.restriction || !record.snapshot || !record.policy || !record.query) {
            return { status: 'suppressed', reason: 'not_published' };
          }
          const delayMs = record.snapshot.computedAtMs + dayMs - Date.now();
          // A still-old source is retried on the daily cadence, never a hot loop.
          nextAutomaticRunAfterMs = delayMs > 0 ? delayMs : dayMs;
          return { status: 'written' };
        },
      });
      if (signal.aborted) return { nextAutomaticRunAfterMs: null };
      return { nextAutomaticRunAfterMs: outcome.status === 'deferred' && outcome.retryAfterMs !== undefined
        ? outcome.retryAfterMs : nextAutomaticRunAfterMs };
    },
  });
  const stop = async () => {
    params.signal.removeEventListener('abort', onRetired);
    await loop.stop();
  };
  const onRetired = () => { void stop(); };
  const handle = { ...loop, stop, resume: () => { loop.resume(); loop.trigger(); } };
  if (params.signal.aborted) void stop();
  else {
    params.signal.addEventListener('abort', onRetired, { once: true });
    loop.trigger();
  }
  return handle;
}
