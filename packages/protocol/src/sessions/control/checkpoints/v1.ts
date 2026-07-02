import { z } from 'zod';

const NonEmptyStringSchema = z.string().trim().min(1);

export const CheckpointRestoreScopeV1Schema = z.enum(['conversation', 'workspace']);
export type CheckpointRestoreScopeV1 = z.infer<typeof CheckpointRestoreScopeV1Schema>;

export const CheckpointTimingV1Schema = z.enum(['idle', 'activeTurn']);
export type CheckpointTimingV1 = z.infer<typeof CheckpointTimingV1Schema>;

export const CheckpointRestoreSourceV1Schema = z.enum(['provider', 'happier_scm', 'composed']);
export type CheckpointRestoreSourceV1 = z.infer<typeof CheckpointRestoreSourceV1Schema>;

export const CheckpointRestoreAnchorEvidenceV1Schema = z.object({
  turnId: NonEmptyStringSchema.optional(),
  messageSeq: z.number().int().nonnegative().optional(),
  seqRange: z.object({
    startSeqInclusive: z.number().int().nonnegative(),
    endSeqInclusive: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();
export type CheckpointRestoreAnchorEvidenceV1 = z.infer<typeof CheckpointRestoreAnchorEvidenceV1Schema>;

export const CheckpointRestoreAnchorV1Schema = z.object({
  kind: z.literal('before_user_message'),
  messageId: NonEmptyStringSchema,
  evidence: CheckpointRestoreAnchorEvidenceV1Schema.optional(),
}).strict();
export type CheckpointRestoreAnchorV1 = z.infer<typeof CheckpointRestoreAnchorV1Schema>;

export const CheckpointProviderTargetRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider_checkpoint'),
    checkpointId: NonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('provider_message'),
    messageId: NonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('provider_turn'),
    turnId: NonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('provider_restore_token'),
    token: NonEmptyStringSchema,
  }).strict(),
]);
export type CheckpointProviderTargetRefV1 = z.infer<typeof CheckpointProviderTargetRefV1Schema>;

export const SanitizedCheckpointProviderTargetRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider_checkpoint'),
    checkpointId: NonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('provider_message'),
    messageId: NonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('provider_turn'),
    turnId: NonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('provider_restore_token'),
    redacted: z.literal(true),
  }).strict(),
]);
export type SanitizedCheckpointProviderTargetRefV1 = z.infer<typeof SanitizedCheckpointProviderTargetRefV1Schema>;

const CheckpointScopesSchema = z.array(CheckpointRestoreScopeV1Schema).nonempty().superRefine((scopes, ctx) => {
  const seen = new Set<CheckpointRestoreScopeV1>();
  scopes.forEach((scope, index) => {
    if (seen.has(scope)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Checkpoint scope selections must not contain duplicates',
        path: [index],
      });
      return;
    }
    seen.add(scope);
  });
});

function sameScopeSet(
  left: readonly CheckpointRestoreScopeV1[],
  right: readonly CheckpointRestoreScopeV1[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) {
    return false;
  }
  return [...leftSet].every((scope) => rightSet.has(scope));
}

function flattenedPartScopes(
  parts: readonly Readonly<{ scopes: readonly CheckpointRestoreScopeV1[] }>[],
): readonly CheckpointRestoreScopeV1[] {
  return parts.flatMap((part) => part.scopes);
}

function exactlyPartitionsScopes(
  requestedScopes: readonly CheckpointRestoreScopeV1[],
  parts: readonly Readonly<{ scopes: readonly CheckpointRestoreScopeV1[] }>[],
): boolean {
  const partScopes = flattenedPartScopes(parts);
  return partScopes.length === requestedScopes.length && sameScopeSet(requestedScopes, partScopes);
}

const CheckpointProviderCandidateRefV1BaseSchema = z.object({
  source: z.literal('provider'),
  backendId: NonEmptyStringSchema,
  anchor: CheckpointRestoreAnchorV1Schema.optional(),
  target: CheckpointProviderTargetRefV1Schema.optional(),
}).strict();

export const CheckpointProviderCandidateRefV1Schema = CheckpointProviderCandidateRefV1BaseSchema.superRefine((candidate, ctx) => {
  const sourceCount = Number(candidate.anchor !== undefined) + Number(candidate.target !== undefined);
  if (sourceCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Checkpoint provider candidate requires exactly one of anchor or target',
      path: ['anchor'],
    });
  }
});
export type CheckpointProviderCandidateRefV1 = z.infer<typeof CheckpointProviderCandidateRefV1Schema>;

