import { z } from 'zod';

import {
  isAccountScopedBlobCiphertextForKind,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../../crypto/accountScopedCipher.js';
import {
  StoredJsonContentEnvelopeSchema,
  type StoredJsonContentEnvelope,
} from '../../storage/storedJsonContentEnvelope.js';
import {
  ReviewCommentActorRefV1Schema,
  ReviewCommentAnchorV1Schema,
  ReviewCommentBodyContentV1Schema,
  ReviewCommentDispositionV1Schema,
  ReviewCommentEditV1Schema,
  ReviewCommentEvidenceV1Schema,
  ReviewCommentEventV1Schema,
  ReviewCommentEventKindV1Schema,
  ReviewCommentFingerprintV1Schema,
  ReviewCommentLinkedRefV1Schema,
  ReviewCommentMetadataV1Schema,
  ReviewCommentSnapshotContentV1Schema,
  ReviewCommentSnapshotV1Schema,
  ReviewCommentStateV1Schema,
  ReviewCommentSuggestedFixV1Schema,
  ReviewCommentTombstoneV1Schema,
  ReviewCommentTransitionV1Schema,
  ReviewCommentV1Schema,
  type ReviewCommentEventV1,
  type ReviewCommentV1,
} from './v1.js';

const ReviewCommentAnchorKindV1Schema = z.enum([
  'line',
  'range',
  'hunk',
  'file',
  'folder',
  'workspace',
  'project',
  'run',
  'finding',
  'binary',
  'submodule',
  'symlink',
]);

export const ReviewCommentAnchorIndexV1Schema = z.object({
  kind: ReviewCommentAnchorKindV1Schema,
  filePath: z.string().min(1).optional(),
  folderPath: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  const filePathKinds = new Set([
    'line',
    'range',
    'hunk',
    'file',
    'binary',
    'submodule',
    'symlink',
  ]);
  if (filePathKinds.has(value.kind) && !value.filePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['filePath'],
      message: `${value.kind} anchors require a filePath index`,
    });
  }
  if (value.kind === 'folder' && !value.folderPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['folderPath'],
      message: 'folder anchors require a folderPath index',
    });
  }
});
export type ReviewCommentAnchorIndexV1 = z.infer<typeof ReviewCommentAnchorIndexV1Schema>;

const ReviewCommentStructuralEditV1Schema = ReviewCommentEditV1Schema.pick({
  editId: true,
  editedAt: true,
  editedBy: true,
});

const ReviewCommentStructuralTransitionV1Schema = ReviewCommentTransitionV1Schema.omit({
  reason: true,
  evidence: true,
});

const ReviewCommentStructuralTombstoneV1Schema = ReviewCommentTombstoneV1Schema.omit({
  reason: true,
});

export const ReviewCommentStructuralV1Schema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  accountId: z.string().min(1),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  engineId: z.string().min(1).optional(),
  findingId: z.string().min(1).optional(),
  anchorIndex: ReviewCommentAnchorIndexV1Schema,
  bodyVersion: z.number().int().positive(),
  editHistory: z.array(ReviewCommentStructuralEditV1Schema),
  author: ReviewCommentActorRefV1Schema,
  state: ReviewCommentStateV1Schema,
  flags: z.object({
    stale: z.boolean().optional(),
    outdated: z.boolean().optional(),
    muted: z.boolean().optional(),
    redacted: z.boolean().optional(),
  }).strict(),
  dispositions: z.record(z.string().min(1), ReviewCommentDispositionV1Schema),
  parentCommentId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  transitionHistory: z.array(ReviewCommentStructuralTransitionV1Schema),
  tombstone: ReviewCommentStructuralTombstoneV1Schema.optional(),
  fingerprintIndex: z.object({
    normalizedMessageHash: z.string().min(1),
  }).strict().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  serverRevision: z.number().int().positive(),
}).strict();
export type ReviewCommentStructuralV1 = z.infer<typeof ReviewCommentStructuralV1Schema>;

export const ReviewCommentSensitiveContentV1Schema = z.object({
  anchor: ReviewCommentAnchorV1Schema,
  snapshot: ReviewCommentSnapshotV1Schema,
  body: z.string(),
  edits: z.array(ReviewCommentEditV1Schema.extend({
    previousBody: z.string(),
    nextBody: z.string().min(1),
  }).strict()),
  evidence: z.array(ReviewCommentEvidenceV1Schema).optional(),
  transitions: z.array(ReviewCommentTransitionV1Schema),
  tombstone: ReviewCommentTombstoneV1Schema.optional(),
  fingerprint: ReviewCommentFingerprintV1Schema.optional(),
  linkedRefs: z.array(ReviewCommentLinkedRefV1Schema).optional(),
  suggestedFix: ReviewCommentSuggestedFixV1Schema.optional(),
  metadata: ReviewCommentMetadataV1Schema.optional(),
}).strict();
export type ReviewCommentSensitiveContentV1 = z.infer<typeof ReviewCommentSensitiveContentV1Schema>;

