import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

const NonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const CheckpointRestoreScopeV1Schema = lazyZodSchema(() => z.enum(['conversation', 'workspace']));
export type CheckpointRestoreScopeV1 = z.infer<typeof CheckpointRestoreScopeV1Schema>;

export const CheckpointTimingV1Schema = lazyZodSchema(() => z.enum(['idle', 'activeTurn']));
export type CheckpointTimingV1 = z.infer<typeof CheckpointTimingV1Schema>;

export const CheckpointRestoreSourceV1Schema = lazyZodSchema(() => z.enum(['provider', 'happier_scm', 'composed']));
export type CheckpointRestoreSourceV1 = z.infer<typeof CheckpointRestoreSourceV1Schema>;

export const CheckpointRestoreAnchorEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
  turnId: z.optional(NonEmptyStringSchema),
  messageSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
  seqRange: z.optional(z.strictObject({
    startSeqInclusive: z.number().check(z.int(), z.nonnegative()),
    endSeqInclusive: z.number().check(z.int(), z.nonnegative()),
  })),
}));
export type CheckpointRestoreAnchorEvidenceV1 = z.infer<typeof CheckpointRestoreAnchorEvidenceV1Schema>;

export const CheckpointRestoreAnchorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('before_user_message'),
  messageId: NonEmptyStringSchema,
  evidence: z.optional(CheckpointRestoreAnchorEvidenceV1Schema),
}));
export type CheckpointRestoreAnchorV1 = z.infer<typeof CheckpointRestoreAnchorV1Schema>;

export const CheckpointProviderTargetRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('provider_checkpoint'),
    checkpointId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('provider_message'),
    messageId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('provider_turn'),
    turnId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('provider_restore_token'),
    token: NonEmptyStringSchema,
  }),
]));
export type CheckpointProviderTargetRefV1 = z.infer<typeof CheckpointProviderTargetRefV1Schema>;

export const SanitizedCheckpointProviderTargetRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('provider_checkpoint'),
    checkpointId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('provider_message'),
    messageId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('provider_turn'),
    turnId: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal('provider_restore_token'),
    redacted: z.literal(true),
  }),
]));
export type SanitizedCheckpointProviderTargetRefV1 = z.infer<typeof SanitizedCheckpointProviderTargetRefV1Schema>;

const CheckpointScopesSchema = lazyZodSchema(() => z.array(CheckpointRestoreScopeV1Schema).check(z.minLength(1), z.superRefine((scopes, ctx) => {
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
})));

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

const CheckpointProviderCandidateRefV1BaseSchema = lazyZodSchema(() => z.strictObject({
  source: z.literal('provider'),
  backendId: NonEmptyStringSchema,
  anchor: z.optional(CheckpointRestoreAnchorV1Schema),
  target: z.optional(CheckpointProviderTargetRefV1Schema),
}));

export const CheckpointProviderCandidateRefV1Schema = lazyZodSchema(() => CheckpointProviderCandidateRefV1BaseSchema.check(z.superRefine((candidate, ctx) => {
  const sourceCount = Number(candidate.anchor !== undefined) + Number(candidate.target !== undefined);
  if (sourceCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Checkpoint provider candidate requires exactly one of anchor or target',
      path: ['anchor'],
    });
  }
})));
export type CheckpointProviderCandidateRefV1 = z.infer<typeof CheckpointProviderCandidateRefV1Schema>;

export const CheckpointScmCandidateRefV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('happier_scm'),
  checkpointRef: NonEmptyStringSchema,
  turnId: z.optional(NonEmptyStringSchema),
}));
export type CheckpointScmCandidateRefV1 = z.infer<typeof CheckpointScmCandidateRefV1Schema>;

export const CheckpointAtomicCandidateRefV1Schema = lazyZodSchema(() => z.union([
  CheckpointProviderCandidateRefV1Schema,
  CheckpointScmCandidateRefV1Schema,
]));
export type CheckpointAtomicCandidateRefV1 = z.infer<typeof CheckpointAtomicCandidateRefV1Schema>;

