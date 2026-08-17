import type {
  HostEventEnvelopeV1,
  HostEventPayloadByIdV1,
  HostEventTargetV1,
} from './hostV1.js';

type Assert<Condition extends true> = Condition;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

type AutomationAccountTarget = Readonly<{
  eventId: '@happier/automation/run-state-changed';
  scope: Readonly<{ kind: 'account' }>;
}>;

type RuntimeAccountTarget = Readonly<{
  eventId: '@happier/runtime/turn-complete';
  scope: Readonly<{ kind: 'account' }>;
}>;

type AutomationAccountEnvelope = Readonly<{
  eventId: '@happier/automation/run-state-changed';
  scope: Readonly<{ kind: 'account' }>;
  payload: HostEventPayloadByIdV1['@happier/automation/run-state-changed'];
}>;

type RuntimeAccountEnvelope = Readonly<{
  eventId: '@happier/runtime/turn-complete';
  scope: Readonly<{ kind: 'account' }>;
  payload: HostEventPayloadByIdV1['@happier/runtime/turn-complete'];
}>;

type _AutomationAccountTargetIsAllowed = Assert<
  IsAssignable<AutomationAccountTarget, HostEventTargetV1>
>;

type _AutomationAccountEnvelopeIsAllowed = Assert<
  IsAssignable<AutomationAccountEnvelope, HostEventEnvelopeV1>
>;

type _RuntimeEventCannotUseAccountTarget = Assert<
  IsAssignable<RuntimeAccountTarget, HostEventTargetV1> extends false ? true : false
>;

type _RuntimeEventCannotUseAccountEnvelope = Assert<
  IsAssignable<RuntimeAccountEnvelope, HostEventEnvelopeV1> extends false ? true : false
>;
