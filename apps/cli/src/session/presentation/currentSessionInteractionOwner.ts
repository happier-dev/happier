import { randomUUID } from 'node:crypto';

import { createTransientInteractionOwner, createUnavailableTransientInteractionOwner, isTransientInteractionDeadlineMs } from '@happier-dev/protocol/plugins/interactions/owner';
import type { TransientInteractionOwner, TransientInteractionPresenter, PluginExecutionScopeV1 } from '@happier-dev/protocol';

/** Kept for existing Session adapters; the cross-realm core owns the validation and the bound. */
export function isCurrentSessionInteractionDeadlineMs(value: unknown): value is number {
  return isTransientInteractionDeadlineMs(value);
}

/**
 * Host policy for the exact-Session arm, derived from the interactive-permission
 * boundary this codebase already owns rather than from a chosen duration.
 *
 * L-25 (`.project/plans/runtime-unification/00-LOCKED-TARGET-ARCHITECTURE.md`
 * §L-25, user-locked 2026-04-27) is the incumbent owner of how long an
 * interactive permission/confirmation may stay open: "Permissions wait
 * indefinitely by default. The backend manages its own permission lifetime; the
 * host does NOT impose timeout", and "Interactive tools (`ExitPlanMode`,
 * `AskUserQuestion`, etc.) NEVER have a timeout regardless of setting." It is
 * enforced by `scripts/testing/migrations/runtimeUnification/validators/
 * validateNoHostImposedPermissionTtl.ts` and is still the live product default
 * (`claudeLocalPermissionBridgeWaitIndefinitely` defaults to `true`). Every
 * Session-arm transient interaction is presented through exactly that permission
 * owner, so the host has no wall-clock budget to derive a shorter value from.
 *
 * `INTERACTION-TRANSIENT-V1` therefore represents that policy directly: the
 * Session arm selects the contract's explicit no-deadline arm, which stamps no
 * `expiresAtMs` and creates no timer at all. The request is settled only by an
 * observable lifecycle event — the user's answer, requester abort, occurrence
 * retirement, Session end, or host unavailability — exactly as L-25 requires,
 * and `timedOut` is unreachable here rather than merely improbable.
 */
export const CURRENT_SESSION_INTERACTION_DEADLINE_MS: null = null;

/**
 * Exact-Session facade over the one host-private lifecycle owner. It supplies
 * the Session arm and its lifecycle signal; it never owns another map, timer,
 * parser, or settlement path.
 */
export type CurrentSessionInteractionOwner = TransientInteractionOwner;

type OwnerParams = Readonly<{
  sessionId: string;
  sessionSignal: AbortSignal;
  isOccurrenceCurrent(): boolean;
  /** `null` selects the contract's no-deadline arm; see the policy above. */
  deadlineMs: number | null;
  present: TransientInteractionPresenter;
  propagatePresentationError?: (error: unknown) => boolean;
  now?: () => number;
  createRequestId?: () => string;
}>;

type ExecutionRunOwnerParams = Omit<OwnerParams, 'sessionId' | 'sessionSignal'> & Readonly<{
  executionRunId: string;
  executionRunSignal: AbortSignal;
}>;

function createCurrentScopedInteractionOwner(params: Readonly<{
  scope: PluginExecutionScopeV1;
  scopeSignal: AbortSignal;
  isOccurrenceCurrent(): boolean;
  deadlineMs: number | null;
  present: TransientInteractionPresenter;
  propagatePresentationError?: (error: unknown) => boolean;
  now?: () => number;
  createRequestId?: () => string;
}>): CurrentSessionInteractionOwner {
  return createTransientInteractionOwner({
    scope: params.scope,
    ...(params.scope.kind === 'session'
      ? { sessionSignal: params.scopeSignal }
      : { executionRunSignal: params.scopeSignal }),
    isOccurrenceCurrent: params.isOccurrenceCurrent,
    deadlineMs: params.deadlineMs,
    present: params.present,
    ...(params.propagatePresentationError
      ? { propagatePresentationError: params.propagatePresentationError }
      : {}),
    ...(params.now ? { now: params.now } : {}),
    createRequestId: params.createRequestId ?? randomUUID,
  });
}

export function createCurrentSessionInteractionOwner(params: OwnerParams): CurrentSessionInteractionOwner {
  const sessionId = params.sessionId.trim();
  if (!sessionId) throw new Error('Transient interaction Session id must be non-empty');
  return createCurrentScopedInteractionOwner({
    scope: Object.freeze({ kind: 'session', sessionId }),
    scopeSignal: params.sessionSignal,
    isOccurrenceCurrent: params.isOccurrenceCurrent,
    deadlineMs: params.deadlineMs,
    present: params.present,
    ...(params.propagatePresentationError
      ? { propagatePresentationError: params.propagatePresentationError }
      : {}),
    ...(params.now ? { now: params.now } : {}),
    ...(params.createRequestId ? { createRequestId: params.createRequestId } : {}),
  });
}

/** Detached-Run facade over the same host-private interaction owner and lifecycle map. */
export function createCurrentExecutionRunInteractionOwner(
  params: ExecutionRunOwnerParams,
): CurrentSessionInteractionOwner {
  const executionRunId = params.executionRunId.trim();
  if (!executionRunId) throw new Error('Transient interaction Execution Run id must be non-empty');
  return createCurrentScopedInteractionOwner({
    scope: Object.freeze({ kind: 'execution_run', executionRunId }),
    scopeSignal: params.executionRunSignal,
    isOccurrenceCurrent: params.isOccurrenceCurrent,
    deadlineMs: params.deadlineMs,
    present: params.present,
    ...(params.propagatePresentationError
      ? { propagatePresentationError: params.propagatePresentationError }
      : {}),
    ...(params.now ? { now: params.now } : {}),
    ...(params.createRequestId ? { createRequestId: params.createRequestId } : {}),
  });
}

/**
 * A deliberately inert Session binding used when the host lacks the required
 * lifecycle authority — no permission owner, Session signal, or currentness
 * source — or when a caller supplies a deadline outside the cross-realm bound.
 * It never invokes a presenter and delegates its canonical unavailable result
 * shape to the same cross-realm owner module.
 */
export function createUnavailableCurrentSessionInteractionOwner(
  params: Readonly<{ createRequestId?: () => string }> = {},
): CurrentSessionInteractionOwner {
  return createUnavailableTransientInteractionOwner({
    createRequestId: params.createRequestId ?? randomUUID,
  });
}