export const CheckpointScmCandidateRefV1Schema = z.object({
  source: z.literal('happier_scm'),
  checkpointRef: NonEmptyStringSchema,
  turnId: NonEmptyStringSchema.optional(),
}).strict();
export type CheckpointScmCandidateRefV1 = z.infer<typeof CheckpointScmCandidateRefV1Schema>;

export const CheckpointAtomicCandidateRefV1Schema = z.union([
  CheckpointProviderCandidateRefV1Schema,
  CheckpointScmCandidateRefV1Schema,
]);
export type CheckpointAtomicCandidateRefV1 = z.infer<typeof CheckpointAtomicCandidateRefV1Schema>;

export const CheckpointSelectedAtomicCandidatePartV1Schema = z.object({
  scopes: CheckpointScopesSchema,
  candidate: CheckpointAtomicCandidateRefV1Schema,
}).strict();
export type CheckpointSelectedAtomicCandidatePartV1 = z.infer<typeof CheckpointSelectedAtomicCandidatePartV1Schema>;

export const CheckpointComposedCandidateRefV1Schema = z.object({
  source: z.literal('composed'),
  parts: z.array(CheckpointSelectedAtomicCandidatePartV1Schema).nonempty(),
}).strict();
export type CheckpointComposedCandidateRefV1 = z.infer<typeof CheckpointComposedCandidateRefV1Schema>;

export const CheckpointCandidateRefV1Schema = z.union([
  CheckpointProviderCandidateRefV1Schema,
  CheckpointScmCandidateRefV1Schema,
  CheckpointComposedCandidateRefV1Schema,
]);
export type CheckpointCandidateRefV1 = z.infer<typeof CheckpointCandidateRefV1Schema>;

const SanitizedCheckpointProviderCandidateRefV1BaseSchema = z.object({
  source: z.literal('provider'),
  backendId: NonEmptyStringSchema,
  anchor: CheckpointRestoreAnchorV1Schema.optional(),
  target: SanitizedCheckpointProviderTargetRefV1Schema.optional(),
}).strict();

const SanitizedCheckpointProviderCandidateRefV1Schema = SanitizedCheckpointProviderCandidateRefV1BaseSchema.superRefine((candidate, ctx) => {
  const sourceCount = Number(candidate.anchor !== undefined) + Number(candidate.target !== undefined);
  if (sourceCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Sanitized checkpoint provider candidate requires exactly one of anchor or target',
      path: ['anchor'],
    });
  }
});

const SanitizedCheckpointAtomicCandidateRefV1Schema = z.union([
  SanitizedCheckpointProviderCandidateRefV1Schema,
  CheckpointScmCandidateRefV1Schema,
]);

const SanitizedCheckpointSelectedAtomicCandidatePartV1Schema = z.object({
  scopes: CheckpointScopesSchema,
  candidate: SanitizedCheckpointAtomicCandidateRefV1Schema,
}).strict();

export const SanitizedCheckpointComposedCandidateRefV1Schema = z.object({
  source: z.literal('composed'),
  parts: z.array(SanitizedCheckpointSelectedAtomicCandidatePartV1Schema).nonempty(),
}).strict();

export const SanitizedCheckpointCandidateRefV1Schema = z.union([
  SanitizedCheckpointProviderCandidateRefV1Schema,
  CheckpointScmCandidateRefV1Schema,
  SanitizedCheckpointComposedCandidateRefV1Schema,
]);
export type SanitizedCheckpointCandidateRefV1 = z.infer<typeof SanitizedCheckpointCandidateRefV1Schema>;

const CheckpointRestoreCandidateV1BaseSchema = z.object({
  id: NonEmptyStringSchema,
  source: CheckpointRestoreSourceV1Schema,
  scopes: CheckpointScopesSchema,
  candidate: CheckpointCandidateRefV1Schema,
  atomic: z.boolean().optional(),
  label: NonEmptyStringSchema.optional(),
  recommended: z.boolean().optional(),
  diagnostics: z.array(z.object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema.optional(),
  }).strict()).optional(),
}).strict();

export const CheckpointRestoreCandidateV1Schema = CheckpointRestoreCandidateV1BaseSchema.superRefine((candidate, ctx) => {
  if (candidate.source !== candidate.candidate.source) {
    ctx.addIssue({
      code: 'custom',
      message: 'Checkpoint restore candidate source must match nested candidate source',
      path: ['candidate', 'source'],
    });
  }
  if (candidate.candidate.source === 'composed' && !exactlyPartitionsScopes(candidate.scopes, candidate.candidate.parts)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Checkpoint composed restore candidate parts must exactly cover candidate scopes',
      path: ['candidate', 'parts'],
    });
  }
});
export type CheckpointRestoreCandidateV1 = z.infer<typeof CheckpointRestoreCandidateV1Schema>;

