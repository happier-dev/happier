import { z } from 'zod';

import { ExternalSessionCompletedBoundaryV1Schema } from './followLifecycleV1.js';
import { LinkedExternalSessionQualifiedIdentityV1Schema } from './linkedSessionMetadata.js';

const ObservationTimestampMsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
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

export const ExternalAgentObservationStatusV1Schema = z.enum([
  'working',
  'waiting',
  'retrying',
  'idle',
  'recentlyActive',
  'unknown',
]);

export const ExternalAgentObservationAxisV1Schema = z.enum([
  'liveness',
  'turn_phase',
  'boundary',
]);

export const ExternalAgentObservationEvidenceClassV1Schema = z.enum([
  'agent_native',
  'file_watch',
  'qualified_hook',
  'process_probe',
  'reconciliation',
]);

const ExternalAgentObservationOpaqueKeyV1Schema = z.string()
  .trim()
  .min(1)
  .max(EXTERNAL_AGENT_OBSERVATION_KEY_MAX_CODE_UNITS_V1);

export const ExternalAgentObservationResourceKeyV1Schema =
  ExternalAgentObservationOpaqueKeyV1Schema;
export const ExternalAgentObservationLinkKeyV1Schema =
  ExternalAgentObservationOpaqueKeyV1Schema;

export const ExternalAgentObservationResourceGroupingV1Schema = z.object({
  resourceKey: ExternalAgentObservationResourceKeyV1Schema,
  linkKey: ExternalAgentObservationLinkKeyV1Schema,
}).strict();

function isCanonicalAbsoluteObservationFilePath(value: string): boolean {
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

function isCanonicalAbsoluteObservationTopologyDirectoryPath(value: string): boolean {
  if (!isCanonicalAbsoluteObservationFilePath(value)) {
    return false;
  }
  return value !== '/'
    && !/^[A-Za-z]:[\\/]$/u.test(value)
    && !/^[/\\]{2}[^/\\]+[/\\][^/\\]+[/\\]?$/u.test(value);
}

export const ExternalAgentObservationWatchFileChangesV1Schema = z.object({
  files: z.array(
    z.string().refine(
      isCanonicalAbsoluteObservationFilePath,
      'Observation file-watch paths must be canonical absolute paths.',
    ),
  )
    .min(1)
    .max(EXTERNAL_AGENT_OBSERVATION_MAX_WATCH_FILES_V1),
  topologyDirectories: z.array(
    z.string().refine(
      isCanonicalAbsoluteObservationTopologyDirectoryPath,
      'Observation topology directories must be canonical absolute non-root paths.',
    ),
  )
    .min(1)
    .max(2)
    .optional(),
}).strict().superRefine((value, ctx) => {
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
});

const ExternalAgentObservationResourceDescriptorBaseV1Schema = z.object({
  resourceKey: ExternalAgentObservationResourceKeyV1Schema,
  linkKey: ExternalAgentObservationLinkKeyV1Schema,
});

export const ExternalAgentObservationResourceDescriptorV1Schema =
  z.discriminatedUnion('changeObservation', [
    ExternalAgentObservationResourceDescriptorBaseV1Schema.extend({
      changeObservation: z.literal('observe_resource'),
    }).strict(),
    ExternalAgentObservationResourceDescriptorBaseV1Schema.extend({
      changeObservation: z.literal('watch_file_changes'),
      watchFileChanges: ExternalAgentObservationWatchFileChangesV1Schema,
    }).strict(),
    ExternalAgentObservationResourceDescriptorBaseV1Schema.extend({
      changeObservation: z.literal('reconcile_only'),
    }).strict(),
  ]);

const ExternalAgentObservationLeafFactBaseV1Schema = z.object({
  evidenceClass: ExternalAgentObservationEvidenceClassV1Schema,
  observedAtMs: ObservationTimestampMsSchema,
});

export const ExternalAgentObservationLeafFactV1Schema = z.discriminatedUnion('kind', [
  ExternalAgentObservationLeafFactBaseV1Schema.extend({
    kind: z.literal('liveness'),
    value: z.enum(['running', 'stopped']),
    expiresAtMs: ObservationExpiryMsSchema,
  }).strict(),
  ExternalAgentObservationLeafFactBaseV1Schema.extend({
    kind: z.literal('turn_phase'),
    value: z.enum(['working', 'waiting', 'retrying', 'idle']),
    expiresAtMs: ObservationExpiryMsSchema,
  }).strict(),
  ExternalAgentObservationLeafFactBaseV1Schema.extend({
    kind: z.literal('recent_activity'),
    expiresAtMs: ObservationExpiryMsSchema,
  }).strict(),
  ExternalAgentObservationLeafFactBaseV1Schema.extend({
    kind: z.literal('completed_boundary'),
    boundaryId: z.string().trim().min(1).max(1_024),
  }).strict(),
  ExternalAgentObservationLeafFactBaseV1Schema.extend({
    kind: z.literal('successful_empty'),
    emptyTurnPhase: z.enum(['idle', 'unsupported']),
    expiresAtMs: ObservationExpiryMsSchema,
  }).strict(),
  ExternalAgentObservationLeafFactBaseV1Schema.extend({
    kind: z.literal('retrieval_failed'),
    axis: ExternalAgentObservationAxisV1Schema,
  }).strict(),
  ExternalAgentObservationLeafFactBaseV1Schema.extend({
    kind: z.literal('unsupported'),
    axis: ExternalAgentObservationAxisV1Schema,
  }).strict(),
]).superRefine((fact, ctx) => {
  if ('expiresAtMs' in fact && fact.expiresAtMs < fact.observedAtMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAtMs'],
      message: 'Observation expiry cannot precede its observation time.',
    });
  }
});

