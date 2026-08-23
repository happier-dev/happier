import {
  AgentSessionRuntimeEventSchema,
  type AgentSessionRuntimeEvent,
} from '../../runtime/agentSessionV1.js';
import {
  AutomationHostEventScopeV1Schema,
  AutomationRunStateChangedHostEventV1Schema,
  HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
  HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1,
  HOST_EVENT_CATALOG_V1,
  HOST_EVENT_IDS_V1,
  HostEventIdV1Schema,
  HostEventScopeV1Schema,
  HostEventTargetV1Schema,
  RuntimeHostEventIdV1Schema,
  isHostEventIdV1,
  isRuntimeHostEventIdV1,
  type AutomationHostEventScopeV1,
  type AutomationRunStateChangedHostEventV1,
  type HostEventCatalogEntryV1,
  type HostEventIdV1,
  type HostEventScopeV1,
  type HostSemanticEventKindV1,
  type RuntimeHostEventIdV1,
} from './hostReferencesV1.js';

export {
  AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1,
  AutomationHostEventScopeV1Schema,
  AutomationRunStateChangedHostEventV1Schema,
  HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
  HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1,
  HOST_EVENT_CATALOG_V1,
  HOST_EVENT_IDS_V1,
  HostEventIdV1Schema,
  HostEventScopeV1Schema,
  HostEventTargetV1Schema,
  RuntimeHostEventIdV1Schema,
  type AutomationHostEventScopeV1,
  type AutomationRunStateChangedHostEventV1,
  type HostEventCatalogEntryV1,
  type HostEventIdV1,
  type HostEventScopeV1,
  type HostSemanticEventKindV1,
  type RuntimeHostEventIdV1,
} from './hostReferencesV1.js';

export type HostSemanticEventV1 = AgentSessionRuntimeEvent;

type RuntimeHostEventPayloadByIdV1 = {
  readonly [Kind in HostSemanticEventKindV1 as `${typeof HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1}${Kind}`]:
    Extract<HostSemanticEventV1, Readonly<{ kind: Kind }>>;
};

export type HostEventPayloadByIdV1 = RuntimeHostEventPayloadByIdV1 & Readonly<{
  [HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1]: AutomationRunStateChangedHostEventV1;
}>;

export type HostEventScopeByIdV1 = {
  readonly [Id in RuntimeHostEventIdV1]: HostEventScopeV1;
} & Readonly<{
  [HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1]: AutomationHostEventScopeV1;
}>;

type HostEventDeliveryScopeByIdV1 = {
  readonly [Id in RuntimeHostEventIdV1]: Readonly<{ kind: 'session'; sessionId: string }>;
} & Readonly<{
  [HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1]: AutomationHostEventScopeV1;
}>;

export type HostEventTargetV1<Id extends HostEventIdV1 = HostEventIdV1> =
  Id extends HostEventIdV1
    ? Readonly<{
      eventId: Id;
      scope: HostEventScopeByIdV1[Id];
    }>
    : never;

export type HostEventEnvelopeV1<Id extends HostEventIdV1 = HostEventIdV1> =
  Id extends HostEventIdV1
    ? Readonly<{
      eventId: Id;
      scope: HostEventDeliveryScopeByIdV1[Id];
      payload: HostEventPayloadByIdV1[Id];
    }>
    : never;

/** Stable author-facing aliases; the V1 names remain the protocol wire owners. */
export type HostEventId = HostEventIdV1;
export type HostEventPayloadById = HostEventPayloadByIdV1;
export type HostEventScopeById = HostEventScopeByIdV1;
export type HostEventScope = HostEventScopeV1;
export type HostEventTarget<Id extends HostEventId = HostEventId> = HostEventTargetV1<Id>;
export type HostEventEnvelope<Id extends HostEventId = HostEventId> = HostEventEnvelopeV1<Id>;

export function parseHostEventPayloadV1<Id extends HostEventIdV1>(
  eventId: Id,
  payload: unknown,
): HostEventPayloadByIdV1[Id] {
  if (!isHostEventIdV1(eventId)) {
    throw new Error(`Unknown Host Event id '${eventId}'`);
  }
  if (eventId === HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1) {
    const automation = AutomationRunStateChangedHostEventV1Schema.safeParse(payload);
    if (automation.success) {
      return automation.data as HostEventPayloadByIdV1[Id];
    }
    throw new Error(`Invalid payload for Host Event '${eventId}'`);
  }
  if (!isRuntimeHostEventIdV1(eventId)) {
    throw new Error(`Unknown Host Event id '${eventId}'`);
  }
  const expectedKind = eventId.slice(HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1.length);
  const agent = AgentSessionRuntimeEventSchema.safeParse(payload);
  if (agent.success && agent.data.kind === expectedKind) {
    return agent.data as HostEventPayloadByIdV1[Id];
  }
  throw new Error(`Invalid payload for Host Event '${eventId}'`);
}

export function hostEventIdForSemanticEventV1(
  event: HostSemanticEventV1,
): HostEventIdV1 {
  return `${HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1}${event.kind}`;
}