export const CheckpointSelectedAtomicCandidatePartV1Schema = lazyZodSchema(() => z.strictObject({
  scopes: CheckpointScopesSchema,
  candidate: CheckpointAtomicCandidateRefV1Schema,
}));
export type CheckpointSelectedAtomicCandidatePartV1 = z.infer<typeof CheckpointSelectedAtomicCandidatePartV1Schema>;

export const CheckpointComposedCandidateRefV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('composed'),
  parts: z.array(CheckpointSelectedAtomicCandidatePartV1Schema).check(z.minLength(1)),
}));
export type CheckpointComposedCandidateRefV1 = z.infer<typeof CheckpointComposedCandidateRefV1Schema>;

export const CheckpointCandidateRefV1Schema = lazyZodSchema(() => z.union([
  CheckpointProviderCandidateRefV1Schema,
  CheckpointScmCandidateRefV1Schema,
  CheckpointComposedCandidateRefV1Schema,
]));
export type CheckpointCandidateRefV1 = z.infer<typeof CheckpointCandidateRefV1Schema>;

const SanitizedCheckpointProviderCandidateRefV1BaseSchema = lazyZodSchema(() => z.strictObject({
  source: z.literal('provider'),
  backendId: NonEmptyStringSchema,
  anchor: z.optional(CheckpointRestoreAnchorV1Schema),
  target: z.optional(SanitizedCheckpointProviderTargetRefV1Schema),
}));

const SanitizedCheckpointProviderCandidateRefV1Schema = lazyZodSchema(() => SanitizedCheckpointProviderCandidateRefV1BaseSchema.check(z.superRefine((candidate, ctx) => {
  const sourceCount = Number(candidate.anchor !== undefined) + Number(candidate.target !== undefined);
  if (sourceCount !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Sanitized checkpoint provider candidate requires exactly one of anchor or target',
      path: ['anchor'],
    });
  }
})));

const SanitizedCheckpointAtomicCandidateRefV1Schema = lazyZodSchema(() => z.union([
  SanitizedCheckpointProviderCandidateRefV1Schema,
  CheckpointScmCandidateRefV1Schema,
]));

const SanitizedCheckpointSelectedAtomicCandidatePartV1Schema = lazyZodSchema(() => z.strictObject({
  scopes: CheckpointScopesSchema,
  candidate: SanitizedCheckpointAtomicCandidateRefV1Schema,
}));

export const SanitizedCheckpointComposedCandidateRefV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('composed'),
  parts: z.array(SanitizedCheckpointSelectedAtomicCandidatePartV1Schema).check(z.minLength(1)),
}));

export const SanitizedCheckpointCandidateRefV1Schema = lazyZodSchema(() => z.union([
  SanitizedCheckpointProviderCandidateRefV1Schema,
  CheckpointScmCandidateRefV1Schema,
  SanitizedCheckpointComposedCandidateRefV1Schema,
]));
export type SanitizedCheckpointCandidateRefV1 = z.infer<typeof SanitizedCheckpointCandidateRefV1Schema>;

const CheckpointRestoreCandidateV1BaseSchema = lazyZodSchema(() => z.strictObject({
  id: NonEmptyStringSchema,
  source: CheckpointRestoreSourceV1Schema,
  scopes: CheckpointScopesSchema,
  candidate: CheckpointCandidateRefV1Schema,
  atomic: z.optional(z.boolean()),
  label: z.optional(NonEmptyStringSchema),
  recommended: z.optional(z.boolean()),
  diagnostics: z.optional(z.array(z.strictObject({
    code: NonEmptyStringSchema,
    message: z.optional(NonEmptyStringSchema),
  }))),
}));

export const CheckpointRestoreCandidateV1Schema = lazyZodSchema(() => CheckpointRestoreCandidateV1BaseSchema.check(z.superRefine((candidate, ctx) => {
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
})));
export type CheckpointRestoreCandidateV1 = z.infer<typeof CheckpointRestoreCandidateV1Schema>;

