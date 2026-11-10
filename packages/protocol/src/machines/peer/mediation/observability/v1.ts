import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from '../../../../zodRuntimePolicy.js';

import { PeerFlowKindV1Schema } from '../flowKind.js';
import { PeerRouteKindV1Schema } from '../routeKind.js';
import { rejectUnsafePeerMediationObservabilityDataKeys } from './redaction.js';
import { peerMediationObservabilityScopesEqual } from './scopeIdentity.js';

export const PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT = 'peer:observability:snapshot:v1' as const;
export const PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT = 'peer:observability:delta:v1' as const;
export const PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT = 'peer:observability:subscribe:v1' as const;
export const PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT = 'peer:observability:unsubscribe:v1' as const;

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const NonNegativeIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

export const PeerMediationObservabilityEventKindV1Schema = lazyZodSchema(() => z.enum([
  'flow.started',
  'flow.ready',
  'flow.denied',
  'flow.closed',
  'flow.aborted',
  'flow.errored',
  'tunnel.substream.opened',
  'tunnel.substream.closed',
  'tunnel.substream.aborted',
  'tunnel.bytes',
  'stream.frame',
  'stream.backpressure',
  'http.request.started',
  'http.request.headers',
  'http.request.finished',
  'http.request.aborted',
  'websocket.opened',
  'websocket.closed',
  'websocket.aborted',
  'websocket.errored',
  'cap.exceeded',
  'policy.denied',
]));
export type PeerMediationObservabilityEventKindV1 = z.infer<
  typeof PeerMediationObservabilityEventKindV1Schema
>;

export const PeerMediationObservabilityDeniedReasonV1Schema = lazyZodSchema(() => z.enum([
  'observability_unavailable',
  'feature_disabled',
  'scope_unauthorized',
  'machine_unauthorized',
  'session_unauthorized',
  'preview_scope_mismatch',
  'plugin_scope_mismatch',
  'public_scope_limited',
  'policy_denied',
]));
export type PeerMediationObservabilityDeniedReasonV1 = z.infer<
  typeof PeerMediationObservabilityDeniedReasonV1Schema
>;

export const PeerMediationObservabilityScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
      kind: z.literal('account'),
      accountId: IdSchema,
    }),
  z.strictObject({
      kind: z.literal('machine'),
      accountId: IdSchema,
      machineId: IdSchema,
    }),
  z.strictObject({
      kind: z.literal('session'),
      accountId: IdSchema,
      sessionId: IdSchema,
    }),
  z.strictObject({
      kind: z.literal('publicPreview'),
      publicExposureId: IdSchema,
    }),
  z.strictObject({
      kind: z.literal('pluginSurface'),
      accountId: IdSchema,
      pluginId: IdSchema,
      surfaceId: IdSchema,
    }),
]));
export type PeerMediationObservabilityScopeV1 = z.infer<typeof PeerMediationObservabilityScopeV1Schema>;

export const PeerMediationProductRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preview'), id: IdSchema, redacted: z._default(z.boolean(), false) }),
  z.strictObject({ kind: z.literal('publicExposure'), id: IdSchema, redacted: z._default(z.boolean(), false) }),
  z.strictObject({ kind: z.literal('browserView'), id: IdSchema, redacted: z._default(z.boolean(), false) }),
  z.strictObject({ kind: z.literal('simulatorSource'), id: IdSchema, redacted: z._default(z.boolean(), false) }),
  z.strictObject({ kind: z.literal('pluginSurface'), id: IdSchema, redacted: z._default(z.boolean(), false) }),
]));
export type PeerMediationProductRefV1 = z.infer<typeof PeerMediationProductRefV1Schema>;

export const PeerMediationObservabilityFlowRefV1Schema = lazyZodSchema(() => z.strictObject({
    flowId: IdSchema,
    flowKind: PeerFlowKindV1Schema,
    routeKind: z.optional(PeerRouteKindV1Schema),
    tunnelId: z.optional(IdSchema),
    substreamId: z.optional(IdSchema),
    streamId: z.optional(IdSchema),
    routeGrantId: z.optional(IdSchema),
    productRef: z.optional(PeerMediationProductRefV1Schema),
  }).check(z.superRefine((flow, context) => {
    if (flow.flowKind === 'tcp_tunnel' && !flow.tunnelId) {
      context.addIssue({
        code: "custom",
        path: ['tunnelId'],
        message: 'TCP tunnel observability flows require tunnelId.',
      });
    }
    if (flow.flowKind === 'live_stream' && !flow.streamId) {
      context.addIssue({
        code: "custom",
        path: ['streamId'],
        message: 'Live stream observability flows require streamId.',
      });
    }
  })));
export type PeerMediationObservabilityFlowRefV1 = z.infer<
  typeof PeerMediationObservabilityFlowRefV1Schema
>;

export const PeerMediationObservabilityRedactionV1Schema = lazyZodSchema(() => z.strictObject({
    level: z.enum(['metadataOnly', 'valuesRedacted', 'redactedRef', 'unavailable']),
    queryRedacted: z._default(z.optional(z.boolean()), true),
    headersRedacted: z._default(z.optional(z.boolean()), true),
    truncated: z._default(z.optional(z.boolean()), false),
  }));
export type PeerMediationObservabilityRedactionV1 = z.infer<
  typeof PeerMediationObservabilityRedactionV1Schema
>;

const ObservabilityDataSchema = lazyZodSchema(() => z
  .record(z.string(), z.unknown()).check(z.superRefine(rejectUnsafePeerMediationObservabilityDataKeys)));