export const ReviewCommentLegacySplitSensitiveSourceV1Schema = z.object({
  v: z.literal(1),
  layout: z.literal('legacy_split_v1'),
  sourceMode: z.enum(['plain', 'e2ee']),
  anchor: ReviewCommentAnchorV1Schema,
  snapshotEnvelope: StoredJsonContentEnvelopeSchema,
  bodyEnvelope: StoredJsonContentEnvelopeSchema,
  edits: z.array(ReviewCommentEditV1Schema),
  evidence: z.array(ReviewCommentEvidenceV1Schema).optional(),
  transitions: z.array(ReviewCommentTransitionV1Schema),
  tombstone: ReviewCommentTombstoneV1Schema.optional(),
  fingerprint: ReviewCommentFingerprintV1Schema.optional(),
  linkedRefs: z.array(ReviewCommentLinkedRefV1Schema).optional(),
  suggestedFix: ReviewCommentSuggestedFixV1Schema.optional(),
  metadata: ReviewCommentMetadataV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  const expectedKind = value.sourceMode === 'e2ee' ? 'encrypted' : 'plain';
  if (value.snapshotEnvelope.t !== expectedKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['snapshotEnvelope'],
      message: 'Legacy Review Comment snapshot source must match source mode',
    });
  }
  if (value.bodyEnvelope.t !== expectedKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bodyEnvelope'],
      message: 'Legacy Review Comment body source must match source mode',
    });
  }
  value.edits.forEach((edit, editIndex) => {
    (['previousBody', 'nextBody'] as const).forEach((field) => {
      const body = edit[field];
      const envelope = StoredJsonContentEnvelopeSchema.safeParse(body);
      const matches = value.sourceMode === 'plain'
        ? typeof body === 'string'
          || (envelope.success && envelope.data.t === 'plain')
        : envelope.success && envelope.data.t === 'encrypted';
      if (!matches) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edits', editIndex, field],
          message: `Legacy Review Comment ${field} source must match source mode`,
        });
      }
    });
  });
});
export type ReviewCommentLegacySplitSensitiveSourceV1 = z.infer<
  typeof ReviewCommentLegacySplitSensitiveSourceV1Schema
>;

export const ReviewCommentSensitiveMigrationSourceV1Schema = z.union([
  z.object({
    v: z.literal(1),
    layout: z.literal('canonical_v1'),
    envelope: StoredJsonContentEnvelopeSchema,
  }).strict(),
  ReviewCommentLegacySplitSensitiveSourceV1Schema,
]);
export type ReviewCommentSensitiveMigrationSourceV1 = z.infer<
  typeof ReviewCommentSensitiveMigrationSourceV1Schema
>;

export const ReviewCommentSensitiveBindingV1Schema = z.object({
  v: z.literal(1),
  accountId: z.string().min(1),
  projectId: z.string().min(1),
  commentId: z.string().min(1),
  serverRevision: z.number().int().positive(),
  bodyVersion: z.number().int().positive(),
}).strict();
export type ReviewCommentSensitiveBindingV1 = z.infer<typeof ReviewCommentSensitiveBindingV1Schema>;

export const ReviewCommentSensitivePayloadV1Schema = z.object({
  v: z.literal(1),
  binding: ReviewCommentSensitiveBindingV1Schema,
  content: ReviewCommentSensitiveContentV1Schema,
}).strict();
export type ReviewCommentSensitivePayloadV1 = z.infer<typeof ReviewCommentSensitivePayloadV1Schema>;

export type ReviewCommentSplitV1 = Readonly<{
  structural: ReviewCommentStructuralV1;
  sensitive: ReviewCommentSensitiveContentV1;
}>;

export type ReviewCommentOpenResultV1 =
  | Readonly<{ status: 'available'; comment: ReviewCommentV1 }>
  | Readonly<{
      status: 'locked';
      reason:
        | 'encryption_material_unavailable'
        | 'content_unreadable'
        | 'content_binding_mismatch'
        | 'encryption_mode_mismatch';
      structural: ReviewCommentStructuralV1;
      envelope: StoredJsonContentEnvelope;
    }>;

export const StoredReviewCommentV1Schema = z.object({
  v: z.literal(1),
  structural: ReviewCommentStructuralV1Schema,
  sensitiveEnvelope: StoredJsonContentEnvelopeSchema,
}).strict();
export type StoredReviewCommentV1 = z.infer<typeof StoredReviewCommentV1Schema>;

function anchorIndex(anchor: ReviewCommentV1['anchor']): ReviewCommentAnchorIndexV1 {
  return ReviewCommentAnchorIndexV1Schema.parse({
    kind: anchor.kind,
    ...('filePath' in anchor ? { filePath: anchor.filePath } : {}),
    ...('folderPath' in anchor ? { folderPath: anchor.folderPath } : {}),
  });
}

