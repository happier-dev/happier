import { maxCodeUnits } from '../../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { ExternalSessionCompletedBoundaryV1Schema } from './followLifecycleV1.js';
import { LinkedExternalSessionQualifiedIdentityV1Schema } from './linkedSessionMetadata.js';

const ObservationTimestampMsSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)));
const ObservationExpiryMsSchema = ObservationTimestampMsSchema;

export const EXTERNAL_AGENT_OBSERVATION_METADATA_KEY = 'externalAgentObservationV1';

// These keys exist only inside one live Agent-generation lease. The 256-code-unit
// ceiling is large enough for opaque endpoint/auth-generation or file-generation
// correlation while keeping non-secret, plugin-supplied map keys bounded.
export const EXTERNAL_AGENT_OBSERVATION_KEY_MAX_CODE_UNITS_V1 = 256;
// Status demand already admits at most 256 current links. Observation batches use
// the same product-scale ceiling so one resource-wide event/reconciliation cannot
// amplify beyond the host's bounded current-link set.
export const EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1 = 256;
// Five bounded evidence classes across three axes require at most 15 concurrent
// claims. One additional same-batch transition/conflict fact lets the reducer
// preserve ambiguity rather than forcing the leaf to choose a winner.
export const EXTERNAL_AGENT_OBSERVATION_MAX_FACTS_PER_LINK_V1 = 16;
export const EXTERNAL_AGENT_OBSERVATION_MAX_WATCH_FILES_V1 = 32;

export const ExternalAgentObservationStatusV1Schema = lazyZodSchema(() => z.enum([
  'working',
  'waiting',
  'retrying',
  'idle',
  'recentlyActive',
  'unknown',
]));

export const ExternalAgentObservationAxisV1Schema = lazyZodSchema(() => z.enum([
  'liveness',
  'turn_phase',
  'boundary',
]));

export const ExternalAgentObservationEvidenceClassV1Schema = lazyZodSchema(() => z.enum([
  'agent_native',
  'file_watch',
  'qualified_hook',
  'process_probe',
  'reconciliation',
]));

const ExternalAgentObservationOpaqueKeyV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), maxCodeUnits(EXTERNAL_AGENT_OBSERVATION_KEY_MAX_CODE_UNITS_V1)));

export const ExternalAgentObservationResourceKeyV1Schema =
  ExternalAgentObservationOpaqueKeyV1Schema;
export const ExternalAgentObservationLinkKeyV1Schema =
  ExternalAgentObservationOpaqueKeyV1Schema;

export const ExternalAgentObservationResourceGroupingV1Schema = lazyZodSchema(() => z.strictObject({
  resourceKey: ExternalAgentObservationResourceKeyV1Schema,
  linkKey: ExternalAgentObservationLinkKeyV1Schema,
}));

export function isCanonicalAbsoluteObservationFilePath(value: string): boolean {
  if (
    value.length === 0
    || value !== value.trim()
    || value.length > 10_000
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  const isPosixAbsolute = value.startsWith('/');
  const isWindowsDriveAbsolute = /^[A-Za-z]:[\\/]/u.test(value);
  const isWindowsUncAbsolute = /^[/\\]{2}[^/\\]+[/\\][^/\\]+/u.test(value);
  if (!isPosixAbsolute && !isWindowsDriveAbsolute && !isWindowsUncAbsolute) {
    return false;
  }
  const segments = value.split(/[\\/]/u);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return false;
  }
  const isFilesystemRoot = value === '/'
    || /^[A-Za-z]:[\\/]$/u.test(value)
    || /^[/\\]{2}[^/\\]+[/\\][^/\\]+[/\\]?$/u.test(value);
  if (!isFilesystemRoot && /[\\/]$/u.test(value)) {
    return false;
  }
  return true;
}

export function isCanonicalAbsoluteObservationTopologyDirectoryPath(value: string): boolean {
  if (!isCanonicalAbsoluteObservationFilePath(value)) {
    return false;
  }
  return value !== '/'
    && !/^[A-Za-z]:[\\/]$/u.test(value)
    && !/^[/\\]{2}[^/\\]+[/\\][^/\\]+[/\\]?$/u.test(value);
}

