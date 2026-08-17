import type { EventSubscriptionTargetV1 } from './events.js';

type Assert<Condition extends true> = Condition;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

type RuntimeSessionTarget = Readonly<{
  kind: 'host';
  eventId: '@happier/runtime/turn-complete';
  scope: Readonly<{ kind: 'session'; sessionId: string }>;
}>;

type AutomationAccountTarget = Readonly<{
  kind: 'host';
  eventId: '@happier/automation/run-state-changed';
  scope: Readonly<{ kind: 'account' }>;
}>;

type RuntimeAccountTarget = Readonly<{
  kind: 'host';
  eventId: '@happier/runtime/turn-complete';
  scope: Readonly<{ kind: 'account' }>;
}>;

type IncompleteHostTarget = Readonly<{ kind: 'host' }>;

type _RuntimeSessionTargetIsAllowed = Assert<
  IsAssignable<RuntimeSessionTarget, EventSubscriptionTargetV1>
>;

type _AutomationAccountTargetIsAllowed = Assert<
  IsAssignable<AutomationAccountTarget, EventSubscriptionTargetV1>
>;

type _RuntimeAccountTargetIsRejected = Assert<
  IsAssignable<RuntimeAccountTarget, EventSubscriptionTargetV1> extends false ? true : false
>;

type _HostTargetRequiresEventAndScope = Assert<
  IsAssignable<IncompleteHostTarget, EventSubscriptionTargetV1> extends false ? true : false
>;