export const SanitizedCheckpointRestoreCandidateV1Schema = lazyZodSchema(() => z.extend(CheckpointRestoreCandidateV1BaseSchema, {
  candidate: SanitizedCheckpointCandidateRefV1Schema,
}).check(z.superRefine((candidate, ctx) => {
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
})));
export type SanitizedCheckpointRestoreCandidateV1 = z.infer<typeof SanitizedCheckpointRestoreCandidateV1Schema>;

export const CheckpointProviderCreationCandidateRefV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('provider'),
  backendId: NonEmptyStringSchema,
}));
export type CheckpointProviderCreationCandidateRefV1 = z.infer<typeof CheckpointProviderCreationCandidateRefV1Schema>;

export const CheckpointScmCreationCandidateRefV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('happier_scm'),
}));
export type CheckpointScmCreationCandidateRefV1 = z.infer<typeof CheckpointScmCreationCandidateRefV1Schema>;

export const CheckpointAtomicCreationCandidateRefV1Schema = lazyZodSchema(() => z.union([
  CheckpointProviderCreationCandidateRefV1Schema,
  CheckpointScmCreationCandidateRefV1Schema,
]));
export type CheckpointAtomicCreationCandidateRefV1 = z.infer<typeof CheckpointAtomicCreationCandidateRefV1Schema>;

export const CheckpointSelectedAtomicCreationCandidatePartV1Schema = lazyZodSchema(() => z.strictObject({
  scopes: CheckpointScopesSchema,
  candidate: CheckpointAtomicCreationCandidateRefV1Schema,
}));
export type CheckpointSelectedAtomicCreationCandidatePartV1 = z.infer<typeof CheckpointSelectedAtomicCreationCandidatePartV1Schema>;

export const CheckpointComposedCreationCandidateRefV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('composed'),
  parts: z.array(CheckpointSelectedAtomicCreationCandidatePartV1Schema).check(z.minLength(1)),
}));
export type CheckpointComposedCreationCandidateRefV1 = z.infer<typeof CheckpointComposedCreationCandidateRefV1Schema>;

export const CheckpointCreationCandidateRefV1Schema = lazyZodSchema(() => z.union([
  CheckpointProviderCreationCandidateRefV1Schema,
  CheckpointScmCreationCandidateRefV1Schema,
  CheckpointComposedCreationCandidateRefV1Schema,
]));
export type CheckpointCreationCandidateRefV1 = z.infer<typeof CheckpointCreationCandidateRefV1Schema>;

const CheckpointCreationCandidateV1BaseSchema = lazyZodSchema(() => z.strictObject({
  id: NonEmptyStringSchema,
  source: CheckpointRestoreSourceV1Schema,
  scopes: CheckpointScopesSchema,
  candidate: CheckpointCreationCandidateRefV1Schema,
  atomic: z.optional(z.boolean()),
  label: z.optional(NonEmptyStringSchema),
  recommended: z.optional(z.boolean()),
  diagnostics: z.optional(z.array(z.strictObject({
    code: NonEmptyStringSchema,
    message: z.optional(NonEmptyStringSchema),
  }))),
}));

export const CheckpointCreationCandidateV1Schema = lazyZodSchema(() => CheckpointCreationCandidateV1BaseSchema.check(z.superRefine((candidate, ctx) => {
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
})));
export type CheckpointCreationCandidateV1 = z.infer<typeof CheckpointCreationCandidateV1Schema>;

export const SanitizedCheckpointCreationCandidateRefV1Schema = CheckpointCreationCandidateRefV1Schema;
export type SanitizedCheckpointCreationCandidateRefV1 = z.infer<typeof SanitizedCheckpointCreationCandidateRefV1Schema>;

export const SanitizedCheckpointCreationCandidateV1Schema = CheckpointCreationCandidateV1Schema;
export type SanitizedCheckpointCreationCandidateV1 = z.infer<typeof SanitizedCheckpointCreationCandidateV1Schema>;

export const CheckpointRestoreConfirmationV1Schema = lazyZodSchema(() => z.strictObject({
  sourceChoiceConfirmed: z.optional(z.boolean()),
}));
export type CheckpointRestoreConfirmationV1 = z.infer<typeof CheckpointRestoreConfirmationV1Schema>;