function sensitiveBinding(structural: ReviewCommentStructuralV1): ReviewCommentSensitiveBindingV1 {
  return {
    v: 1,
    accountId: structural.accountId,
    projectId: structural.projectId,
    commentId: structural.id,
    serverRevision: structural.serverRevision,
    bodyVersion: structural.bodyVersion,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function splitReviewCommentV1(commentInput: ReviewCommentV1): ReviewCommentSplitV1 {
  const comment = ReviewCommentV1Schema.parse(commentInput);
  return {
    structural: ReviewCommentStructuralV1Schema.parse({
      v: 1,
      id: comment.id,
      accountId: comment.accountId,
      projectId: comment.projectId,
      workspaceId: comment.workspaceId,
      sessionId: comment.sessionId,
      runId: comment.runId,
      engineId: comment.engineId,
      findingId: comment.findingId,
      anchorIndex: anchorIndex(comment.anchor),
      bodyVersion: comment.bodyVersion,
      editHistory: comment.edits.map(({ editId, editedAt, editedBy }) => ({
        editId,
        editedAt,
        editedBy,
      })),
      author: comment.author,
      state: comment.state,
      flags: comment.flags,
      dispositions: comment.dispositions,
      parentCommentId: comment.parentCommentId,
      threadId: comment.threadId,
      transitionHistory: comment.transitions.map((transition) => {
        const { reason: _reason, evidence: _evidence, ...structuralTransition } = transition;
        return structuralTransition;
      }),
      tombstone: comment.tombstone
        ? (({ reason: _reason, ...structuralTombstone }) => structuralTombstone)(comment.tombstone)
        : undefined,
      fingerprintIndex: comment.fingerprint
        ? { normalizedMessageHash: comment.fingerprint.normalizedMessageHash }
        : undefined,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      serverRevision: comment.serverRevision,
    }),
    sensitive: ReviewCommentSensitiveContentV1Schema.parse({
      anchor: comment.anchor,
      snapshot: comment.snapshot,
      body: comment.body,
      edits: comment.edits,
      evidence: comment.evidence,
      transitions: comment.transitions,
      tombstone: comment.tombstone,
      fingerprint: comment.fingerprint,
      linkedRefs: comment.linkedRefs,
      suggestedFix: comment.suggestedFix,
      metadata: comment.metadata,
    }),
  };
}

function reconstructComment(
  structural: ReviewCommentStructuralV1,
  sensitive: ReviewCommentSensitiveContentV1,
): ReviewCommentV1 | null {
  const parsed = ReviewCommentV1Schema.safeParse({
    v: 1,
    id: structural.id,
    accountId: structural.accountId,
    projectId: structural.projectId,
    workspaceId: structural.workspaceId,
    sessionId: structural.sessionId,
    runId: structural.runId,
    engineId: structural.engineId,
    findingId: structural.findingId,
    anchor: sensitive.anchor,
    snapshot: sensitive.snapshot,
    body: sensitive.body,
    bodyVersion: structural.bodyVersion,
    edits: sensitive.edits,
    author: structural.author,
    state: structural.state,
    flags: structural.flags,
    dispositions: structural.dispositions,
    parentCommentId: structural.parentCommentId,
    threadId: structural.threadId,
    evidence: sensitive.evidence,
    transitions: sensitive.transitions,
    tombstone: sensitive.tombstone,
    fingerprint: sensitive.fingerprint,
    linkedRefs: sensitive.linkedRefs,
    suggestedFix: sensitive.suggestedFix,
    metadata: sensitive.metadata,
    createdAt: structural.createdAt,
    updatedAt: structural.updatedAt,
    serverRevision: structural.serverRevision,
  });
  if (!parsed.success) return null;
  const resplit = splitReviewCommentV1(parsed.data);
  if (!exactJson(resplit.structural, structural)) return null;
  return parsed.data;
}

export function sealReviewCommentSensitiveEnvelopeV1(params: Readonly<{
  structural: ReviewCommentStructuralV1;
  sensitive: ReviewCommentSensitiveContentV1;
}> & (
  | Readonly<{ mode: 'plain' }>
  | Readonly<{
      mode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      randomBytes: (length: number) => Uint8Array;
    }>
)): StoredJsonContentEnvelope {
  const structural = ReviewCommentStructuralV1Schema.parse(params.structural);
  const sensitive = ReviewCommentSensitiveContentV1Schema.parse(params.sensitive);
  if (!reconstructComment(structural, sensitive)) {
    throw new Error('Review Comment structural and sensitive content do not match');
  }
  const payload = ReviewCommentSensitivePayloadV1Schema.parse({
    v: 1,
    binding: sensitiveBinding(structural),
    content: sensitive,
  });
  if (params.mode === 'plain') {
    return StoredJsonContentEnvelopeSchema.parse({ t: 'plain', v: payload });
  }
  return StoredJsonContentEnvelopeSchema.parse({
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: 'review_comment_sensitive',
      material: params.material,
      payload,
      randomBytes: params.randomBytes,
    }),
  });
}

