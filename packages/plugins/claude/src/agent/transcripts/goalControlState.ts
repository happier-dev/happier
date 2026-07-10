/**
 * Explicit Claude goal control epoch state (plan G2/D3).
 *
 * Replaces the previous `clearedCondition` tombstone in `goalStatus.ts`. Objective text is not a valid
 * operation identity: keying suppression on the cleared objective could not tell a stale provider
 * replay apart from a user intentionally setting the SAME objective again, so "clear -> set same
 * objective" was permanently suppressed.
 *
 * The OPERATION IDENTITY here is a monotonic `epoch`, not the objective. After a `/goal clear` the
 * provider keeps re-evaluating the now-un-meetable goal and emits fresh ACTIVE `goal_status` events
 * (new uuids, same objective). Those must be suppressed so the badge the user just cleared does not
 * resurrect. A subsequent SET intent bumps the epoch and lifts the clear suppression, so re-setting
 * the same objective works. A provider that moves to a genuinely DIFFERENT objective also lifts the
 * suppression (a new goal appeared).
 *
 * Revision ordering is unavailable in this transport (`sourceRevision` is the random transcript uuid,
 * not an orderable counter), so per G2 the fallback is: suppress same-objective active replay only for
 * the current clear epoch, until a new set intent (or a different objective) occurs. The
 * uuid/sourceRevision baseline is recorded both for the contract and to catch an exact-baseline
 * replay; ordered transports can later strengthen the "provably older than or equal" check here
 * without touching callers.
 *
 * Deliberately narrow: no `requestedAt`, no settle/pending state, and no clear-confirmation state —
 * Claude emits no reliable terminal `goal_status` for a clear, so the app owns clear removal (the
 * empty-snapshot publish lives in the goal source).
 */

export type ClaudeGoalControlEpochState = Readonly<{
  epoch: number;
  lastSetEpoch?: number;
  clear?: Readonly<{
    epoch: number;
    baselineSourceRevision?: string;
    baselineUuid?: string;
  }>;
}>;

export type ClaudeGoalControlIntent =
  | Readonly<{ kind: 'set' }>
  | Readonly<{
      kind: 'clear';
      baselineUuid?: string;
      baselineSourceRevision?: string;
      /**
       * The cleared goal's objective. Held privately (NOT part of the exported epoch state) to bound
       * same-objective active-replay suppression to the cleared goal, so a genuinely different goal is
       * not hidden. The epoch — not this text — is the operation identity.
       */
      baselineCondition?: string;
    }>;

export type ClaudeGoalReplayEvent = Readonly<{
  met: boolean;
  uuid: string;
  sourceRevision: string;
  condition: string;
}>;

export type ClaudeGoalReplayDecision = 'accept' | 'suppress';

export type ClaudeGoalControlEpochTracker = Readonly<{
  /** Record a user-driven goal control intent (set/clear). Bumps the monotonic epoch. */
  recordIntent(intent: ClaudeGoalControlIntent): void;
  /**
   * Decide whether an observed `goal_status` event is a stale post-clear replay that must be
   * suppressed. Accepts everything when no clear is in effect. Has the side effect of lifting the
   * clear suppression when it observes the provider move to a genuinely different active goal.
   */
  resolveReplay(event: ClaudeGoalReplayEvent): ClaudeGoalReplayDecision;
  /** Inspect the current epoch state (testing/diagnostics). */
  snapshot(): ClaudeGoalControlEpochState;
}>;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function createClaudeGoalControlEpochTracker(): ClaudeGoalControlEpochTracker {
  let epoch = 0;
  let lastSetEpoch: number | undefined;
  let clear: ClaudeGoalControlEpochState['clear'] | undefined;
  // Private bound for same-objective suppression — intentionally NOT part of the exported state.
  let clearBaselineCondition: string | null = null;

  const liftClear = (): void => {
    clear = undefined;
    clearBaselineCondition = null;
  };

  return {
    recordIntent(intent) {
      epoch += 1;
      if (intent.kind === 'set') {
        lastSetEpoch = epoch;
        liftClear();
        return;
      }
      clear = {
        epoch,
        ...(nonEmpty(intent.baselineUuid) ? { baselineUuid: intent.baselineUuid } : {}),
        ...(nonEmpty(intent.baselineSourceRevision) ? { baselineSourceRevision: intent.baselineSourceRevision } : {}),
      };
      clearBaselineCondition = nonEmpty(intent.baselineCondition);
    },
    resolveReplay(event) {
      if (!clear) return 'accept';

      // An exact-baseline replay (same uuid/sourceRevision the clear was taken at) is provably the
      // cleared event — suppress it regardless of met (defensive; the source also dedupes by uuid).
      if (clear.baselineSourceRevision && event.sourceRevision === clear.baselineSourceRevision) return 'suppress';
      if (clear.baselineUuid && event.uuid === clear.baselineUuid) return 'suppress';

      if (event.met) {
        // A terminal (cancelled/complete) event for the cleared goal: the app already removed the goal
        // by clear intent — do not resurrect a cancelled/complete badge for it.
        return 'suppress';
      }

      // Active event during the clear window. A genuinely different objective means the provider moved
      // to a new goal — lift the clear and accept (and accept the original objective again too).
      if (clearBaselineCondition !== null && event.condition !== clearBaselineCondition) {
        liftClear();
        return 'accept';
      }

      // Same-objective (or unknown) re-evaluation of the cleared goal — suppress until a set intent.
      return 'suppress';
    },
    snapshot() {
      return {
        epoch,
        ...(lastSetEpoch !== undefined ? { lastSetEpoch } : {}),
        ...(clear ? { clear } : {}),
      };
    },
  };
}