export const ExternalAgentObservationLinkEvidenceV1Schema = z.object({
  linkKey: ExternalAgentObservationLinkKeyV1Schema,
  facts: z.array(ExternalAgentObservationLeafFactV1Schema)
    .min(1)
    .max(EXTERNAL_AGENT_OBSERVATION_MAX_FACTS_PER_LINK_V1),
}).strict();

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
  ctx: z.RefinementCtx,
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

export const ExternalAgentObservationLinkEvidenceBatchV1Schema = z.object({
  // Empty observer callbacks carry no fact and are not an event.
  items: z.array(ExternalAgentObservationLinkEvidenceV1Schema)
    .min(1)
    .max(EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1),
}).strict().superRefine(rejectDuplicateObservationLinkKeys);

export const ExternalAgentObservationReconcilePurposeV1Schema = z.enum([
  'observation_evidence',
  'resource_descriptors',
]);

const ExternalAgentObservationReconcileRequestBaseV1Schema = z.object({
  // The host skips reconciliation when there are no current requested links.
  linkKeys: z.array(ExternalAgentObservationLinkKeyV1Schema)
    .min(1)
    .max(EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1),
});

export const ExternalAgentObservationReconcileRequestV1Schema =
  z.discriminatedUnion('purpose', [
    ExternalAgentObservationReconcileRequestBaseV1Schema.extend({
      purpose: z.literal('observation_evidence'),
    }).strict(),
    ExternalAgentObservationReconcileRequestBaseV1Schema.extend({
      purpose: z.literal('resource_descriptors'),
    }).strict(),
  ]).superRefine(rejectDuplicateObservationLinkKeys);

export const ExternalAgentObservationResourceDescriptorOutcomeV1Schema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('described'),
      descriptor: ExternalAgentObservationResourceDescriptorV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('unavailable'),
      linkKey: ExternalAgentObservationLinkKeyV1Schema,
    }).strict(),
  ]);

const ExternalAgentObservationEvidenceReconcileResultV1Schema = z.object({
  purpose: z.literal('observation_evidence'),
  // Every returned link reports facts, successful-empty, or retrieval failure;
  // a resource-wide empty success is never an implicit outcome.
  outcomes: z.array(ExternalAgentObservationLinkEvidenceV1Schema)
    .min(1)
    .max(EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1),
}).strict();

