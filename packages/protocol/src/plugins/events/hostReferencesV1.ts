import { PluginWebhookHeartbeatReceiptHintV1Schema } from '../webhooks/endpointV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { AutomationRunStateV3Schema } from '../../automations/automationRunStateV3.js';
import { AutomationRunCauseSchema } from '../../automations/automationRunCause.js';
import { AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 } from '../../runtime/eventKindsV1.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1 = '@happier/runtime/' as const;
export const HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1 =
  '@happier/automation/run-state-changed' as const;
export const HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1 =
  '@happier/automation/event-sources-invalidated' as const;

export const HAPPIER_HEALTH_CHECK_HEARTBEAT_RECEIVED_HOST_EVENT_ID_V1 = '@happier/health-check/heartbeat-received' as const;
export const HealthCheckHeartbeatReceivedHostEventV1Schema = PluginWebhookHeartbeatReceiptHintV1Schema;
export type HealthCheckHeartbeatReceivedHostEventV1 = z.infer<typeof HealthCheckHeartbeatReceivedHostEventV1Schema>;


export type HostSemanticEventKindV1 = typeof AGENT_SESSION_RUNTIME_EVENT_KINDS_V1[number];
export type RuntimeHostEventIdV1 =
  `${typeof HAPPIER_RUNTIME_HOST_EVENT_PREFIX_V1}${HostSemanticEventKindV1}`;
export type HostEventIdV1 = RuntimeHostEventIdV1
  | typeof HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1
  | typeof HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1
  | typeof HAPPIER_HEALTH_CHECK_HEARTBEAT_RECEIVED_HOST_EVENT_ID_V1;

/** Runtime Host Event author scopes deliberately remain separate from Account scope. */
export type HostEventScopeV1 =
  | Readonly<{ kind: 'current-session' }>
  | Readonly<{ kind: 'session'; sessionId: string }>;

export type AutomationHostEventScopeV1 = Readonly<{ kind: 'account' }>;

/** Lossy wake only: definitions and credentials remain behind their authorized readers. */
export const AutomationEventSourcesInvalidatedHostEventV1Schema = lazyZodSchema(() => z.strictObject({}));
export type AutomationEventSourcesInvalidatedHostEventV1 = z.infer<
  typeof AutomationEventSourcesInvalidatedHostEventV1Schema
>;

/**
 * The user cancelled a Run whose external execution was already permitted to
 * dispatch, so the Run can only be published as uncertain even though
 * cancellation is the authoritative intent.
 */
export const AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1 =
  'cancelledAfterDispatchPermitted' as const;

/**
 * The user cancelled a running Session-target Run. Session targets carry no
 * dispatch vocabulary at all, so their cancellation is published as uncertain
 * with no dispatch fact to name. Without this cause a machine observer cannot
 * separate the user's authoritative intent from an ordinary stale attempt,
 * and the exact deterministic Automation input would stay pending.
 */
export const AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1 =
  'cancelledWhileRunning' as const;

/**
 * The one predicate over the causes that mean "the present user cancelled this
 * Run". Readers must not re-derive this set: an unknown bounded cause from a
 * newer producer degrades to ordinary lifecycle handling rather than borrowing
 * cancellation authority.
 */
export function isAuthoritativeAutomationRunCancellationCauseV1(
  cause: string | undefined,
): boolean {
  return cause === AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1
    || cause === AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1;
}

export const AutomationRunStateChangedHostEventV1Schema = lazyZodSchema(() => z.strictObject({
  runId: z.string().check(z.minLength(1)),
  automationId: z.string().check(z.minLength(1)),
  runCause: AutomationRunCauseSchema,
  previousState: z.nullable(AutomationRunStateV3Schema),
  currentState: AutomationRunStateV3Schema,
  transitionedAt: z.number().check(z.int(), z.minimum(0)),
  claimedByMachineId: z.nullable(z.string().check(z.minLength(1))),
  /**
   * Why the transition happened, when the state alone is ambiguous. Readers
   * act only on causes they know and treat any other bounded value as absent,
   * so a newer producer cause degrades to the generic lifecycle handling
   * instead of invalidating the whole observation.
   */
  transitionCause: z.optional(z.string().check(z.minLength(1), z.maxLength(64))),
}).check(z.superRefine((payload, context) => {
  if (payload.previousState === null) {
    if (payload.currentState === 'queued') return;
    context.addIssue({
      code: "custom",
      path: ['previousState'],
      message: 'previousState may be null only for the initial queued Run',
    });
    return;
  }
  if (payload.previousState === payload.currentState) {
    context.addIssue({
      code: "custom",
      path: ['currentState'],
      message: 'currentState must differ from previousState',
    });
  }
})));
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
  HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1,
  HAPPIER_HEALTH_CHECK_HEARTBEAT_RECEIVED_HOST_EVENT_ID_V1,
] as const);

