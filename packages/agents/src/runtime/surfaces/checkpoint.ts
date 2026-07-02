import { z } from 'zod';

import type { BackendSurfaceAvailabilityV1 } from '@happier-dev/protocol';

import type { MaybePromise } from '../engine/contracts.js';
import type {
  BackendSurfaceDiagnosticV1,
  BackendSurfaceOperationReceiptV1,
} from './primitives.js';

export type CheckpointRestoreScopeV1 =
  | 'conversation'
  | 'workspace';

export type CheckpointTimingV1 =
  | 'idle'
  | 'activeTurn';

export type CheckpointRestoreAnchorEvidenceV1 = Readonly<{
  turnId?: string;
  messageSeq?: number;
  seqRange?: Readonly<{
    startSeqInclusive: number;
    endSeqInclusive: number;
  }>;
}>;

export type CheckpointRestoreAnchorV1 = Readonly<{
  kind: 'before_user_message';
  messageId: string;
  evidence?: CheckpointRestoreAnchorEvidenceV1;
}>;

export type CheckpointProviderTargetRefV1 =
  | Readonly<{ kind: 'provider_checkpoint'; checkpointId: string }>
  | Readonly<{ kind: 'provider_message'; messageId: string }>
  | Readonly<{ kind: 'provider_turn'; turnId: string }>
  | Readonly<{ kind: 'provider_restore_token'; token: string }>;

export type CheckpointDescriptorV1 = Readonly<{
  id: string;
  target: CheckpointProviderTargetRefV1;
  createdAt?: string;
  label?: string;
  timing: CheckpointTimingV1;
  checkpointScopes: readonly CheckpointRestoreScopeV1[];
  checkpointCombinations?: readonly (readonly CheckpointRestoreScopeV1[])[];
  restoreScopes: readonly CheckpointRestoreScopeV1[];
  restoreCombinations?: readonly (readonly CheckpointRestoreScopeV1[])[];
  partialRestore?: 'unsupported' | 'supported';
}>;

export type CheckpointAvailabilityOperationV1 =
  | 'list'
  | 'resolveRestoreTarget'
  | 'checkpoint'
  | 'restore';

export type CheckpointAvailabilityRequestV1 = Readonly<{
  operation: CheckpointAvailabilityOperationV1;
  sessionId: string;
  anchor?: CheckpointRestoreAnchorV1;
  target?: CheckpointProviderTargetRefV1;
  scopes?: readonly CheckpointRestoreScopeV1[];
  timing?: CheckpointTimingV1;
}>;

export type ListCheckpointsRequestV1 = Readonly<{
  sessionId: string;
  timing?: CheckpointTimingV1;
}>;

export type ResolveCheckpointRestoreTargetRequestV1 = Readonly<{
  sessionId: string;
  anchor: CheckpointRestoreAnchorV1;
  scopes: readonly CheckpointRestoreScopeV1[];
}>;

export type CreateCheckpointRequestV1 = Readonly<{
  operationId?: string;
  sessionId: string;
  scopes: readonly CheckpointRestoreScopeV1[];
  timing: CheckpointTimingV1;
  label?: string;
  signal?: AbortSignal;
}>;

export type RestoreCheckpointByAnchorRequestV1 = Readonly<{
  operationId?: string;
  sessionId: string;
  anchor: CheckpointRestoreAnchorV1;
  target?: never;
  scopes: readonly CheckpointRestoreScopeV1[];
  signal?: AbortSignal;
}>;

export type RestoreCheckpointByTargetRequestV1 = Readonly<{
  operationId?: string;
  sessionId: string;
  anchor?: never;
  target: CheckpointProviderTargetRefV1;
  scopes: readonly CheckpointRestoreScopeV1[];
  signal?: AbortSignal;
}>;

export type RestoreCheckpointRequestV1 =
  | RestoreCheckpointByAnchorRequestV1
  | RestoreCheckpointByTargetRequestV1;

export type RestoreCheckpointFailureCodeV1 =
  | 'checkpoint_not_found'
  | 'restore_target_stale'
  | 'scope_not_supported'
  | 'restore_failed';

export type RestoreCheckpointResultV1 =
  | Readonly<{
      ok: true;
      outcome: 'completed' | 'partial';
      restoredScopes: readonly CheckpointRestoreScopeV1[];
      failedScopes?: readonly Readonly<{
        scope: CheckpointRestoreScopeV1;
        code: RestoreCheckpointFailureCodeV1;
        message?: string;
      }>[];
      receipt?: BackendSurfaceOperationReceiptV1;
      diagnostics?: readonly BackendSurfaceDiagnosticV1[];
    }>
  | Readonly<{
      ok: false;
      code: RestoreCheckpointFailureCodeV1;
      message?: string;
      retryable?: boolean;
      receipt?: BackendSurfaceOperationReceiptV1;
      diagnostics?: readonly BackendSurfaceDiagnosticV1[];
    }>;

export type CheckpointSurfaceV1 = Readonly<{
  evaluateAvailability?: (request: CheckpointAvailabilityRequestV1) => MaybePromise<BackendSurfaceAvailabilityV1>;
  list?: (request: ListCheckpointsRequestV1) => MaybePromise<readonly CheckpointDescriptorV1[]>;
  resolveRestoreTarget?: (request: ResolveCheckpointRestoreTargetRequestV1) => MaybePromise<CheckpointProviderTargetRefV1 | null>;
  checkpoint?: (request: CreateCheckpointRequestV1) => MaybePromise<CheckpointDescriptorV1>;
  restore?: (request: RestoreCheckpointRequestV1) => MaybePromise<RestoreCheckpointResultV1>;
}>;