export const SanitizedCheckpointRestoreCandidateV1Schema = CheckpointRestoreCandidateV1BaseSchema.extend({
  candidate: SanitizedCheckpointCandidateRefV1Schema,
}).superRefine((candidate, ctx) => {
  if (candidate.source !== candidate.candidate.source) {
    ctx.addIssue({
      code: 'custom',
      message: 'Sanitized checkpoint restore candidate source must match nested candidate source',
      path: ['candidate', 'source'],
    });
  }
  if (candidate.candidate.source === 'composed' && !exactlyPartitionsScopes(candidate.scopes, candidate.candidate.parts)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Sanitized checkpoint composed restore candidate parts must exactly cover candidate scopes',
      path: ['candidate', 'parts'],
    });
  }
});
export type SanitizedCheckpointRestoreCandidateV1 = z.infer<typeof SanitizedCheckpointRestoreCandidateV1Schema>;

export const CheckpointProviderCreationCandidateRefV1Schema = z.object({
  source: z.literal('provider'),
  backendId: NonEmptyStringSchema,
}).strict();
export type CheckpointProviderCreationCandidateRefV1 = z.infer<typeof CheckpointProviderCreationCandidateRefV1Schema>;

export const CheckpointScmCreationCandidateRefV1Schema = z.object({
  source: z.literal('happier_scm'),
}).strict();
export type CheckpointScmCreationCandidateRefV1 = z.infer<typeof CheckpointScmCreationCandidateRefV1Schema>;

export const CheckpointAtomicCreationCandidateRefV1Schema = z.union([
  CheckpointProviderCreationCandidateRefV1Schema,
  CheckpointScmCreationCandidateRefV1Schema,
]);
export type CheckpointAtomicCreationCandidateRefV1 = z.infer<typeof CheckpointAtomicCreationCandidateRefV1Schema>;

export const CheckpointSelectedAtomicCreationCandidatePartV1Schema = z.object({
  scopes: CheckpointScopesSchema,
  candidate: CheckpointAtomicCreationCandidateRefV1Schema,
}).strict();
export type CheckpointSelectedAtomicCreationCandidatePartV1 = z.infer<typeof CheckpointSelectedAtomicCreationCandidatePartV1Schema>;

export const CheckpointComposedCreationCandidateRefV1Schema = z.object({
  source: z.literal('composed'),
  parts: z.array(CheckpointSelectedAtomicCreationCandidatePartV1Schema).nonempty(),
}).strict();
export type CheckpointComposedCreationCandidateRefV1 = z.infer<typeof CheckpointComposedCreationCandidateRefV1Schema>;

export const CheckpointCreationCandidateRefV1Schema = z.union([
  CheckpointProviderCreationCandidateRefV1Schema,
  CheckpointScmCreationCandidateRefV1Schema,
  CheckpointComposedCreationCandidateRefV1Schema,
]);
export type CheckpointCreationCandidateRefV1 = z.infer<typeof CheckpointCreationCandidateRefV1Schema>;

const CheckpointCreationCandidateV1BaseSchema = z.object({
  id: NonEmptyStringSchema,
  source: CheckpointRestoreSourceV1Schema,
  scopes: CheckpointScopesSchema,
  candidate: CheckpointCreationCandidateRefV1Schema,
  atomic: z.boolean().optional(),
  label: NonEmptyStringSchema.optional(),
  recommended: z.boolean().optional(),
  diagnostics: z.array(z.object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema.optional(),
  }).strict()).optional(),
}).strict();

export const CheckpointCreationCandidateV1Schema = CheckpointCreationCandidateV1BaseSchema.superRefine((candidate, ctx) => {
  if (candidate.source !== candidate.candidate.source) {
    ctx.addIssue({
      code: 'custom',
      message: 'Checkpoint creation candidate source must match nested candidate source',
      path: ['candidate', 'source'],
    });
  }
  if (candidate.candidate.source === 'composed' && !exactlyPartitionsScopes(candidate.scopes, candidate.candidate.parts)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Checkpoint composed creation candidate parts must exactly cover candidate scopes',
      path: ['candidate', 'parts'],
    });
  }
});
export type CheckpointCreationCandidateV1 = z.infer<typeof CheckpointCreationCandidateV1Schema>;

