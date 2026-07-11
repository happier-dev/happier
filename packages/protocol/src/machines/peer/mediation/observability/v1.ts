import { z } from 'zod';

import { PeerFlowKindV1Schema } from '../flowKind.js';
import { PeerRouteKindV1Schema } from '../routeKind.js';
import { rejectUnsafePeerMediationObservabilityDataKeys } from './redaction.js';

export const PEER_MEDIATION_OBSERVABILITY_SNAPSHOT_SOCKET_EVENT = 'peer:observability:snapshot:v1' as const;
export const PEER_MEDIATION_OBSERVABILITY_DELTA_SOCKET_EVENT = 'peer:observability:delta:v1' as const;
export const PEER_MEDIATION_OBSERVABILITY_SUBSCRIBE_SOCKET_EVENT = 'peer:observability:subscribe:v1' as const;
export const PEER_MEDIATION_OBSERVABILITY_UNSUBSCRIBE_SOCKET_EVENT = 'peer:observability:unsubscribe:v1' as const;

const IdSchema = z.string().trim().min(1).max(256);
const NonNegativeIntSchema = z.number().int().nonnegative();

export const PeerMediationObservabilityEventKindV1Schema = z.enum([
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
]);
export type PeerMediationObservabilityEventKindV1 = z.infer<
  typeof PeerMediationObservabilityEventKindV1Schema
>;

export const PeerMediationObservabilityDeniedReasonV1Schema = z.enum([
  'observability_unavailable',
  'feature_disabled',
  'scope_unauthorized',
  'machine_unauthorized',
  'session_unauthorized',
  'preview_scope_mismatch',
  'plugin_scope_mismatch',
  'public_scope_limited',
  'policy_denied',
]);
export type PeerMediationObservabilityDeniedReasonV1 = z.infer<
  typeof PeerMediationObservabilityDeniedReasonV1Schema
>;

export const PeerMediationObservabilityScopeV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('account'),
      accountId: IdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('machine'),
      accountId: IdSchema,
      machineId: IdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('session'),
      accountId: IdSchema,
      sessionId: IdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('publicPreview'),
      publicExposureId: IdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('pluginSurface'),
      accountId: IdSchema,
      pluginId: IdSchema,
      surfaceId: IdSchema,
    })
    .strict(),
]);
export type PeerMediationObservabilityScopeV1 = z.infer<typeof PeerMediationObservabilityScopeV1Schema>;

export const PeerMediationProductRefV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preview'), id: IdSchema, redacted: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('publicExposure'), id: IdSchema, redacted: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('browserView'), id: IdSchema, redacted: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('simulatorSource'), id: IdSchema, redacted: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('pluginSurface'), id: IdSchema, redacted: z.boolean().default(false) }).strict(),
]);
export type PeerMediationProductRefV1 = z.infer<typeof PeerMediationProductRefV1Schema>;

export const PeerMediationObservabilityFlowRefV1Schema = z
  .object({
    flowId: IdSchema,
    flowKind: PeerFlowKindV1Schema,
    routeKind: PeerRouteKindV1Schema.optional(),
    tunnelId: IdSchema.optional(),
    substreamId: IdSchema.optional(),
    streamId: IdSchema.optional(),
    routeGrantId: IdSchema.optional(),
    productRef: PeerMediationProductRefV1Schema.optional(),
  })
  .strict()
  .superRefine((flow, context) => {
    if (flow.flowKind === 'tcp_tunnel' && !flow.tunnelId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tunnelId'],
        message: 'TCP tunnel observability flows require tunnelId.',
      });
    }
    if (flow.flowKind === 'live_stream' && !flow.streamId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['streamId'],
        message: 'Live stream observability flows require streamId.',
      });
    }
  });
export type PeerMediationObservabilityFlowRefV1 = z.infer<
  typeof PeerMediationObservabilityFlowRefV1Schema
>;

export const PeerMediationObservabilityRedactionV1Schema = z
  .object({
    level: z.enum(['metadataOnly', 'valuesRedacted', 'redactedRef', 'unavailable']),
    queryRedacted: z.boolean().optional().default(true),
    headersRedacted: z.boolean().optional().default(true),
    truncated: z.boolean().optional().default(false),
  })
  .strict();
export type PeerMediationObservabilityRedactionV1 = z.infer<
  typeof PeerMediationObservabilityRedactionV1Schema
>;

const ObservabilityDataSchema = z
  .record(z.string(), z.unknown())
  .superRefine(rejectUnsafePeerMediationObservabilityDataKeys);

function observabilityScopesMatch(
  left: PeerMediationObservabilityScopeV1,
  right: PeerMediationObservabilityScopeV1,
): boolean {
  if (left.kind === 'account' && right.kind === 'account') {
    return left.accountId === right.accountId;
  }
  if (left.kind === 'machine' && right.kind === 'machine') {
    return left.accountId === right.accountId && left.machineId === right.machineId;
  }
  if (left.kind === 'session' && right.kind === 'session') {
    return left.accountId === right.accountId && left.sessionId === right.sessionId;
  }
  if (left.kind === 'publicPreview' && right.kind === 'publicPreview') {
    return left.publicExposureId === right.publicExposureId;
  }
  if (left.kind === 'pluginSurface' && right.kind === 'pluginSurface') {
    return (
      left.accountId === right.accountId
      && left.pluginId === right.pluginId
      && left.surfaceId === right.surfaceId
    );
  }
  return false;
}