export const ExternalAgentObservationWatchFileChangesV1Schema = lazyZodSchema(() => z.strictObject({
  files: z.array(
    z.string().check(z.refine(isCanonicalAbsoluteObservationFilePath, 'Observation file-watch paths must be canonical absolute paths.')),
  ).check(z.minLength(1), z.maxLength(EXTERNAL_AGENT_OBSERVATION_MAX_WATCH_FILES_V1)),
  topologyDirectories: z.optional(z.array(
    z.string().check(z.refine(isCanonicalAbsoluteObservationTopologyDirectoryPath, 'Observation topology directories must be canonical absolute non-root paths.')),
  ).check(z.minLength(1), z.maxLength(2))),
}).check(z.superRefine((value, ctx) => {
  const seenFiles = new Set<string>();
  value.files.forEach((file, index) => {
    if (seenFiles.has(file)) {
      ctx.addIssue({
        code: 'custom',
        path: ['files', index],
        message: 'Duplicate external-Agent observation file-watch path.',
      });
      return;
    }
    seenFiles.add(file);
  });
  const seenTopologyDirectories = new Set<string>();
  value.topologyDirectories?.forEach((directory, index) => {
    if (seenTopologyDirectories.has(directory)) {
      ctx.addIssue({
        code: 'custom',
        path: ['topologyDirectories', index],
        message: 'Duplicate external-Agent observation topology directory.',
      });
      return;
    }
    seenTopologyDirectories.add(directory);
  });
})));

const ExternalAgentObservationResourceDescriptorBaseV1Schema = lazyZodSchema(() => z.object({
  resourceKey: ExternalAgentObservationResourceKeyV1Schema,
  linkKey: ExternalAgentObservationLinkKeyV1Schema,
}));

export const ExternalAgentObservationResourceDescriptorV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('changeObservation', [
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationResourceDescriptorBaseV1Schema, {
      changeObservation: z.literal('observe_resource'),
    })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationResourceDescriptorBaseV1Schema, {
      changeObservation: z.literal('watch_file_changes'),
      watchFileChanges: ExternalAgentObservationWatchFileChangesV1Schema,
    })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationResourceDescriptorBaseV1Schema, {
      changeObservation: z.literal('reconcile_only'),
    })),
  ]));

const ExternalAgentObservationLeafFactBaseV1Schema = lazyZodSchema(() => z.object({
  evidenceClass: ExternalAgentObservationEvidenceClassV1Schema,
  observedAtMs: ObservationTimestampMsSchema,
}));

export const ExternalAgentObservationLeafFactV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationLeafFactBaseV1Schema, {
    kind: z.literal('liveness'),
    value: z.enum(['running', 'stopped']),
    expiresAtMs: ObservationExpiryMsSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationLeafFactBaseV1Schema, {
    kind: z.literal('turn_phase'),
    value: z.enum(['working', 'waiting', 'retrying', 'idle']),
    expiresAtMs: ObservationExpiryMsSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationLeafFactBaseV1Schema, {
    kind: z.literal('recent_activity'),
    expiresAtMs: ObservationExpiryMsSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationLeafFactBaseV1Schema, {
    kind: z.literal('completed_boundary'),
    boundaryId: z.string().check(z.trim(), z.minLength(1), z.maxLength(1_024)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationLeafFactBaseV1Schema, {
    kind: z.literal('successful_empty'),
    emptyTurnPhase: z.enum(['idle', 'unsupported']),
    expiresAtMs: ObservationExpiryMsSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationLeafFactBaseV1Schema, {
    kind: z.literal('retrieval_failed'),
    axis: ExternalAgentObservationAxisV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationLeafFactBaseV1Schema, {
    kind: z.literal('unsupported'),
    axis: ExternalAgentObservationAxisV1Schema,
  })),
]).check(z.superRefine((fact, ctx) => {
  if ('expiresAtMs' in fact && fact.expiresAtMs < fact.observedAtMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAtMs'],
      message: 'Observation expiry cannot precede its observation time.',
    });
  }
})));

export const ExternalAgentObservationLinkEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  linkKey: ExternalAgentObservationLinkKeyV1Schema,
  facts: z.array(ExternalAgentObservationLeafFactV1Schema).check(z.minLength(1), z.maxLength(EXTERNAL_AGENT_OBSERVATION_MAX_FACTS_PER_LINK_V1)),
}));

function rejectDuplicateObservationLinkKeys(
  value: Readonly<{
    items?: ReadonlyArray<Readonly<{ linkKey: string }>>;
    outcomes?: ReadonlyArray<
      | Readonly<{ linkKey: string }>
      | Readonly<{
        kind: 'described';
        descriptor: Readonly<{ linkKey: string }>;
      }>
    >;
    linkKeys?: ReadonlyArray<string>;
  }>,
  ctx: z.core.$RefinementCtx,
): void {
  const entries = value.items ?? value.outcomes ?? value.linkKeys ?? [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const linkKey = typeof entry === 'string'
      ? entry
      : 'descriptor' in entry
        ? entry.descriptor.linkKey
        : entry.linkKey;
    if (seen.has(linkKey)) {
      ctx.addIssue({
        code: 'custom',
        path: [value.linkKeys ? 'linkKeys' : value.items ? 'items' : 'outcomes', index],
        message: 'Duplicate external-Agent observation link key.',
      });
      return;
    }
    seen.add(linkKey);
  });
}

