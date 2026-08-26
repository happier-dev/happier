import { z } from 'zod';

import { AutomationRunStateV3Schema } from '../../automations/automationRunStateV3.js';
import { AutomationRunCauseSchema } from '../../automations/automationRunCause.js';
import { AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 } from '../../runtime/eventKindsV1.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1 = '@happier/runtime/' as const;
export const HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1 =
  '@happier/automation/run-state-changed' as const;

export type HostSemanticEventKindV1 = typeof AGENT_SESSION_RUNTIME_EVENT_KINDS_V1[number];
export type RuntimeHostEventIdV1 =
  `${typeof HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1}${HostSemanticEventKindV1}`;
export type HostEventIdV1 = RuntimeHostEventIdV1 | typeof HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1;

/** Runtime Host Event author scopes deliberately remain separate from Account scope. */
export type HostEventScopeV1 =
  | Readonly<{ kind: 'current-session' }>
  | Readonly<{ kind: 'session'; sessionId: string }>;

export type AutomationHostEventScopeV1 = Readonly<{ kind: 'account' }>;

/**
 * The one authoritative cause a machine observer may act on: the user
 * cancelled a Run whose external execution was already permitted to dispatch,
 * so the Run can only be published as uncertain even though cancellation is
 * the authoritative intent.
 */
export const AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1 =
  'cancelledAfterDispatchPermitted' as const;

export const AutomationRunStateChangedHostEventV1Schema = z.object({
  runId: z.string().min(1),
  automationId: z.string().min(1),
  runCause: AutomationRunCauseSchema,
  previousState: AutomationRunStateV3Schema.nullable(),
  currentState: AutomationRunStateV3Schema,
  transitionedAt: z.number().int().min(0),
  claimedByMachineId: z.string().min(1).nullable(),
  /**
   * Why the transition happened, when the state alone is ambiguous. Readers
   * act only on causes they know and treat any other bounded value as absent,
   * so a newer producer cause degrades to the generic lifecycle handling
   * instead of invalidating the whole observation.
   */
  transitionCause: z.string().min(1).max(64).optional(),
}).strict().superRefine((payload, context) => {
  if (payload.previousState === null) {
    if (payload.currentState === 'queued') return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['previousState'],
      message: 'previousState may be null only for the initial queued Run',
    });
    return;
  }
  if (payload.previousState === payload.currentState) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['currentState'],
      message: 'currentState must differ from previousState',
    });
  }
});
export type AutomationRunStateChangedHostEventV1 = z.infer<
  typeof AutomationRunStateChangedHostEventV1Schema
>;

const ALL_HOST_SEMANTIC_EVENT_KINDS_V1 = Object.freeze([
  ...new Set<HostSemanticEventKindV1>([
    ...AGENT_SESSION_RUNTIME_EVENT_KINDS_V1,
  ]),
]);

export const RUNTIME_HOST_EVENT_IDS_V1 = Object.freeze(ALL_HOST_SEMANTIC_EVENT_KINDS_V1.map(
  (kind): RuntimeHostEventIdV1 => `${HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1}${kind}`,
));

export const HOST_EVENT_IDS_V1 = Object.freeze([
  ...RUNTIME_HOST_EVENT_IDS_V1,
  HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
] as const);

const HOST_EVENT_ID_SET_V1 = new Set<string>(HOST_EVENT_IDS_V1);
const RUNTIME_HOST_EVENT_ID_SET_V1 = new Set<string>(RUNTIME_HOST_EVENT_IDS_V1);

export function isHostEventIdV1(value: string): value is HostEventIdV1 {
  return HOST_EVENT_ID_SET_V1.has(value);
}

export function isRuntimeHostEventIdV1(value: string): value is RuntimeHostEventIdV1 {
  return RUNTIME_HOST_EVENT_ID_SET_V1.has(value);
}

export const HostEventIdV1Schema = z.string().refine(
  isHostEventIdV1,
  'Unknown Host Event id',
);

export const RuntimeHostEventIdV1Schema = z.string().refine(
  isRuntimeHostEventIdV1,
  'Unknown runtime Host Event id',
);

export const HostEventScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current-session') }).strict(),
  z.object({ kind: z.literal('session'), sessionId: asProtocolZod(SessionIdSchema) }).strict(),
]);

export const AutomationHostEventScopeV1Schema = z.object({
  kind: z.literal('account'),
}).strict();

/**
 * Portable subscription-target validation. Payload parsing remains in
 * `hostV1`; manifest ingestion needs only the closed Event id/scope pairing
 * and must not acquire the Agent runtime payload graph.
 */
export const RuntimeHostEventTargetV1Schema = z.object({
  eventId: RuntimeHostEventIdV1Schema,
  scope: HostEventScopeV1Schema,
}).strict();

export const AutomationHostEventTargetV1Schema = z.object({
  eventId: z.literal(HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1),
  scope: AutomationHostEventScopeV1Schema,
}).strict();

export const HostEventTargetV1Schema = z.union([
  RuntimeHostEventTargetV1Schema,
  AutomationHostEventTargetV1Schema,
]);

export type RuntimeHostEventCatalogEntryV1 = Readonly<{
  id: RuntimeHostEventIdV1;
  semanticKind: HostSemanticEventKindV1;
  canonicalProducer: 'centralized-host-session-runtime';
  sourceProducers: readonly ['agent-session-runtime-event'];
  payloadType: 'HostSemanticEventV1';
  privacy: 'session';
  allowedScopes: readonly ['current-session', 'session'];
  realm: 'daemon';
  disposition: 'public';
}>;

export type AutomationRunStateChangedHostEventCatalogEntryV1 = Readonly<{
  id: typeof HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1;
  canonicalProducer: 'automation-run-transition';
  sourceProducers: readonly ['automation-run-transition'];
  payloadType: 'AutomationRunStateChangedHostEventV1';
  privacy: 'account';
  allowedScopes: readonly ['account'];
  realm: 'daemon';
  disposition: 'public';
}>;

export type HostEventCatalogEntryV1 =
  | RuntimeHostEventCatalogEntryV1
  | AutomationRunStateChangedHostEventCatalogEntryV1;

export const HOST_EVENT_CATALOG_V1: readonly HostEventCatalogEntryV1[] = Object.freeze([
  ...ALL_HOST_SEMANTIC_EVENT_KINDS_V1.map((semanticKind): RuntimeHostEventCatalogEntryV1 => Object.freeze({
    id: `${HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1}${semanticKind}`,
    semanticKind,
    canonicalProducer: 'centralized-host-session-runtime',
    sourceProducers: Object.freeze(['agent-session-runtime-event'] as const),
    payloadType: 'HostSemanticEventV1',
    privacy: 'session',
    allowedScopes: Object.freeze(['current-session', 'session'] as const),
    realm: 'daemon',
    disposition: 'public',
  })),
  Object.freeze({
    id: HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
    canonicalProducer: 'automation-run-transition',
    sourceProducers: Object.freeze(['automation-run-transition'] as const),
    payloadType: 'AutomationRunStateChangedHostEventV1',
    privacy: 'account',
    allowedScopes: Object.freeze(['account'] as const),
    realm: 'daemon',
    disposition: 'public',
  }),
]);