function refinePublicAndPluginFlowReferences(
  event: {
    scope: PeerMediationObservabilityScopeV1;
    flow: PeerMediationObservabilityFlowRefV1;
  },
  context: z.RefinementCtx,
): void {
  if (event.scope.kind !== 'publicPreview' && event.scope.kind !== 'pluginSurface') return;

  if (event.flow.routeGrantId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['flow', 'routeGrantId'],
      message: 'Public and plugin-scoped observability events must not expose route grant ids.',
    });
  }

  const productRef = event.flow.productRef;
  if (!productRef) return;

  if (event.scope.kind === 'publicPreview') {
    if (productRef.kind !== 'publicExposure' || productRef.id !== event.scope.publicExposureId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flow', 'productRef'],
        message: 'Public-preview observability events may only reference their scoped public exposure.',
      });
    }
    return;
  }

  if (productRef.kind !== 'pluginSurface' || productRef.id !== event.scope.surfaceId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['flow', 'productRef'],
      message: 'Plugin-surface observability events may only reference their scoped plugin surface.',
    });
  }
}

export const PeerMediationObservabilityEventV1Schema = z
  .object({
    v: z.literal(1),
    eventId: IdSchema,
    sequence: z.number().int().positive(),
    emittedAtMs: NonNegativeIntSchema,
    scope: PeerMediationObservabilityScopeV1Schema,
    flow: PeerMediationObservabilityFlowRefV1Schema,
    kind: PeerMediationObservabilityEventKindV1Schema,
    data: ObservabilityDataSchema.optional().default({}),
    redaction: PeerMediationObservabilityRedactionV1Schema,
    deniedReason: PeerMediationObservabilityDeniedReasonV1Schema.optional(),
  })
  .strict()
  .superRefine(refinePublicAndPluginFlowReferences);
export type PeerMediationObservabilityEventV1 = z.infer<typeof PeerMediationObservabilityEventV1Schema>;

export const PeerMediationObservabilityLifecycleStateV1Schema = z.enum([
  'starting',
  'ready',
  'active',
  'closed',
  'aborted',
  'errored',
  'denied',
]);
export type PeerMediationObservabilityLifecycleStateV1 = z.infer<
  typeof PeerMediationObservabilityLifecycleStateV1Schema
>;

export const PeerMediationObservabilityFlowSnapshotV1Schema = z
  .object({
    flow: PeerMediationObservabilityFlowRefV1Schema,
    lifecycleState: PeerMediationObservabilityLifecycleStateV1Schema,
    startedAtMs: NonNegativeIntSchema,
    lastActivityAtMs: NonNegativeIntSchema,
    closedAtMs: NonNegativeIntSchema.optional(),
    bytesIn: NonNegativeIntSchema.optional().default(0),
    bytesOut: NonNegativeIntSchema.optional().default(0),
    framesIn: NonNegativeIntSchema.optional().default(0),
    framesOut: NonNegativeIntSchema.optional().default(0),
    messagesIn: NonNegativeIntSchema.optional().default(0),
    messagesOut: NonNegativeIntSchema.optional().default(0),
    movingThroughputBps: NonNegativeIntSchema.optional(),
    activeSubstreams: NonNegativeIntSchema.optional().default(0),
    totalSubstreams: NonNegativeIntSchema.optional(),
    capProfileId: IdSchema.optional(),
    capUsagePercent: z.number().min(0).max(100).optional(),
    closeReasonCode: z.string().trim().min(1).max(128).optional(),
    abortReasonCode: z.string().trim().min(1).max(128).optional(),
    errorReasonCode: z.string().trim().min(1).max(128).optional(),
    http: ObservabilityDataSchema.optional(),
    websocket: ObservabilityDataSchema.optional(),
  })
  .strict();
export type PeerMediationObservabilityFlowSnapshotV1 = z.infer<
  typeof PeerMediationObservabilityFlowSnapshotV1Schema
>;

export const PeerMediationObservabilitySnapshotV1Schema = z
  .object({
    v: z.literal(1),
    scope: PeerMediationObservabilityScopeV1Schema,
    sequence: NonNegativeIntSchema,
    capturedAtMs: NonNegativeIntSchema,
    flows: z.array(PeerMediationObservabilityFlowSnapshotV1Schema).optional().default([]),
  })
  .strict();
export type PeerMediationObservabilitySnapshotV1 = z.infer<
  typeof PeerMediationObservabilitySnapshotV1Schema
>;

export const PeerMediationObservabilityDeltaV1Schema = z
  .object({
    v: z.literal(1),
    scope: PeerMediationObservabilityScopeV1Schema,
    sequence: z.number().int().positive(),
    events: z.array(PeerMediationObservabilityEventV1Schema).optional().default([]),
  })
  .strict()
  .superRefine((delta, context) => {
    delta.events.forEach((event, index) => {
      if (observabilityScopesMatch(delta.scope, event.scope)) return;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['events', index, 'scope'],
        message: 'Peer mediation observability delta event scope must match delta scope.',
      });
    });
  });
export type PeerMediationObservabilityDeltaV1 = z.infer<typeof PeerMediationObservabilityDeltaV1Schema>;

export const PeerMediationObservabilitySubscribeRequestV1Schema = z
  .object({
    scope: PeerMediationObservabilityScopeV1Schema,
  })
  .strict();
export type PeerMediationObservabilitySubscribeRequestV1 = z.infer<
  typeof PeerMediationObservabilitySubscribeRequestV1Schema
>;

export const PeerMediationObservabilityUnsubscribeRequestV1Schema = z
  .object({
    scope: PeerMediationObservabilityScopeV1Schema.optional(),
  })
  .strict();
export type PeerMediationObservabilityUnsubscribeRequestV1 = z.infer<
  typeof PeerMediationObservabilityUnsubscribeRequestV1Schema
>;
