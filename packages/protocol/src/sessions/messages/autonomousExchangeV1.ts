import { z } from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';

/** Exact original input identity; the receiving Account's held projection carries no control authority. */
export const AutonomousExchangeRootV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod<unknown, string>(SessionIdSchema),
  localId: PendingLocalIdSchema,
}));
export type AutonomousExchangeRootV1 = Readonly<z.infer<typeof AutonomousExchangeRootV1Schema>>;

export const AutonomousExchangeStateV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  observedStarts: z.number().check(z.int(), z.nonnegative()),
  pauseAtStarts: z.nullable(z.number().check(z.int(), z.positive())),
  stopped: z.boolean(),
  afterTurns: z.nullable(z.number().check(z.int(), z.positive())),
}));
export type AutonomousExchangeStateV1 = Readonly<z.infer<typeof AutonomousExchangeStateV1Schema>>;

export const AutonomousExchangeObservedRevisionV1Schema = lazyZodSchema(() =>
  z.string().check(z.regex(/^session-message-row-revision:v1:(0|[1-9][0-9]*)$/)));
export const AutonomousExchangeControlKindV1Schema = lazyZodSchema(() =>
  z.enum(['continue', 'continue_more_10', 'stop']));
export const AutonomousExchangeControlRequestV1Schema = lazyZodSchema(() => z.strictObject({
  control: AutonomousExchangeControlKindV1Schema,
  observedRevision: AutonomousExchangeObservedRevisionV1Schema,
}));
export type AutonomousExchangeControlRequestV1 = Readonly<z.infer<typeof AutonomousExchangeControlRequestV1Schema>>;
export const AutonomousExchangeStatusV1Schema = lazyZodSchema(() => z.strictObject({
  state: AutonomousExchangeStateV1Schema,
  observedRevision: AutonomousExchangeObservedRevisionV1Schema,
}));

/** The override object distinguishes explicit Never pause from inheritance. */
export function resolveAutonomousExchangeAfterTurnsV1(accountAfterTurns: number | null,
  discussionOverride?: Readonly<{ afterTurns: number | null }>): number | null {
  return AutonomousExchangeStateV1Schema.shape.afterTurns.parse(discussionOverride === undefined
    ? accountAfterTurns : discussionOverride.afterTurns);
}

export function createAutonomousExchangeStateV1(afterTurns: number | null,
  discussionOverride?: Readonly<{ afterTurns: number | null }>): AutonomousExchangeStateV1 {
  return AutonomousExchangeStateV1Schema.parse({
    v: 1, observedStarts: 0, pauseAtStarts: null, stopped: false,
    afterTurns: resolveAutonomousExchangeAfterTurnsV1(afterTurns, discussionOverride),
  });
}

export const AutonomousExchangeAcceptedTurnV1Schema = lazyZodSchema(() => z.strictObject({
  cause: z.enum(['agent_session', 'quiet_context', 'returned_answer', 'person']),
  deliveryKind: z.enum(['newTurn', 'followUp', 'steer']),
  turnId: z.string().check(z.trim(), z.minLength(1)),
  startsNewTurn: z.boolean(),
}));
export type AutonomousExchangeAcceptedTurnV1 = Readonly<z.infer<typeof AutonomousExchangeAcceptedTurnV1Schema>>;

export function applyAutonomousExchangeAcceptedTurnV1(
  state: AutonomousExchangeStateV1,
  fact: AutonomousExchangeAcceptedTurnV1,
): AutonomousExchangeStateV1 {
  const current = AutonomousExchangeStateV1Schema.parse(state);
  const accepted = AutonomousExchangeAcceptedTurnV1Schema.parse(fact);
  return accepted.cause === 'agent_session' && accepted.deliveryKind !== 'steer' && accepted.startsNewTurn
    ? { ...current, observedStarts: current.observedStarts + 1 }
    : current;
}

export function readAutonomousExchangeAdmissionV1(
  state: AutonomousExchangeStateV1,
): 'allow' | 'check_in' | 'stopped' {
  const current = AutonomousExchangeStateV1Schema.parse(state);
  if (current.stopped) return 'stopped';
  const afterTurns = current.afterTurns;
  if (afterTurns === null) return 'allow';
  return current.observedStarts >= (current.pauseAtStarts ?? afterTurns) ? 'check_in' : 'allow';
}

export function applyAutonomousExchangeControlV1(
  state: AutonomousExchangeStateV1,
  control: Readonly<{ kind: 'continue' | 'continue_more_10' | 'stop' }>,
): AutonomousExchangeStateV1 {
  const current = AutonomousExchangeStateV1Schema.parse(state);
  if (current.stopped) return current;
  if (control.kind === 'stop') return { ...current, stopped: true };
  const additional = control.kind === 'continue'
    ? current.afterTurns
    : 10;
  if (additional === null) return current;
  return { ...current, pauseAtStarts: current.observedStarts + additional };
}