export const SanitizedCheckpointCreationCandidateRefV1Schema = CheckpointCreationCandidateRefV1Schema;
export type SanitizedCheckpointCreationCandidateRefV1 = z.infer<typeof SanitizedCheckpointCreationCandidateRefV1Schema>;

export const SanitizedCheckpointCreationCandidateV1Schema = CheckpointCreationCandidateV1Schema;
export type SanitizedCheckpointCreationCandidateV1 = z.infer<typeof SanitizedCheckpointCreationCandidateV1Schema>;

export const CheckpointRestoreConfirmationV1Schema = z.object({
  sourceChoiceConfirmed: z.boolean().optional(),
}).strict();
export type CheckpointRestoreConfirmationV1 = z.infer<typeof CheckpointRestoreConfirmationV1Schema>;

export const SessionCheckpointRequestV1Schema = z.object({
  v: z.literal(1),
  sessionId: NonEmptyStringSchema,
  scopes: CheckpointScopesSchema,
  candidate: CheckpointCreationCandidateRefV1Schema.optional(),
  timing: CheckpointTimingV1Schema.default('idle'),
  label: NonEmptyStringSchema.optional(),
  confirmation: CheckpointRestoreConfirmationV1Schema.optional(),
}).strict().superRefine((request, ctx) => {
  if (request.candidate?.source === 'composed' && !exactlyPartitionsScopes(request.scopes, request.candidate.parts)) {
    ctx.addIssue({
      code: 'custom',
      message: 'SessionCheckpointRequestV1 composed candidate parts must exactly cover requested scopes',
      path: ['candidate', 'parts'],
    });
  }
});
export type SessionCheckpointRequestV1 = z.infer<typeof SessionCheckpointRequestV1Schema>;

export const SessionRestoreRequestV1Schema = z.object({
  v: z.literal(1),
  sessionId: NonEmptyStringSchema,
  scopes: CheckpointScopesSchema,
  anchor: CheckpointRestoreAnchorV1Schema.optional(),
  candidate: CheckpointCandidateRefV1Schema.optional(),
  confirmation: CheckpointRestoreConfirmationV1Schema.optional(),
}).strict().superRefine((request, ctx) => {
  const targetSelectors = Number(request.anchor !== undefined) + Number(request.candidate !== undefined);
  if (targetSelectors !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'SessionRestoreRequestV1 requires exactly one of anchor or candidate',
      path: ['candidate'],
    });
  }
  if (request.candidate?.source === 'composed' && !exactlyPartitionsScopes(request.scopes, request.candidate.parts)) {
    ctx.addIssue({
      code: 'custom',
      message: 'SessionRestoreRequestV1 composed candidate parts must exactly cover requested scopes',
      path: ['candidate', 'parts'],
    });
  }
});
export type SessionRestoreRequestV1 = z.infer<typeof SessionRestoreRequestV1Schema>;

export const CheckpointFailedScopeV1Schema = z.object({
  scope: CheckpointRestoreScopeV1Schema,
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema.optional(),
}).strict();
export type CheckpointFailedScopeV1 = z.infer<typeof CheckpointFailedScopeV1Schema>;

export const CheckpointOperationReceiptV1Schema = z.object({
  v: z.literal(1),
  operation: z.enum(['checkpoint', 'restore']),
  phase: z.enum(['started', 'succeeded', 'partially_succeeded', 'failed']),
  lifecycleId: NonEmptyStringSchema,
  source: CheckpointRestoreSourceV1Schema,
  scopes: CheckpointScopesSchema,
  candidate: SanitizedCheckpointCandidateRefV1Schema.optional(),
  restoredScopes: CheckpointScopesSchema.optional(),
  failedScopes: z.array(CheckpointFailedScopeV1Schema).optional(),
}).strict();
export type CheckpointOperationReceiptV1 = z.infer<typeof CheckpointOperationReceiptV1Schema>;

export const SessionCheckpointResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: z.enum(['succeeded', 'partially_succeeded']),
    source: CheckpointRestoreSourceV1Schema,
    checkpointRef: NonEmptyStringSchema.optional(),
    receipts: z.array(CheckpointOperationReceiptV1Schema),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum([
      'source_choice_required',
      'checkpoint_source_unavailable',
      'session_not_idle',
      'checkpoint_failed',
      'confirmation_required',
      'invalid_request',
    ]),
    error: NonEmptyStringSchema.optional(),
    candidates: z.array(SanitizedCheckpointCreationCandidateV1Schema).optional(),
    receipts: z.array(CheckpointOperationReceiptV1Schema).optional(),
  }).strict(),
]);
export type SessionCheckpointResultV1 = z.infer<typeof SessionCheckpointResultV1Schema>;

