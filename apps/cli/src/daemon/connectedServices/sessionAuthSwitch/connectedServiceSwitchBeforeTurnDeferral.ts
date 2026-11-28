import type {
  ConnectedServiceSwitchDeferralQueue,
  ConnectedServiceSwitchTarget,
} from './connectedServiceSwitchDeferralQueue';
import type { ConnectedServiceSwitchBoundaryDeadline } from './connectedServiceSwitchDeferralQueue';
import type { ConnectedServiceGenerationExecutionAuthority } from './connectedServiceAuthSwitchOutcome';
import type { ConnectedServiceSessionAuthSwitchReason } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import type { ConnectedServiceRuntimeAuthApplyCapability } from '../credentials/lifecycleTypes';
import { shouldHoldConnectedServiceSwitchUntilTurnEnd } from '../accountGroups/switching/predictiveSoftSwitchPolicy';

export type ConnectedServiceBeforeTurnDeferredSwitchResult = Readonly<{
  status: 'deferred';
  policy: 'defer_until_turn_boundary';
  reason: 'turn_in_flight';
}>;

export async function requestConnectedServiceSwitchBeforeTurnWithDeferral<T>(input: Readonly<{
  deferralQueue: ConnectedServiceSwitchDeferralQueue;
  sessionId: string;
  source: 'manual' | 'automatic';
  policy: 'defer_until_turn_boundary';
  boundaryDeadline?: ConnectedServiceSwitchBoundaryDeadline;
  target: ConnectedServiceSwitchTarget;
  runSwitch: () => Promise<T>;
  onDeferredSwitchFailure?: (error: unknown) => void;
}>): Promise<T | ConnectedServiceBeforeTurnDeferredSwitchResult> {
  if (!input.deferralQueue.isTurnInFlight(input.sessionId)) {
    return await input.runSwitch();
  }

  void input.deferralQueue.requestSwitch({
    sessionId: input.sessionId,
    source: input.source,
    policy: input.policy,
    ...(input.boundaryDeadline ? { boundaryDeadline: input.boundaryDeadline } : {}),
    target: input.target,
    runSwitch: async () => {
      await input.runSwitch();
    },
  }).catch((error) => {
    input.onDeferredSwitchFailure?.(error);
  });

  return {
    status: 'deferred',
    policy: input.policy,
    reason: 'turn_in_flight',
  };
}

/** Apply result error code: the switch is queued for the turn's end, not failed. */
export const CONNECTED_SERVICE_SWITCH_HELD_UNTIL_TURN_END = 'switch_held_until_turn_end';

/**
 * Applies an automatic, non-failure account switch (a pool's soft-threshold rotation or the
 * catch-up of a generation committed elsewhere) without interrupting a turn the provider cannot
 * switch in. Whether a provider can switch mid-turn is the lifecycle descriptor's
 * `runtimeAuthApply` fact. A provider that can (Claude, Codex) applies now, as before. One that
 * cannot waits for the turn to end with no forced deadline; if the turn hits the hard limit first,
 * usage-limit recovery (`automatic_runtime_failure`) switches then on its own path.
 */
export async function applyConnectedServiceGenerationAtTurnEnd<T>(input: Readonly<{
  deferralQueue: ConnectedServiceSwitchDeferralQueue;
  sessionId: string;
  target: ConnectedServiceSwitchTarget;
  switchReason: ConnectedServiceSessionAuthSwitchReason;
  executionAuthority: ConnectedServiceGenerationExecutionAuthority;
  runtimeAuthApply: ConnectedServiceRuntimeAuthApplyCapability | null | undefined;
  /** `holdUntilTurnEnd` tells the restart step not to force a turn boundary of its own. */
  apply: (holdUntilTurnEnd: boolean) => Promise<T>;
  onDeferredApplyFailure?: (error: unknown) => void;
}>): Promise<T | ConnectedServiceBeforeTurnDeferredSwitchResult> {
  const holdUntilTurnEnd = shouldHoldConnectedServiceSwitchUntilTurnEnd(input);
  if (!holdUntilTurnEnd) return await input.apply(false);
  return await requestConnectedServiceSwitchBeforeTurnWithDeferral({
    deferralQueue: input.deferralQueue,
    sessionId: input.sessionId,
    source: 'automatic',
    policy: 'defer_until_turn_boundary',
    boundaryDeadline: 'none',
    target: input.target,
    runSwitch: async () => await input.apply(true),
    ...(input.onDeferredApplyFailure ? { onDeferredSwitchFailure: input.onDeferredApplyFailure } : {}),
  });
}