export function openReviewCommentSensitiveEnvelopeV1(params: Readonly<{
  structural: ReviewCommentStructuralV1;
  envelope: StoredJsonContentEnvelope;
  mode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial;
}>): ReviewCommentOpenResultV1 {
  const structural = ReviewCommentStructuralV1Schema.parse(params.structural);
  const envelope = StoredJsonContentEnvelopeSchema.parse(params.envelope);
  if (
    (params.mode === 'plain' && envelope.t !== 'plain')
    || (params.mode === 'e2ee' && envelope.t !== 'encrypted')
  ) {
    return { status: 'locked', reason: 'encryption_mode_mismatch', structural, envelope };
  }
  let rawPayload: unknown;
  if (envelope.t === 'plain') {
    rawPayload = envelope.v;
  } else {
    if (!params.material) {
      return {
        status: 'locked',
        reason: 'encryption_material_unavailable',
        structural,
        envelope,
      };
    }
    const opened = openAccountScopedBlobCiphertext({
      kind: 'review_comment_sensitive',
      material: params.material,
      ciphertext: envelope.c,
    });
    if (!opened) {
      return { status: 'locked', reason: 'content_unreadable', structural, envelope };
    }
    rawPayload = opened.value;
  }
  const payload = ReviewCommentSensitivePayloadV1Schema.safeParse(rawPayload);
  if (!payload.success) {
    return { status: 'locked', reason: 'content_unreadable', structural, envelope };
  }
  if (!exactJson(payload.data.binding, sensitiveBinding(structural))) {
    return { status: 'locked', reason: 'content_binding_mismatch', structural, envelope };
  }
  const comment = reconstructComment(structural, payload.data.content);
  if (!comment) {
    return { status: 'locked', reason: 'content_binding_mismatch', structural, envelope };
  }
  return { status: 'available', comment };
}

export function openStoredReviewCommentV1(params: Readonly<{
  stored: StoredReviewCommentV1;
  mode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial;
}>): ReviewCommentOpenResultV1 {
  const stored = StoredReviewCommentV1Schema.parse(params.stored);
  return openReviewCommentSensitiveEnvelopeV1({
    structural: stored.structural,
    envelope: stored.sensitiveEnvelope,
    mode: params.mode,
    material: params.material,
  });
}

export type ReviewCommentMigrationSourceOpenResultV1 =
  | Readonly<{ status: 'available'; comment: ReviewCommentV1 }>
  | Readonly<{
      status: 'locked';
      reason:
        | 'encryption_material_unavailable'
        | 'content_unreadable'
        | 'content_binding_mismatch';
      structural: ReviewCommentStructuralV1;
      source: ReviewCommentSensitiveMigrationSourceV1;
    }>;

async function openLegacyReviewCommentBodyValue(params: Readonly<{
  value: unknown;
  sourceMode: 'plain' | 'e2ee';
  openLegacyCiphertext?: (ciphertext: string) => Promise<unknown | null>;
}>): Promise<string | null> {
  if (typeof params.value === 'string') {
    return params.sourceMode === 'plain' ? params.value : null;
  }
  const envelope = StoredJsonContentEnvelopeSchema.safeParse(params.value);
  if (!envelope.success) return null;
  if (params.sourceMode === 'plain') {
    return envelope.data.t === 'plain' && typeof envelope.data.v === 'string'
      ? envelope.data.v
      : null;
  }
  if (envelope.data.t !== 'encrypted' || !params.openLegacyCiphertext) {
    return null;
  }
  const opened = await params.openLegacyCiphertext(envelope.data.c);
  return typeof opened === 'string' ? opened : null;
}