export const ExternalAgentObservationLinkEvidenceBatchV1Schema = lazyZodSchema(() => z.strictObject({
  // Empty observer callbacks carry no fact and are not an event.
  items: z.array(ExternalAgentObservationLinkEvidenceV1Schema).check(z.minLength(1), z.maxLength(EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1)),
}).check(z.superRefine(rejectDuplicateObservationLinkKeys)));

export const ExternalAgentObservationReconcilePurposeV1Schema = lazyZodSchema(() => z.enum([
  'observation_evidence',
  'resource_descriptors',
]));

const ExternalAgentObservationReconcileRequestBaseV1Schema = lazyZodSchema(() => z.object({
  // The host skips reconciliation when there are no current requested links.
  linkKeys: z.array(ExternalAgentObservationLinkKeyV1Schema).check(z.minLength(1), z.maxLength(EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1)),
}));

export const ExternalAgentObservationReconcileRequestV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('purpose', [
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationReconcileRequestBaseV1Schema, {
      purpose: z.literal('observation_evidence'),
    })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationReconcileRequestBaseV1Schema, {
      purpose: z.literal('resource_descriptors'),
    })),
  ]).check(z.superRefine(rejectDuplicateObservationLinkKeys)));

export const ExternalAgentObservationResourceDescriptorOutcomeV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('described'),
      descriptor: ExternalAgentObservationResourceDescriptorV1Schema,
    }),
    z.strictObject({
      kind: z.literal('unavailable'),
      linkKey: ExternalAgentObservationLinkKeyV1Schema,
    }),
  ]));

const ExternalAgentObservationEvidenceReconcileResultV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: z.literal('observation_evidence'),
  // Every returned link reports facts, successful-empty, or retrieval failure;
  // a resource-wide empty success is never an implicit outcome.
  outcomes: z.array(ExternalAgentObservationLinkEvidenceV1Schema).check(z.minLength(1), z.maxLength(EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1)),
}));

const ExternalAgentObservationDescriptorReconcileResultV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: z.literal('resource_descriptors'),
  outcomes: z.array(ExternalAgentObservationResourceDescriptorOutcomeV1Schema).check(z.minLength(1), z.maxLength(EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1)),
}));

export const ExternalAgentObservationReconcileResultV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('purpose', [
    ExternalAgentObservationEvidenceReconcileResultV1Schema,
    ExternalAgentObservationDescriptorReconcileResultV1Schema,
  ]).check(z.superRefine(rejectDuplicateObservationLinkKeys)));

export const ExternalAgentObservationTargetV1Schema = lazyZodSchema(() => z.strictObject({
  qualifiedLinkIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  linkGeneration: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
}));

const ExternalAgentObservationEvidenceBaseV1Schema = lazyZodSchema(() => z.object({
  target: ExternalAgentObservationTargetV1Schema,
  evidenceClass: z.optional(ExternalAgentObservationEvidenceClassV1Schema),
  observedAtMs: ObservationTimestampMsSchema,
}));

export const ExternalAgentObservationEvidenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationEvidenceBaseV1Schema, {
    kind: z.literal('liveness'),
    value: z.enum(['running', 'stopped']),
    evidenceClass: ExternalAgentObservationEvidenceClassV1Schema,
    expiresAtMs: ObservationExpiryMsSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationEvidenceBaseV1Schema, {
    kind: z.literal('process_liveness'),
    value: z.enum(['running', 'stopped']),
    processId: z.number().check(z.int(), z.positive()),
    processStartedAtMs: z.nullable(ObservationTimestampMsSchema),
    startTimeVerified: z.boolean(),
    expiresAtMs: ObservationExpiryMsSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationEvidenceBaseV1Schema, {
    kind: z.literal('turn_phase'),
    value: z.enum(['working', 'waiting', 'retrying', 'idle']),
    expiresAtMs: ObservationExpiryMsSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationEvidenceBaseV1Schema, {
    kind: z.literal('recent_activity'),
    expiresAtMs: ObservationExpiryMsSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationEvidenceBaseV1Schema, {
    kind: z.literal('completed_boundary'),
    boundaryId: z.string().check(z.trim(), z.minLength(1), z.maxLength(1_024)),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationEvidenceBaseV1Schema, {
    kind: z.literal('successful_empty'),
    emptyTurnPhase: z.enum(['idle', 'unsupported']),
    expiresAtMs: ObservationExpiryMsSchema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationEvidenceBaseV1Schema, {
    kind: z.literal('retrieval_failed'),
    axis: ExternalAgentObservationAxisV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationEvidenceBaseV1Schema, {
    kind: z.literal('unsupported'),
    axis: ExternalAgentObservationAxisV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalAgentObservationEvidenceBaseV1Schema, {
    kind: z.literal('lifecycle'),
    event: z.enum(['session_started', 'attached', 'stop']),
  })),
]).check(z.superRefine((evidence, ctx) => {
  if ('expiresAtMs' in evidence && evidence.expiresAtMs < evidence.observedAtMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAtMs'],
      message: 'Observation expiry cannot precede its observation time.',
    });
  }
  if (
    evidence.kind === 'process_liveness'
    && evidence.startTimeVerified
    && evidence.processStartedAtMs === null
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['processStartedAtMs'],
      message: 'Verified process identity requires its start time.',
    });
  }
})));