export const SessionCheckpointRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: NonEmptyStringSchema,
  scopes: CheckpointScopesSchema,
  candidate: z.optional(CheckpointCreationCandidateRefV1Schema),
  timing: z._default(CheckpointTimingV1Schema, 'idle'),
  label: z.optional(NonEmptyStringSchema),
  confirmation: z.optional(CheckpointRestoreConfirmationV1Schema),
}).check(z.superRefine((request, ctx) => {
  if (request.candidate?.source === 'composed' && !exactlyPartitionsScopes(request.scopes, request.candidate.parts)) {
    ctx.addIssue({
      code: 'custom',
      message: 'SessionCheckpointRequestV1 composed candidate parts must exactly cover requested scopes',
      path: ['candidate', 'parts'],
    });
  }
})));
export type SessionCheckpointRequestV1 = z.infer<typeof SessionCheckpointRequestV1Schema>;

export const SessionRestoreRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: NonEmptyStringSchema,
  scopes: CheckpointScopesSchema,
  anchor: z.optional(CheckpointRestoreAnchorV1Schema),
  candidate: z.optional(CheckpointCandidateRefV1Schema),
  confirmation: z.optional(CheckpointRestoreConfirmationV1Schema),
}).check(z.superRefine((request, ctx) => {
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
})));
export type SessionRestoreRequestV1 = z.infer<typeof SessionRestoreRequestV1Schema>;

export const CheckpointFailedScopeV1Schema = lazyZodSchema(() => z.strictObject({
  scope: CheckpointRestoreScopeV1Schema,
  code: NonEmptyStringSchema,
  message: z.optional(NonEmptyStringSchema),
}));
export type CheckpointFailedScopeV1 = z.infer<typeof CheckpointFailedScopeV1Schema>;

export const CheckpointOperationReceiptV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  operation: z.enum(['checkpoint', 'restore']),
  phase: z.enum(['started', 'succeeded', 'partially_succeeded', 'failed']),
  lifecycleId: NonEmptyStringSchema,
  source: CheckpointRestoreSourceV1Schema,
  scopes: CheckpointScopesSchema,
  candidate: z.optional(SanitizedCheckpointCandidateRefV1Schema),
  restoredScopes: z.optional(CheckpointScopesSchema),
  failedScopes: z.optional(z.array(CheckpointFailedScopeV1Schema)),
}));
export type CheckpointOperationReceiptV1 = z.infer<typeof CheckpointOperationReceiptV1Schema>;

export const SessionCheckpointResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    status: z.enum(['succeeded', 'partially_succeeded']),
    source: CheckpointRestoreSourceV1Schema,
    checkpointRef: z.optional(NonEmptyStringSchema),
    receipts: z.array(CheckpointOperationReceiptV1Schema),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.enum([
      'source_choice_required',
      'checkpoint_source_unavailable',
      'session_not_idle',
      'checkpoint_failed',
      'confirmation_required',
      'invalid_request',
    ]),
    error: z.optional(NonEmptyStringSchema),
    candidates: z.optional(z.array(SanitizedCheckpointCreationCandidateV1Schema)),
    receipts: z.optional(z.array(CheckpointOperationReceiptV1Schema)),
  }),
]));
export type SessionCheckpointResultV1 = z.infer<typeof SessionCheckpointResultV1Schema>;

export const SessionRestoreResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    status: z.enum(['succeeded', 'partially_succeeded']),
    source: CheckpointRestoreSourceV1Schema,
    restoredScopes: CheckpointScopesSchema,
    failedScopes: z.optional(z.array(CheckpointFailedScopeV1Schema)),
    receipts: z.array(CheckpointOperationReceiptV1Schema),
  }),
  z.strictObject({
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
    error: z.optional(NonEmptyStringSchema),
    candidates: z.optional(z.array(SanitizedCheckpointRestoreCandidateV1Schema)),
    receipts: z.optional(z.array(CheckpointOperationReceiptV1Schema)),
  }),
]));
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