export async function openReviewCommentSensitiveMigrationSourceV1(
  params: Readonly<{
    structural: ReviewCommentStructuralV1;
    source: ReviewCommentSensitiveMigrationSourceV1;
    material?: AccountScopedCryptoMaterial;
    openLegacyCiphertext?: (ciphertext: string) => Promise<unknown | null>;
  }>,
): Promise<ReviewCommentMigrationSourceOpenResultV1> {
  const structural = ReviewCommentStructuralV1Schema.parse(params.structural);
  const source = ReviewCommentSensitiveMigrationSourceV1Schema.parse(params.source);
  if (source.layout === 'canonical_v1') {
    const opened = openReviewCommentSensitiveEnvelopeV1({
      structural,
      envelope: source.envelope,
      mode: source.envelope.t === 'encrypted' ? 'e2ee' : 'plain',
      material: params.material,
    });
    if (opened.status === 'available') return opened;
    return {
      status: 'locked',
      reason: opened.reason === 'encryption_mode_mismatch'
        ? 'content_unreadable'
        : opened.reason,
      structural,
      source,
    };
  }

  let snapshot: unknown;
  let body: unknown;
  if (source.sourceMode === 'plain') {
    if (
      source.snapshotEnvelope.t !== 'plain'
      || source.bodyEnvelope.t !== 'plain'
    ) {
      return { status: 'locked', reason: 'content_unreadable', structural, source };
    }
    snapshot = source.snapshotEnvelope.v;
    body = source.bodyEnvelope.v;
  } else {
    if (!params.openLegacyCiphertext) {
      return {
        status: 'locked',
        reason: 'encryption_material_unavailable',
        structural,
        source,
      };
    }
    if (
      source.snapshotEnvelope.t !== 'encrypted'
      || source.bodyEnvelope.t !== 'encrypted'
    ) {
      return { status: 'locked', reason: 'content_unreadable', structural, source };
    }
    [snapshot, body] = await Promise.all([
      params.openLegacyCiphertext(source.snapshotEnvelope.c),
      params.openLegacyCiphertext(source.bodyEnvelope.c),
    ]);
    if (snapshot === null || body === null) {
      return { status: 'locked', reason: 'content_unreadable', structural, source };
    }
  }

  const edits = [];
  for (const edit of source.edits) {
    const [previousBody, nextBody] = await Promise.all([
      openLegacyReviewCommentBodyValue({
        value: edit.previousBody,
        sourceMode: source.sourceMode,
        openLegacyCiphertext: params.openLegacyCiphertext,
      }),
      openLegacyReviewCommentBodyValue({
        value: edit.nextBody,
        sourceMode: source.sourceMode,
        openLegacyCiphertext: params.openLegacyCiphertext,
      }),
    ]);
    if (previousBody === null || nextBody === null) {
      return { status: 'locked', reason: 'content_unreadable', structural, source };
    }
    edits.push({ ...edit, previousBody, nextBody });
  }

  const sensitive = ReviewCommentSensitiveContentV1Schema.safeParse({
    anchor: source.anchor,
    snapshot,
    body,
    edits,
    evidence: source.evidence,
    transitions: source.transitions,
    tombstone: source.tombstone,
    fingerprint: source.fingerprint,
    linkedRefs: source.linkedRefs,
    suggestedFix: source.suggestedFix,
    metadata: source.metadata,
  });
  if (!sensitive.success) {
    return { status: 'locked', reason: 'content_unreadable', structural, source };
  }
  const comment = reconstructComment(structural, sensitive.data);
  return comment
    ? { status: 'available', comment }
    : { status: 'locked', reason: 'content_binding_mismatch', structural, source };
}

export const ReviewCommentMutationActionIdV1Schema = z.enum([
  'reviews.comments.create',
  'reviews.comments.transition',
  'reviews.comments.edit',
  'reviews.comments.reply',
  'reviews.comments.redact',
  'reviews.comments.setDisposition',
  'reviews.comments.attachEvidence',
  'reviews.comments.bulkTransition',
]);
export type ReviewCommentMutationActionIdV1 = z.infer<typeof ReviewCommentMutationActionIdV1Schema>;

const ReviewCommentEventRequestTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create') }).strict(),
  z.object({ kind: z.literal('comment'), commentId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('parent'), parentCommentId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal('bulk'),
    commentIds: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

const ReviewCommentEventExpectedCurrentnessV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create') }).strict(),
  z.object({
    kind: z.literal('comment'),
    expectedServerRevision: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('edit'),
    expectedServerRevision: z.number().int().positive(),
    expectedBodyVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('transition'),
    expectedServerRevision: z.number().int().positive(),
    expectedState: ReviewCommentStateV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('reply'),
    expectedParentServerRevision: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('bulk_transition'),
    expectedState: ReviewCommentStateV1Schema,
    expectedServerRevisions: z.record(z.string().min(1), z.number().int().positive()),
  }).strict(),
]);

export const ReviewCommentEventRequestBindingV1Schema = z.object({
  v: z.literal(1),
  accountId: z.string().min(1),
  projectId: z.string().min(1),
  actionId: ReviewCommentMutationActionIdV1Schema,
  eventKind: ReviewCommentEventKindV1Schema,
  actor: ReviewCommentActorRefV1Schema,
  clientMutationId: z.string().min(1),
  target: ReviewCommentEventRequestTargetV1Schema,
  expectedCurrentness: ReviewCommentEventExpectedCurrentnessV1Schema,
}).strict();
export type ReviewCommentEventRequestBindingV1 = z.infer<
  typeof ReviewCommentEventRequestBindingV1Schema
>;

const actionEventKind = {
  'reviews.comments.create': 'created',
  'reviews.comments.transition': 'transitioned',
  'reviews.comments.edit': 'edited',
  'reviews.comments.reply': 'replied',
  'reviews.comments.redact': 'redacted',
  'reviews.comments.setDisposition': 'disposition_set',
  'reviews.comments.attachEvidence': 'evidence_attached',
  'reviews.comments.bulkTransition': 'transitioned',
} as const;