const NonEmptyStringSchema = z.string().trim().min(1);
const CheckpointRestoreScopeV1Schema = z.enum(['conversation', 'workspace']);
const CheckpointTimingV1Schema = z.enum(['idle', 'activeTurn']);

const AbortSignalLikeSchema = z.custom<AbortSignal>((value) => {
  if (value === undefined) {
    return true;
  }
  return !!value
    && typeof value === 'object'
    && 'aborted' in value
    && typeof (value as { aborted?: unknown }).aborted === 'boolean';
});

export const CheckpointRestoreAnchorEvidenceV1Schema = z.object({
  turnId: NonEmptyStringSchema.optional(),
  messageSeq: z.number().int().nonnegative().optional(),
  seqRange: z.object({
    startSeqInclusive: z.number().int().nonnegative(),
    endSeqInclusive: z.number().int().nonnegative(),
  }).strict().readonly().optional(),
}).strict();

export const CheckpointRestoreAnchorV1Schema = z.object({
  kind: z.literal('before_user_message'),
  messageId: NonEmptyStringSchema,
  evidence: CheckpointRestoreAnchorEvidenceV1Schema.optional(),
}).strict();

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
}).readonly();

export const CheckpointAvailabilityRequestV1Schema = z.object({
  operation: z.enum(['list', 'resolveRestoreTarget', 'checkpoint', 'restore']),
  sessionId: NonEmptyStringSchema,
  anchor: CheckpointRestoreAnchorV1Schema.optional(),
  target: CheckpointProviderTargetRefV1Schema.optional(),
  scopes: CheckpointScopesSchema.optional(),
  timing: CheckpointTimingV1Schema.optional(),
}).strict().superRefine((request, ctx) => {
  if (request.operation === 'resolveRestoreTarget' && !request.anchor) {
    ctx.addIssue({
      code: 'custom',
      message: 'CheckpointAvailabilityRequestV1 resolveRestoreTarget requires anchor',
      path: ['anchor'],
    });
  }
  if (request.operation === 'restore') {
    const semanticSources = Number(request.anchor !== undefined) + Number(request.target !== undefined);
    if (semanticSources !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'CheckpointAvailabilityRequestV1 restore requires exactly one of anchor or target',
        path: ['anchor'],
      });
    }
  }
});

export const ResolveCheckpointRestoreTargetRequestV1Schema = z.object({
  sessionId: NonEmptyStringSchema,
  anchor: CheckpointRestoreAnchorV1Schema,
  scopes: CheckpointScopesSchema,
}).strict();

export const CreateCheckpointRequestV1Schema = z.object({
  operationId: NonEmptyStringSchema.optional(),
  sessionId: NonEmptyStringSchema,
  scopes: CheckpointScopesSchema,
  timing: CheckpointTimingV1Schema,
  label: NonEmptyStringSchema.optional(),
  signal: AbortSignalLikeSchema.optional(),
}).strict();

export const RestoreCheckpointRequestV1Schema = z.object({
  operationId: NonEmptyStringSchema.optional(),
  sessionId: NonEmptyStringSchema,
  anchor: CheckpointRestoreAnchorV1Schema.optional(),
  target: CheckpointProviderTargetRefV1Schema.optional(),
  scopes: CheckpointScopesSchema,
  signal: AbortSignalLikeSchema.optional(),
}).strict().superRefine((request, ctx) => {
  const semanticSources = Number(request.anchor !== undefined) + Number(request.target !== undefined);
  if (semanticSources !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'RestoreCheckpointRequestV1 must provide exactly one of anchor or target',
      path: ['anchor'],
    });
  }
});

function formatCheckpointSchemaIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'request';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function parseCheckpointRequest<T>(params: Readonly<{
  label: string;
  schema: z.ZodType<T>;
  input: unknown;
}>): T {
  const parsed = params.schema.safeParse(params.input);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(`${params.label} is invalid: ${formatCheckpointSchemaIssues(parsed.error.issues)}`);
}

export function parseCheckpointAvailabilityRequestV1(input: unknown): CheckpointAvailabilityRequestV1 {
  return parseCheckpointRequest({
    label: 'CheckpointAvailabilityRequestV1',
    schema: CheckpointAvailabilityRequestV1Schema,
    input,
  });
}

export function parseResolveCheckpointRestoreTargetRequestV1(
  input: unknown,
): ResolveCheckpointRestoreTargetRequestV1 {
  return parseCheckpointRequest({
    label: 'ResolveCheckpointRestoreTargetRequestV1',
    schema: ResolveCheckpointRestoreTargetRequestV1Schema,
    input,
  });
}

export function parseCreateCheckpointRequestV1(input: unknown): CreateCheckpointRequestV1 {
  return parseCheckpointRequest({
    label: 'CreateCheckpointRequestV1',
    schema: CreateCheckpointRequestV1Schema,
    input,
  });
}

export function parseRestoreCheckpointRequestV1(input: unknown): RestoreCheckpointRequestV1 {
  return parseCheckpointRequest({
    label: 'RestoreCheckpointRequestV1',
    schema: RestoreCheckpointRequestV1Schema as z.ZodType<RestoreCheckpointRequestV1>,
    input,
  });
}