const ExternalAgentObservationDescriptorReconcileResultV1Schema = z.object({
  purpose: z.literal('resource_descriptors'),
  outcomes: z.array(ExternalAgentObservationResourceDescriptorOutcomeV1Schema)
    .min(1)
    .max(EXTERNAL_AGENT_OBSERVATION_MAX_LINKS_PER_BATCH_V1),
}).strict();

export const ExternalAgentObservationReconcileResultV1Schema =
  z.discriminatedUnion('purpose', [
    ExternalAgentObservationEvidenceReconcileResultV1Schema,
    ExternalAgentObservationDescriptorReconcileResultV1Schema,
  ]).superRefine(rejectDuplicateObservationLinkKeys);

export const ExternalAgentObservationTargetV1Schema = z.object({
  qualifiedLinkIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  linkGeneration: z.string().trim().min(1).max(2_000),
}).strict();

const ExternalAgentObservationEvidenceBaseV1Schema = z.object({
  target: ExternalAgentObservationTargetV1Schema,
  evidenceClass: ExternalAgentObservationEvidenceClassV1Schema.optional(),
  observedAtMs: ObservationTimestampMsSchema,
});

export const ExternalAgentObservationEvidenceV1Schema = z.discriminatedUnion('kind', [
  ExternalAgentObservationEvidenceBaseV1Schema.extend({
    kind: z.literal('liveness'),
    value: z.enum(['running', 'stopped']),
    evidenceClass: ExternalAgentObservationEvidenceClassV1Schema,
    expiresAtMs: ObservationExpiryMsSchema,
  }).strict(),
  ExternalAgentObservationEvidenceBaseV1Schema.extend({
    kind: z.literal('process_liveness'),
    value: z.enum(['running', 'stopped']),
    processId: z.number().int().positive(),
    processStartedAtMs: ObservationTimestampMsSchema.nullable(),
    startTimeVerified: z.boolean(),
    expiresAtMs: ObservationExpiryMsSchema,
  }).strict(),
  ExternalAgentObservationEvidenceBaseV1Schema.extend({
    kind: z.literal('turn_phase'),
    value: z.enum(['working', 'waiting', 'retrying', 'idle']),
    expiresAtMs: ObservationExpiryMsSchema,
  }).strict(),
  ExternalAgentObservationEvidenceBaseV1Schema.extend({
    kind: z.literal('recent_activity'),
    expiresAtMs: ObservationExpiryMsSchema,
  }).strict(),
  ExternalAgentObservationEvidenceBaseV1Schema.extend({
    kind: z.literal('completed_boundary'),
    boundaryId: z.string().trim().min(1).max(1_024),
  }).strict(),
  ExternalAgentObservationEvidenceBaseV1Schema.extend({
    kind: z.literal('successful_empty'),
    emptyTurnPhase: z.enum(['idle', 'unsupported']),
    expiresAtMs: ObservationExpiryMsSchema,
  }).strict(),
  ExternalAgentObservationEvidenceBaseV1Schema.extend({
    kind: z.literal('retrieval_failed'),
    axis: ExternalAgentObservationAxisV1Schema,
  }).strict(),
  ExternalAgentObservationEvidenceBaseV1Schema.extend({
    kind: z.literal('unsupported'),
    axis: ExternalAgentObservationAxisV1Schema,
  }).strict(),
  ExternalAgentObservationEvidenceBaseV1Schema.extend({
    kind: z.literal('lifecycle'),
    event: z.enum(['session_started', 'attached', 'stop']),
  }).strict(),
]).superRefine((evidence, ctx) => {
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
});

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

export const ExternalAgentObservationSnapshotV1Schema = z.object({
  v: z.literal(1),
  qualifiedLinkIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  linkGeneration: z.string().trim().min(1).max(2_000),
  status: ExternalAgentObservationStatusV1Schema,
  observedAtMs: ObservationTimestampMsSchema.optional(),
  expiresAtMs: ObservationExpiryMsSchema.optional(),
  boundary: ExternalSessionCompletedBoundaryV1Schema.optional(),
}).strict().superRefine((snapshot, ctx) => {
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
});

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