const HOST_EVENT_ID_SET_V1 = new Set<string>(HOST_EVENT_IDS_V1);
const RUNTIME_HOST_EVENT_ID_SET_V1 = new Set<string>(RUNTIME_HOST_EVENT_IDS_V1);

export function isHostEventIdV1(value: string): value is HostEventIdV1 {
  return HOST_EVENT_ID_SET_V1.has(value);
}

export function isRuntimeHostEventIdV1(value: string): value is RuntimeHostEventIdV1 {
  return RUNTIME_HOST_EVENT_ID_SET_V1.has(value);
}

export const HostEventIdV1Schema = lazyZodSchema(() => z.string().apply((base) => base.check(z.refine<z.output<typeof base>>(isHostEventIdV1, 'Unknown Host Event id')) as typeof base & z.ZodMiniType<HostEventIdV1, z.input<typeof base>>));

export const RuntimeHostEventIdV1Schema = lazyZodSchema(() => z.string().apply((base) => base.check(z.refine<z.output<typeof base>>(isRuntimeHostEventIdV1, 'Unknown runtime Host Event id')) as typeof base & z.ZodMiniType<RuntimeHostEventIdV1, z.input<typeof base>>));

export const HostEventScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('current-session') }),
  z.strictObject({ kind: z.literal('session'), sessionId: asProtocolZod(SessionIdSchema) }),
]));

export const AutomationHostEventScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('account'),
}));

/**
 * Portable subscription-target validation. Payload parsing remains in
 * `hostV1`; manifest ingestion needs only the closed Event id/scope pairing
 * and must not acquire the Agent runtime payload graph.
 */
export const RuntimeHostEventTargetV1Schema = lazyZodSchema(() => z.strictObject({
  eventId: RuntimeHostEventIdV1Schema,
  scope: HostEventScopeV1Schema,
}));

export const AutomationHostEventTargetV1Schema = lazyZodSchema(() => z.strictObject({
  eventId: z.enum([
    HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
    HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1,
  HAPPIER_HEALTH_CHECK_HEARTBEAT_RECEIVED_HOST_EVENT_ID_V1,
  ]),
  scope: AutomationHostEventScopeV1Schema,
}));

export const HostEventTargetV1Schema = lazyZodSchema(() => z.union([
  RuntimeHostEventTargetV1Schema,
  AutomationHostEventTargetV1Schema,
  z.strictObject({
    eventId: z.literal(HAPPIER_HEALTH_CHECK_HEARTBEAT_RECEIVED_HOST_EVENT_ID_V1),
    scope: z.strictObject({ kind: z.literal('account') }),
  }),
]));

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
  | Readonly<{
    id: typeof HAPPIER_HEALTH_CHECK_HEARTBEAT_RECEIVED_HOST_EVENT_ID_V1;
    canonicalProducer: 'webhook-receipt'; sourceProducers: readonly ['webhook-receipt'];
    payloadType: 'HealthCheckHeartbeatReceivedHostEventV1'; privacy: 'account';
    allowedScopes: readonly ['account']; realm: 'daemon'; disposition: 'public';
  }>
  | RuntimeHostEventCatalogEntryV1
  | AutomationRunStateChangedHostEventCatalogEntryV1
  | Readonly<{
    id: typeof HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1;
    canonicalProducer: 'account-change-feed';
    sourceProducers: readonly ['account-change-feed'];
    payloadType: 'AutomationEventSourcesInvalidatedHostEventV1';
    privacy: 'account';
    allowedScopes: readonly ['account'];
    realm: 'daemon';
    disposition: 'public';
  }>;

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
  Object.freeze({
    id: HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1,
    canonicalProducer: 'account-change-feed',
    sourceProducers: Object.freeze(['account-change-feed'] as const),
    payloadType: 'AutomationEventSourcesInvalidatedHostEventV1',
    privacy: 'account',
    allowedScopes: Object.freeze(['account'] as const),
    realm: 'daemon',
    disposition: 'public',
  }),
  Object.freeze({
    id: HAPPIER_HEALTH_CHECK_HEARTBEAT_RECEIVED_HOST_EVENT_ID_V1,
    canonicalProducer: 'webhook-receipt', sourceProducers: Object.freeze(['webhook-receipt'] as const),
    payloadType: 'HealthCheckHeartbeatReceivedHostEventV1', privacy: 'account',
    allowedScopes: Object.freeze(['account'] as const), realm: 'daemon', disposition: 'public',
  }),
]);
