import { describe, expect, it } from 'vitest';

import { SessionAgentTransitionResultV1Schema } from './agentTransition.js';
import {
  beginSessionAgentTransitionEffects,
  rejectUndispatchedSessionAgentTransition,
} from './agentTransitionEffectStage.js';

const LOCAL_ID = 'local-1';

describe('session agent transition effect stages', () => {
  /* --------------------------------------------------------------------- *
   * The class closure itself is a DECLARATION-level contract and lives in
   * `agentTransitionEffectStage.contract.test-d.ts`, which the package
   * typecheck compiles (this file is excluded from it). A tenth instance of
   * the arm-guarantee class fails `yarn --cwd packages/protocol typecheck`.
   *
   * This runtime case is the complement: the stage handles really are frozen
   * and really do withhold the arms the declaration fixture forbids, so no
   * `as any` cast or structural widening can reach one at runtime either.
   * --------------------------------------------------------------------- */
  it('withholds every arm that over-claims its depth at runtime too', () => {
    const untouched = beginSessionAgentTransitionEffects({ localId: LOCAL_ID });
    const stopped = untouched.stopConfirmed();
    const committed = stopped.cutoverCommitted();

    const arms = (stage: object): readonly string[] => Object.keys(stage).sort();

    expect(arms(untouched)).toEqual([
      'cutoverObservedCommitted', 'outcomeUnknown', 'rejected', 'stopConfirmed', 'withInputFence',
    ]);
    // The tenth instance: `rejected('stale_selection')` after the confirmed
    // stop, and after the cutover committed.
    expect(arms(stopped)).toEqual(['cutoverCommitted', 'outcomeUnknown', 'sourceStopped']);
    // `outcomeUnknown` is the modest arm at every shallower depth, and the one
    // arm that must NOT survive to this one: once the cutover is an observed
    // fact, "the daemon cannot establish what happened" is false, and the
    // client answers it by keeping the armed switch alive in front of a Session
    // that has already switched.
    expect(arms(committed)).toEqual(['accepted', 'committed']);

    expect(Object.isFrozen(untouched)).toBe(true);
    expect(Object.isFrozen(stopped)).toBe(true);
    expect(Object.isFrozen(committed)).toBe(true);
  });

  it('builds the pre-effect arms with a truthful sourceEffect', () => {
    const untouched = beginSessionAgentTransitionEffects({ localId: LOCAL_ID });
    expect(untouched.rejected('source_not_idle')).toEqual({
      type: 'rejected',
      code: 'source_not_idle',
      sourceEffect: 'none',
    });
    expect(untouched.outcomeUnknown()).toEqual({ type: 'outcome_unknown', localId: LOCAL_ID });
    expect(rejectUndispatchedSessionAgentTransition('unsupported_operation')).toEqual({
      type: 'rejected',
      code: 'unsupported_operation',
      sourceEffect: 'none',
    });
  });

  it('reopens the input fence before every exit taken while it is installed', async () => {
    const reopened: string[] = [];
    const fenced = beginSessionAgentTransitionEffects({ localId: LOCAL_ID })
      .withInputFence(async () => {
        reopened.push('clear');
      });

    // The eighth instance: a fence request that throws proves "no answer", not
    // "no fence". Both fenced exits therefore restore the epoch first, and the
    // call site cannot skip it.
    await expect(fenced.rejected('source_not_idle')).resolves.toEqual({
      type: 'rejected',
      code: 'source_not_idle',
      sourceEffect: 'none',
    });
    expect(reopened).toEqual(['clear']);

    await expect(fenced.outcomeUnknown()).resolves.toEqual({
      type: 'outcome_unknown',
      localId: LOCAL_ID,
    });
    expect(reopened).toEqual(['clear', 'clear']);
  });

  it('does not reopen the fence once the stop is confirmed', () => {
    let reopens = 0;
    const stopped = beginSessionAgentTransitionEffects({ localId: LOCAL_ID })
      .withInputFence(async () => {
        reopens += 1;
      })
      .stopConfirmed();

    expect(stopped.sourceStopped('context_unavailable')).toEqual({
      type: 'partially_applied',
      localId: LOCAL_ID,
      applied: 'source_stopped',
      code: 'context_unavailable',
    });
    // The fence lived in the retired source runner; the target lifecycle owns
    // the reopen for its own epoch.
    expect(reopens).toBe(0);
  });

  it('correlates applied depth with code, and every arm parses as the wire result', () => {
    const stopped = beginSessionAgentTransitionEffects({ localId: LOCAL_ID }).stopConfirmed();
    const committed = stopped.cutoverCommitted();

    const arms = [
      stopped.sourceStopped('cutover_conflict'),
      stopped.outcomeUnknown(),
      committed.committed('divider_conflict'),
      committed.committed('divider_unknown'),
      committed.committed('input_admission_failed'),
      committed.accepted(),
    ];
    for (const arm of arms) {
      expect(SessionAgentTransitionResultV1Schema.safeParse(arm).success).toBe(true);
    }

    expect(committed.committed('target_start_failed')).toEqual({
      type: 'partially_applied',
      localId: LOCAL_ID,
      applied: 'current_view_committed',
      code: 'target_start_failed',
    });
    expect(committed.accepted()).toEqual({ type: 'accepted', localId: LOCAL_ID });
  });

  it('treats an observed already-committed cutover as the committed depth', () => {
    // Section 7.5: the Session already names the target, so this is the
    // operation's own cutover seen again — never a no-effect rejection.
    const committed = beginSessionAgentTransitionEffects({ localId: LOCAL_ID })
      .cutoverObservedCommitted();
    expect(committed.committed('divider_missing')).toEqual({
      type: 'partially_applied',
      localId: LOCAL_ID,
      applied: 'current_view_committed',
      code: 'divider_missing',
    });
  });
});
