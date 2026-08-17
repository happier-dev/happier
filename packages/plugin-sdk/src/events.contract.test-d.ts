import type {
  EventSubscriptionTargetV1 as ProtocolEventSubscriptionTargetV1,
  HostEventEnvelope as ProtocolHostEventEnvelope,
  HostEventPayloadById,
  HostEventTarget as ProtocolHostEventTarget,
} from '@happier-dev/protocol';

import type {
  EventSubscriptionTarget,
  HostEventEnvelope,
  HostEventTarget,
} from './events.js';

type Assert<Condition extends true> = Condition;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type IsEqual<Left, Right> = (
  <T>() => T extends Left ? 1 : 2
) extends (
  <T>() => T extends Right ? 1 : 2
) ? true : false;

type RuntimeAccountTarget = Readonly<{
  eventId: '@happier/runtime/turn-complete';
  scope: Readonly<{ kind: 'account' }>;
}>;

type AutomationAccountEnvelope = Readonly<{
  eventId: '@happier/automation/run-state-changed';
  scope: Readonly<{ kind: 'account' }>;
  payload: HostEventPayloadById['@happier/automation/run-state-changed'];
}>;

type RuntimeAccountEnvelope = Readonly<{
  eventId: '@happier/runtime/turn-complete';
  scope: Readonly<{ kind: 'account' }>;
  payload: HostEventPayloadById['@happier/runtime/turn-complete'];
}>;

type RuntimeSessionSubscriptionTarget = Readonly<{
  kind: 'host';
  eventId: '@happier/runtime/turn-complete';
  scope: Readonly<{ kind: 'session'; sessionId: string }>;
}>;

type AutomationAccountSubscriptionTarget = Readonly<{
  kind: 'host';
  eventId: '@happier/automation/run-state-changed';
  scope: Readonly<{ kind: 'account' }>;
}>;

type RuntimeAccountSubscriptionTarget = Readonly<{
  kind: 'host';
  eventId: '@happier/runtime/turn-complete';
  scope: Readonly<{ kind: 'account' }>;
}>;

type IncompleteHostSubscriptionTarget = Readonly<{
  kind: 'host';
}>;

type _SdkTargetIsTheExactProtocolProjection = Assert<
  IsEqual<HostEventTarget, ProtocolHostEventTarget>
>;

type _SdkEnvelopeIsTheExactProtocolProjection = Assert<
  IsEqual<HostEventEnvelope, ProtocolHostEventEnvelope>
>;

type _SdkAutomationAccountEnvelopeIsAllowed = Assert<
  IsAssignable<AutomationAccountEnvelope, HostEventEnvelope>
>;

type _SdkRuntimeEventCannotUseAccountTarget = Assert<
  IsAssignable<RuntimeAccountTarget, HostEventTarget> extends false ? true : false
>;

type _SdkRuntimeEventCannotUseAccountEnvelope = Assert<
  IsAssignable<RuntimeAccountEnvelope, HostEventEnvelope> extends false ? true : false
>;

type _SdkSubscriptionTargetIsTheExactProtocolProjection = Assert<
  IsEqual<EventSubscriptionTarget, ProtocolEventSubscriptionTargetV1>
>;

type _SdkRuntimeSessionSubscriptionTargetIsAllowed = Assert<
  IsAssignable<RuntimeSessionSubscriptionTarget, EventSubscriptionTarget>
>;

type _SdkAutomationAccountSubscriptionTargetIsAllowed = Assert<
  IsAssignable<AutomationAccountSubscriptionTarget, EventSubscriptionTarget>
>;

type _SdkRuntimeEventCannotUseAccountSubscriptionTarget = Assert<
  IsAssignable<RuntimeAccountSubscriptionTarget, EventSubscriptionTarget> extends false ? true : false
>;

type _SdkHostSubscriptionTargetRequiresEventAndScope = Assert<
  IsAssignable<IncompleteHostSubscriptionTarget, EventSubscriptionTarget> extends false ? true : false
>;