function requiredBindingString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`review_comment_event_request_binding_missing:${key}`);
  }
  return value;
}

function requiredBindingPositiveInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`review_comment_event_request_binding_missing:${key}`);
  }
  return value as number;
}

export function buildReviewCommentEventRequestBindingV1(params: Readonly<{
  accountId: string;
  projectId: string;
  actor: z.input<typeof ReviewCommentActorRefV1Schema>;
  actionId: z.input<typeof ReviewCommentMutationActionIdV1Schema>;
  input: Record<string, unknown>;
}>): ReviewCommentEventRequestBindingV1 {
  const actionId = ReviewCommentMutationActionIdV1Schema.parse(params.actionId);
  const clientMutationId = requiredBindingString(params.input, 'clientMutationId');
  let target: z.input<typeof ReviewCommentEventRequestTargetV1Schema>;
  let expectedCurrentness: z.input<typeof ReviewCommentEventExpectedCurrentnessV1Schema>;
  if (actionId === 'reviews.comments.create') {
    target = { kind: 'create' };
    expectedCurrentness = { kind: 'create' };
  } else if (actionId === 'reviews.comments.reply') {
    target = { kind: 'parent', parentCommentId: requiredBindingString(params.input, 'parentCommentId') };
    expectedCurrentness = {
      kind: 'reply',
      expectedParentServerRevision: requiredBindingPositiveInteger(params.input, 'expectedParentServerRevision'),
    };
  } else if (actionId === 'reviews.comments.bulkTransition') {
    const commentIds = z.array(z.string().min(1)).min(1).parse(params.input.commentIds);
    target = { kind: 'bulk', commentIds };
    expectedCurrentness = {
      kind: 'bulk_transition',
      expectedState: ReviewCommentStateV1Schema.parse(params.input.expectedState),
      expectedServerRevisions: z.record(z.string().min(1), z.number().int().positive())
        .parse(params.input.expectedServerRevisions),
    };
  } else {
    target = { kind: 'comment', commentId: requiredBindingString(params.input, 'commentId') };
    const expectedServerRevision = requiredBindingPositiveInteger(params.input, 'expectedServerRevision');
    if (actionId === 'reviews.comments.edit') {
      expectedCurrentness = {
        kind: 'edit',
        expectedServerRevision,
        expectedBodyVersion: requiredBindingPositiveInteger(params.input, 'expectedBodyVersion'),
      };
    } else if (actionId === 'reviews.comments.transition') {
      expectedCurrentness = {
        kind: 'transition',
        expectedServerRevision,
        expectedState: ReviewCommentStateV1Schema.parse(params.input.expectedState),
      };
    } else {
      expectedCurrentness = { kind: 'comment', expectedServerRevision };
    }
  }
  return ReviewCommentEventRequestBindingV1Schema.parse({
    v: 1,
    accountId: params.accountId,
    projectId: params.projectId,
    actionId,
    eventKind: actionEventKind[actionId],
    actor: params.actor,
    clientMutationId,
    target,
    expectedCurrentness,
  });
}

export const ReviewCommentEventSensitivePayloadV1Schema = z.object({
  v: z.literal(1),
  requestBinding: ReviewCommentEventRequestBindingV1Schema,
  details: z.record(z.string(), z.unknown()),
}).strict();
export type ReviewCommentEventSensitivePayloadV1 = z.infer<typeof ReviewCommentEventSensitivePayloadV1Schema>;

export const ReviewCommentEventSensitiveBindingV1Schema = z.object({
  v: z.literal(1),
  eventId: z.string().min(1),
  commentId: z.string().min(1),
  accountId: z.string().min(1),
  projectId: z.string().min(1),
  eventKind: ReviewCommentEventKindV1Schema,
  actor: ReviewCommentActorRefV1Schema,
  createdAt: z.number().int().nonnegative(),
  serverRevision: z.number().int().positive(),
  bulkActionId: z.string().min(1).optional(),
  clientMutationId: z.string().min(1).optional(),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  requestBinding: ReviewCommentEventRequestBindingV1Schema,
}).strict();
export type ReviewCommentEventSensitiveBindingV1 = z.infer<typeof ReviewCommentEventSensitiveBindingV1Schema>;

export const BoundReviewCommentEventSensitiveEnvelopeV1Schema = z.object({
  v: z.literal(1),
  binding: ReviewCommentEventSensitiveBindingV1Schema,
  sensitive: StoredJsonContentEnvelopeSchema,
}).strict();
export type BoundReviewCommentEventSensitiveEnvelopeV1 = z.infer<
  typeof BoundReviewCommentEventSensitiveEnvelopeV1Schema
>;