export function attachExternalAgentObservationTargetV1(
  target: ExternalAgentObservationTargetV1,
  facts: ReadonlyArray<ExternalAgentObservationLeafFactV1>,
): ExternalAgentObservationEvidenceV1[] {
  const parsedTarget = ExternalAgentObservationTargetV1Schema.parse(target);
  return facts.map((fact) => ExternalAgentObservationEvidenceV1Schema.parse({
    ...ExternalAgentObservationLeafFactV1Schema.parse(fact),
    target: parsedTarget,
  }));
}

export const ExternalAgentObservationSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  qualifiedLinkIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  linkGeneration: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  status: ExternalAgentObservationStatusV1Schema,
  observedAtMs: z.optional(ObservationTimestampMsSchema),
  expiresAtMs: z.optional(ObservationExpiryMsSchema),
  boundary: z.optional(ExternalSessionCompletedBoundaryV1Schema),
}).check(z.superRefine((snapshot, ctx) => {
  if (snapshot.status === 'unknown') {
    if (snapshot.observedAtMs !== undefined || snapshot.expiresAtMs !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: snapshot.observedAtMs !== undefined ? ['observedAtMs'] : ['expiresAtMs'],
        message: 'Unknown observations cannot carry turn-state freshness timestamps.',
      });
    }
    return;
  }
  if (snapshot.observedAtMs === undefined || snapshot.expiresAtMs === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: snapshot.observedAtMs === undefined ? ['observedAtMs'] : ['expiresAtMs'],
      message: 'Known observation states require observedAtMs and expiresAtMs.',
    });
  } else if (snapshot.expiresAtMs < snapshot.observedAtMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAtMs'],
      message: 'Snapshot expiry cannot precede its observation time.',
    });
  }
})));

export type ExternalAgentObservationStatusV1 = z.infer<
  typeof ExternalAgentObservationStatusV1Schema
>;
export type ExternalAgentObservationAxisV1 = z.infer<
  typeof ExternalAgentObservationAxisV1Schema
>;
export type ExternalAgentObservationEvidenceClassV1 = z.infer<
  typeof ExternalAgentObservationEvidenceClassV1Schema
>;
export type ExternalAgentObservationResourceKeyV1 = z.infer<
  typeof ExternalAgentObservationResourceKeyV1Schema
>;
export type ExternalAgentObservationResourceGroupingV1 = z.infer<
  typeof ExternalAgentObservationResourceGroupingV1Schema
>;
export type ExternalAgentObservationLinkKeyV1 = z.infer<
  typeof ExternalAgentObservationLinkKeyV1Schema
>;
export type ExternalAgentObservationWatchFileChangesV1 = z.infer<
  typeof ExternalAgentObservationWatchFileChangesV1Schema
>;
export type ExternalAgentObservationResourceDescriptorV1 = z.infer<
  typeof ExternalAgentObservationResourceDescriptorV1Schema
>;
export type ExternalAgentObservationLeafFactV1 = z.infer<
  typeof ExternalAgentObservationLeafFactV1Schema
>;
export type ExternalAgentObservationLinkEvidenceV1 = z.infer<
  typeof ExternalAgentObservationLinkEvidenceV1Schema
>;
export type ExternalAgentObservationLinkEvidenceBatchV1 = z.infer<
  typeof ExternalAgentObservationLinkEvidenceBatchV1Schema
>;
export type ExternalAgentObservationReconcilePurposeV1 = z.infer<
  typeof ExternalAgentObservationReconcilePurposeV1Schema
>;
export type ExternalAgentObservationReconcileRequestV1 = z.infer<
  typeof ExternalAgentObservationReconcileRequestV1Schema
>;
export type ExternalAgentObservationResourceDescriptorOutcomeV1 = z.infer<
  typeof ExternalAgentObservationResourceDescriptorOutcomeV1Schema
>;
export type ExternalAgentObservationReconcileResultV1 = z.infer<
  typeof ExternalAgentObservationReconcileResultV1Schema
>;
export type ExternalAgentObservationTargetV1 = z.infer<
  typeof ExternalAgentObservationTargetV1Schema
>;
export type ExternalAgentObservationEvidenceV1 = z.infer<
  typeof ExternalAgentObservationEvidenceV1Schema
>;
export type ExternalAgentObservationSnapshotV1 = z.infer<
  typeof ExternalAgentObservationSnapshotV1Schema
>;