function refinePublicAndPluginFlowReferences(
  event: {
    scope: PeerMediationObservabilityScopeV1;
    flow: PeerMediationObservabilityFlowRefV1;
  },
  context: z.core.$RefinementCtx,
): void {
  if (event.scope.kind !== 'publicPreview' && event.scope.kind !== 'pluginSurface') return;

  if (event.flow.routeGrantId) {
    context.addIssue({
      code: "custom",
      path: ['flow', 'routeGrantId'],
      message: 'Public and plugin-scoped observability events must not expose route grant ids.',
    });
  }

  const productRef = event.flow.productRef;
  if (!productRef) return;

  if (event.scope.kind === 'publicPreview') {
    if (productRef.kind !== 'publicExposure' || productRef.id !== event.scope.publicExposureId) {
      context.addIssue({
        code: "custom",
        path: ['flow', 'productRef'],
        message: 'Public-preview observability events may only reference their scoped public exposure.',
      });
    }
    return;
  }

  if (productRef.kind !== 'pluginSurface' || productRef.id !== event.scope.surfaceId) {
    context.addIssue({
      code: "custom",
      path: ['flow', 'productRef'],
      message: 'Plugin-surface observability events may only reference their scoped plugin surface.',
    });
  }
}

export const PeerMediationObservabilityEventV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    eventId: IdSchema,
    sequence: z.number().check(z.int(), z.positive()),
    emittedAtMs: NonNegativeIntSchema,
    scope: PeerMediationObservabilityScopeV1Schema,
    flow: PeerMediationObservabilityFlowRefV1Schema,
    kind: PeerMediationObservabilityEventKindV1Schema,
    data: z._default(z.optional(ObservabilityDataSchema), {}),
    redaction: PeerMediationObservabilityRedactionV1Schema,
    deniedReason: z.optional(PeerMediationObservabilityDeniedReasonV1Schema),
  }).check(z.superRefine(refinePublicAndPluginFlowReferences)));
export type PeerMediationObservabilityEventV1 = z.infer<typeof PeerMediationObservabilityEventV1Schema>;

export const PeerMediationObservabilityLifecycleStateV1Schema = lazyZodSchema(() => z.enum([
  'starting',
  'ready',
  'active',
  'closed',
  'aborted',
  'errored',
  'denied',
]));
export type PeerMediationObservabilityLifecycleStateV1 = z.infer<
  typeof PeerMediationObservabilityLifecycleStateV1Schema
>;

export const PeerMediationObservabilityFlowSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
    flow: PeerMediationObservabilityFlowRefV1Schema,
    lifecycleState: PeerMediationObservabilityLifecycleStateV1Schema,
    startedAtMs: NonNegativeIntSchema,
    lastActivityAtMs: NonNegativeIntSchema,
    closedAtMs: z.optional(NonNegativeIntSchema),
    bytesIn: z._default(z.optional(NonNegativeIntSchema), 0),
    bytesOut: z._default(z.optional(NonNegativeIntSchema), 0),
    framesIn: z._default(z.optional(NonNegativeIntSchema), 0),
    framesOut: z._default(z.optional(NonNegativeIntSchema), 0),
    messagesIn: z._default(z.optional(NonNegativeIntSchema), 0),
    messagesOut: z._default(z.optional(NonNegativeIntSchema), 0),
    movingThroughputBps: z.optional(NonNegativeIntSchema),
    activeSubstreams: z._default(z.optional(NonNegativeIntSchema), 0),
    totalSubstreams: z.optional(NonNegativeIntSchema),
    capProfileId: z.optional(IdSchema),
    capUsagePercent: z.optional(z.number().check(z.minimum(0), z.maximum(100))),
    closeReasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    abortReasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    errorReasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    http: z.optional(ObservabilityDataSchema),
    websocket: z.optional(ObservabilityDataSchema),
  }));
export type PeerMediationObservabilityFlowSnapshotV1 = z.infer<
  typeof PeerMediationObservabilityFlowSnapshotV1Schema
>;

export const PeerMediationObservabilitySnapshotV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    scope: PeerMediationObservabilityScopeV1Schema,
    sequence: NonNegativeIntSchema,
    capturedAtMs: NonNegativeIntSchema,
    flows: z._default(z.optional(z.array(PeerMediationObservabilityFlowSnapshotV1Schema)), []),
  }));
export type PeerMediationObservabilitySnapshotV1 = z.infer<
  typeof PeerMediationObservabilitySnapshotV1Schema
>;

export const PeerMediationObservabilityDeltaV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    scope: PeerMediationObservabilityScopeV1Schema,
    sequence: z.number().check(z.int(), z.positive()),
    events: z._default(z.optional(z.array(PeerMediationObservabilityEventV1Schema)), []),
  }).check(z.superRefine((delta, context) => {
    delta.events.forEach((event, index) => {
      if (peerMediationObservabilityScopesEqual(delta.scope, event.scope)) return;
      context.addIssue({
        code: "custom",
        path: ['events', index, 'scope'],
        message: 'Peer mediation observability delta event scope must match delta scope.',
      });
    });
  })));
export type PeerMediationObservabilityDeltaV1 = z.infer<typeof PeerMediationObservabilityDeltaV1Schema>;

export const PeerMediationObservabilitySubscribeRequestV1Schema = lazyZodSchema(() => z.strictObject({
    scope: PeerMediationObservabilityScopeV1Schema,
  }));
export type PeerMediationObservabilitySubscribeRequestV1 = z.infer<
  typeof PeerMediationObservabilitySubscribeRequestV1Schema
>;

export const PeerMediationObservabilityUnsubscribeRequestV1Schema = lazyZodSchema(() => z.strictObject({
    scope: z.optional(PeerMediationObservabilityScopeV1Schema),
  }));
export type PeerMediationObservabilityUnsubscribeRequestV1 = z.infer<
  typeof PeerMediationObservabilityUnsubscribeRequestV1Schema
>;