export const SessionRestoreResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    status: z.enum(['succeeded', 'partially_succeeded']),
    source: CheckpointRestoreSourceV1Schema,
    restoredScopes: CheckpointScopesSchema,
    failedScopes: z.array(CheckpointFailedScopeV1Schema).optional(),
    receipts: z.array(CheckpointOperationReceiptV1Schema),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum([
      'source_choice_required',
      'restore_target_missing',
      'confirmation_required',
      'session_not_idle',
      'trusted_turn_evidence_required',
      'provider_restore_unavailable',
      'scm_restore_unavailable',
      'provider_restore_failed',
      'scm_restore_failed',
      'invalid_request',
    ]),
    error: NonEmptyStringSchema.optional(),
    candidates: z.array(SanitizedCheckpointRestoreCandidateV1Schema).optional(),
    receipts: z.array(CheckpointOperationReceiptV1Schema).optional(),
  }).strict(),
]);
export type SessionRestoreResultV1 = z.infer<typeof SessionRestoreResultV1Schema>;

export function sanitizeCheckpointProviderTargetRefV1(
  target: CheckpointProviderTargetRefV1 | SanitizedCheckpointProviderTargetRefV1,
): SanitizedCheckpointProviderTargetRefV1 {
  if (target.kind === 'provider_restore_token') {
    return { kind: 'provider_restore_token', redacted: true };
  }
  return target;
}

export function sanitizeCheckpointCandidateRefV1(
  candidate: CheckpointCandidateRefV1 | SanitizedCheckpointCandidateRefV1,
): SanitizedCheckpointCandidateRefV1 {
  if (candidate.source === 'provider') {
    return {
      source: 'provider',
      backendId: candidate.backendId,
      ...(candidate.anchor ? { anchor: candidate.anchor } : {}),
      ...(candidate.target ? { target: sanitizeCheckpointProviderTargetRefV1(candidate.target) } : {}),
    };
  }
  if (candidate.source === 'composed') {
    return {
      source: 'composed',
      parts: candidate.parts.map((part) => ({
        scopes: [...part.scopes],
        candidate: sanitizeCheckpointCandidateRefV1(part.candidate) as z.infer<typeof SanitizedCheckpointAtomicCandidateRefV1Schema>,
      })),
    };
  }
  return candidate;
}

export function sanitizeCheckpointRestoreCandidateV1(
  candidate: CheckpointRestoreCandidateV1 | SanitizedCheckpointRestoreCandidateV1,
): SanitizedCheckpointRestoreCandidateV1 {
  return {
    ...candidate,
    candidate: sanitizeCheckpointCandidateRefV1(candidate.candidate),
  };
}

export function sanitizeCheckpointCreationCandidateV1(
  candidate: CheckpointCreationCandidateV1 | SanitizedCheckpointCreationCandidateV1,
): SanitizedCheckpointCreationCandidateV1 {
  return {
    ...candidate,
    candidate: candidate.candidate.source === 'composed'
      ? {
          source: 'composed',
          parts: candidate.candidate.parts.map((part) => ({
            scopes: [...part.scopes],
            candidate: { ...part.candidate },
          })),
        }
      : { ...candidate.candidate },
  };
}

export function buildCheckpointOperationReceiptV1(input: Readonly<{
  operation: CheckpointOperationReceiptV1['operation'];
  phase: CheckpointOperationReceiptV1['phase'];
  lifecycleId: string;
  source: CheckpointRestoreSourceV1;
  scopes: readonly CheckpointRestoreScopeV1[];
  candidate?: CheckpointCandidateRefV1 | SanitizedCheckpointCandidateRefV1;
  restoredScopes?: readonly CheckpointRestoreScopeV1[];
  failedScopes?: readonly CheckpointFailedScopeV1[];
}>): CheckpointOperationReceiptV1 {
  return CheckpointOperationReceiptV1Schema.parse({
    v: 1,
    operation: input.operation,
    phase: input.phase,
    lifecycleId: input.lifecycleId,
    source: input.source,
    scopes: [...input.scopes],
    ...(input.candidate ? { candidate: sanitizeCheckpointCandidateRefV1(input.candidate) } : {}),
    ...(input.restoredScopes ? { restoredScopes: [...input.restoredScopes] } : {}),
    ...(input.failedScopes ? { failedScopes: input.failedScopes.map((entry) => ({ ...entry })) } : {}),
  });
}