export type ReviewCommentEventOpenResultV1 =
  | Readonly<{ status: 'available'; event: ReviewCommentEventV1 }>
  | Readonly<{
      status: 'locked';
      reason:
        | 'event_binding_mismatch'
        | 'encryption_material_unavailable'
        | 'content_unreadable'
        | 'encryption_mode_mismatch';
      event: ReviewCommentEventV1;
      bound: BoundReviewCommentEventSensitiveEnvelopeV1;
    }>;

function eventClientMutationId(event: ReviewCommentEventV1): string | undefined {
  const value = event.event.clientMutationId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function eventBinding(
  event: ReviewCommentEventV1,
  requestBinding: ReviewCommentEventRequestBindingV1,
): ReviewCommentEventSensitiveBindingV1 {
  return ReviewCommentEventSensitiveBindingV1Schema.parse({
    v: 1,
    eventId: event.eventId,
    commentId: event.commentId,
    accountId: event.accountId,
    projectId: event.projectId,
    eventKind: event.eventKind,
    actor: event.actor,
    createdAt: event.createdAt,
    serverRevision: event.serverRevision,
    bulkActionId: event.bulkActionId,
    clientMutationId: eventClientMutationId(event),
    authorDeviceId: event.authorDeviceId,
    clientLamport: event.clientLamport,
    requestBinding,
  });
}

export function reviewCommentEventSensitiveBindingMatchesV1(params: Readonly<{
  event: ReviewCommentEventV1;
  bound: BoundReviewCommentEventSensitiveEnvelopeV1;
}>): boolean {
  const bound = BoundReviewCommentEventSensitiveEnvelopeV1Schema.safeParse(params.bound);
  return bound.success && exactJson(
    bound.data.binding,
    eventBinding(params.event, bound.data.binding.requestBinding),
  );
}

export function sealReviewCommentEventSensitiveEnvelopeV1(params: Readonly<{
  payload: ReviewCommentEventSensitivePayloadV1;
}> & (
  | Readonly<{ mode: 'plain' }>
  | Readonly<{
      mode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      randomBytes: (length: number) => Uint8Array;
    }>
)): StoredJsonContentEnvelope {
  const payload = ReviewCommentEventSensitivePayloadV1Schema.parse(params.payload);
  if (params.mode === 'plain') {
    return StoredJsonContentEnvelopeSchema.parse({ t: 'plain', v: payload });
  }
  return StoredJsonContentEnvelopeSchema.parse({
    t: 'encrypted',
    c: sealAccountScopedBlobCiphertext({
      kind: 'review_comment_event_sensitive',
      material: params.material,
      payload,
      randomBytes: params.randomBytes,
    }),
  });
}

export function reviewCommentMutationInputWithoutEventEnvelopeV1(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { eventEnvelope: _eventEnvelope, ...logicalInput } = input;
  return logicalInput;
}

export function buildReviewCommentMutationEventEnvelopeV1(params: Readonly<{
  accountId: string;
  actor: z.input<typeof ReviewCommentActorRefV1Schema>;
  actionId: z.input<typeof ReviewCommentMutationActionIdV1Schema>;
  input: Record<string, unknown>;
}> & (
  | Readonly<{ mode: 'plain' }>
  | Readonly<{
      mode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      randomBytes: (length: number) => Uint8Array;
    }>
)): StoredJsonContentEnvelope {
  const projectId = requiredBindingString(params.input, 'projectId');
  const requestBinding = buildReviewCommentEventRequestBindingV1({
    accountId: params.accountId,
    projectId,
    actor: params.actor,
    actionId: params.actionId,
    input: params.input,
  });
  const details = reviewCommentMutationInputWithoutEventEnvelopeV1(params.input);
  const payload = ReviewCommentEventSensitivePayloadV1Schema.parse({
    v: 1,
    requestBinding,
    details,
  });
  return params.mode === 'plain'
    ? sealReviewCommentEventSensitiveEnvelopeV1({ payload, mode: 'plain' })
    : sealReviewCommentEventSensitiveEnvelopeV1({
        payload,
        mode: 'e2ee',
        material: params.material,
        randomBytes: params.randomBytes,
      });
}

export function bindReviewCommentEventSensitiveEnvelopeV1(params: Readonly<{
  event: ReviewCommentEventV1;
  requestBinding: ReviewCommentEventRequestBindingV1;
  sensitive: StoredJsonContentEnvelope;
}>): BoundReviewCommentEventSensitiveEnvelopeV1 {
  return BoundReviewCommentEventSensitiveEnvelopeV1Schema.parse({
    v: 1,
    binding: eventBinding(
      params.event,
      ReviewCommentEventRequestBindingV1Schema.parse(params.requestBinding),
    ),
    sensitive: params.sensitive,
  });
}

export function openReviewCommentEventSensitiveEnvelopeV1(params: Readonly<{
  event: ReviewCommentEventV1;
  bound: BoundReviewCommentEventSensitiveEnvelopeV1;
  mode: 'plain' | 'e2ee';
  material?: AccountScopedCryptoMaterial;
}>): ReviewCommentEventOpenResultV1 {
  const event = params.event;
  const bound = BoundReviewCommentEventSensitiveEnvelopeV1Schema.parse(params.bound);
  if (!reviewCommentEventSensitiveBindingMatchesV1({ event, bound })) {
    return { status: 'locked', reason: 'event_binding_mismatch', event, bound };
  }
  if (
    (params.mode === 'plain' && bound.sensitive.t !== 'plain')
    || (params.mode === 'e2ee' && bound.sensitive.t !== 'encrypted')
  ) {
    return { status: 'locked', reason: 'encryption_mode_mismatch', event, bound };
  }
  let rawPayload: unknown;
  if (bound.sensitive.t === 'plain') {
    rawPayload = bound.sensitive.v;
  } else {
    if (!params.material) {
      return { status: 'locked', reason: 'encryption_material_unavailable', event, bound };
    }
    const opened = openAccountScopedBlobCiphertext({
      kind: 'review_comment_event_sensitive',
      material: params.material,
      ciphertext: bound.sensitive.c,
    });
    if (!opened) {
      return { status: 'locked', reason: 'content_unreadable', event, bound };
    }
    rawPayload = opened.value;
  }
  const payload = ReviewCommentEventSensitivePayloadV1Schema.safeParse(rawPayload);
  if (!payload.success) {
    return { status: 'locked', reason: 'content_unreadable', event, bound };
  }
  if (!exactJson(payload.data.requestBinding, bound.binding.requestBinding)) {
    return { status: 'locked', reason: 'event_binding_mismatch', event, bound };
  }
  return {
    status: 'available',
    event: {
      ...event,
      event: payload.data.details,
    },
  };
}

export const REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_COMMENTS_V1 = 200;
export const REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_EVENTS_V1 = 2_000;

export const ReviewCommentEventSensitiveMigrationLayoutV1Schema = z.enum([
  'canonical_v1',
  'legacy_split_v1',
]);
export type ReviewCommentEventSensitiveMigrationLayoutV1 = z.infer<
  typeof ReviewCommentEventSensitiveMigrationLayoutV1Schema
>;

export function classifyReviewCommentEventSensitiveMigrationLayoutV1(
  envelopeInput: StoredJsonContentEnvelope,
): ReviewCommentEventSensitiveMigrationLayoutV1 {
  const envelope = StoredJsonContentEnvelopeSchema.parse(envelopeInput);
  if (envelope.t === 'plain') {
    return ReviewCommentEventSensitivePayloadV1Schema.safeParse(envelope.v).success
      ? 'canonical_v1'
      : 'legacy_split_v1';
  }
  return isAccountScopedBlobCiphertextForKind({
    kind: 'review_comment_event_sensitive',
    ciphertext: envelope.c,
  })
    ? 'canonical_v1'
    : 'legacy_split_v1';
}

export const ReviewCommentAccountEncryptionMigrationInventoryEventV1Schema = z.object({
  event: ReviewCommentEventV1Schema,
  sensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1Schema,
  sourceLayout: ReviewCommentEventSensitiveMigrationLayoutV1Schema,
}).strict();
export type ReviewCommentAccountEncryptionMigrationInventoryEventV1 = z.infer<
  typeof ReviewCommentAccountEncryptionMigrationInventoryEventV1Schema
>;

export const ReviewCommentAccountEncryptionMigrationInventoryItemV1Schema = z.object({
  structural: ReviewCommentStructuralV1Schema,
  sensitiveSource: ReviewCommentSensitiveMigrationSourceV1Schema,
  events: z.array(ReviewCommentAccountEncryptionMigrationInventoryEventV1Schema)
    .max(REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_EVENTS_V1),
}).strict();
export type ReviewCommentAccountEncryptionMigrationInventoryItemV1 = z.infer<
  typeof ReviewCommentAccountEncryptionMigrationInventoryItemV1Schema
>;

export const ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema = z.object({
  v: z.literal(1),
  items: z.array(ReviewCommentAccountEncryptionMigrationInventoryItemV1Schema)
    .max(REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_COMMENTS_V1),
}).strict().superRefine((value, ctx) => {
  const eventCount = value.items.reduce(
    (count, item) => count + item.events.length,
    0,
  );
  if (eventCount > REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_EVENTS_V1) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_EVENTS_V1,
      origin: 'array',
      inclusive: true,
      path: ['items'],
      message: 'Review Comment migration event inventory exceeds the supported bound',
    });
  }
});
export type ReviewCommentAccountEncryptionMigrationInventoryResponseV1 = z.infer<
  typeof ReviewCommentAccountEncryptionMigrationInventoryResponseV1Schema
>;
