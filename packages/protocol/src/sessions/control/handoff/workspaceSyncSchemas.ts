import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { HandoffTargetReplacementApprovalV1Schema } from './handoffTargetReplacementApprovalV1.js';

const MAX_RELATIONSHIP_ID_LENGTH = 256;
const MAX_MACHINE_ID_LENGTH = 256;
const MAX_WORKSPACE_REF_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
export const WORKSPACE_SYNC_MAX_PATTERN_BYTES = 1024;
export const WORKSPACE_SYNC_MAX_PATTERNS = 128;
const MAX_ERROR_CODE_LENGTH = 256;
const MAX_CONFLICTS = 1_000;
export const WORKSPACE_SYNC_CONFLICT_PAGE_MAX_ITEMS = 100;
export const WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES = 1024 * 1024;

export const WorkspaceSyncModeV1Schema = lazyZodSchema(() => z.enum([
  'copy_once',
  'keep_synced',
  'mirror_exactly',
  'keep_both_in_sync',
]));
export type WorkspaceSyncModeV1 = z.infer<typeof WorkspaceSyncModeV1Schema>;

export const WorkspaceSyncPersistentModeV1Schema = lazyZodSchema(() => z.enum([
  'keep_synced',
  'mirror_exactly',
  'keep_both_in_sync',
]));
export type WorkspaceSyncPersistentModeV1 = z.infer<typeof WorkspaceSyncPersistentModeV1Schema>;

const WorkspaceContentPolicyV1FieldsSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  selection: z.enum(['git_worktree', 'all_files']),
  extraIgnorePatterns: z.array(z.string().trim().min(1).max(WORKSPACE_SYNC_MAX_PATTERN_BYTES)
    .refine((value) => utf8ToBytes(value).byteLength <= WORKSPACE_SYNC_MAX_PATTERN_BYTES, 'pattern exceeds UTF-8 byte limit')).max(WORKSPACE_SYNC_MAX_PATTERNS).readonly(),
  extraIncludePatterns: z.array(z.string().trim().min(1).max(WORKSPACE_SYNC_MAX_PATTERN_BYTES)
    .refine((value) => utf8ToBytes(value).byteLength <= WORKSPACE_SYNC_MAX_PATTERN_BYTES, 'pattern exceeds UTF-8 byte limit')
    .refine((value) => !value.startsWith('!'), 'include patterns must be positive')).max(WORKSPACE_SYNC_MAX_PATTERNS).readonly(),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict());
export const WorkspaceContentPolicyV1Schema = lazyZodSchema(() => WorkspaceContentPolicyV1FieldsSchema.superRefine((value, context) => {
  if (value.policyDigest !== computeWorkspaceSyncPolicyDigest(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['policyDigest'], message: 'policyDigest does not match content policy' });
  }
}));
export type WorkspaceContentPolicyV1 = z.infer<typeof WorkspaceContentPolicyV1Schema>;

/**
 * Computes the stable policy fingerprint shared by UI, daemon and sidecar
 * boundaries.  Keep the canonical field order here so callers never invent a
 * second digest representation.
 */
export function computeWorkspaceSyncPolicyDigest(
  policy: Omit<WorkspaceContentPolicyV1, 'policyDigest'>,
): string {
  const canonical = JSON.stringify({
    v: 1,
    selection: policy.selection,
    // Git ignore rules are ordered: a later negation can re-include a path.
    // Preserve that order so semantically different policies never share an
    // authorization/endpoint fingerprint.
    extraIgnorePatterns: [...policy.extraIgnorePatterns],
    extraIncludePatterns: [...policy.extraIncludePatterns],
  });
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

export const WorkspaceSyncRelationshipV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
    controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
    alphaWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
    betaWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
    mode: WorkspaceSyncPersistentModeV1Schema,
    contentPolicy: WorkspaceContentPolicyV1Schema,
    enabled: z.boolean(),
    createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.alphaWorkspaceRefId === value.betaWorkspaceRefId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['betaWorkspaceRefId'],
        message: 'alphaWorkspaceRefId and betaWorkspaceRefId must be distinct',
      });
    }
  }));
export type WorkspaceSyncRelationshipV1 = z.infer<typeof WorkspaceSyncRelationshipV1Schema>;

type WorkspaceSyncRelationshipDefinitionV1 = Pick<
  WorkspaceSyncRelationshipV1,
  | 'controllerMachineId'
  | 'alphaWorkspaceRefId'
  | 'betaWorkspaceRefId'
  | 'mode'
  | 'contentPolicy'
>;

/**
 * Compares the immutable runtime definition selected by a relationship ID.
 * Settings lifecycle metadata (`enabled` and timestamps) is deliberately not
 * part of Mutagen session identity; content policy identity is its canonical
 * digest rather than another serialization of the policy document.
 */
export function areWorkspaceSyncRelationshipDefinitionsEqual(
  left: WorkspaceSyncRelationshipDefinitionV1,
  right: WorkspaceSyncRelationshipDefinitionV1,
): boolean {
  return left.controllerMachineId === right.controllerMachineId
    && left.alphaWorkspaceRefId === right.alphaWorkspaceRefId
    && left.betaWorkspaceRefId === right.betaWorkspaceRefId
    && left.mode === right.mode
    && left.contentPolicy.policyDigest === right.contentPolicy.policyDigest;
}

export const WorkspaceSyncCopyOnceV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  operationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  alphaWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  betaWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  contentPolicy: WorkspaceContentPolicyV1Schema,
}).strict().superRefine((value, context) => {
  if (value.alphaWorkspaceRefId === value.betaWorkspaceRefId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['betaWorkspaceRefId'],
      message: 'alphaWorkspaceRefId and betaWorkspaceRefId must be distinct',
    });
  }
}));
export type WorkspaceSyncCopyOnceV1 = z.infer<typeof WorkspaceSyncCopyOnceV1Schema>;

export const WorkspaceSyncEndpointEntryKindV1Schema = lazyZodSchema(() => z.enum(['missing', 'file', 'directory', 'symlink']));
export type WorkspaceSyncEndpointEntryKindV1 = z.infer<typeof WorkspaceSyncEndpointEntryKindV1Schema>;

const WorkspaceSyncConflictEndpointEntryKindV1Schema = lazyZodSchema(() => z.enum([
  ...WorkspaceSyncEndpointEntryKindV1Schema.options,
  'unsupported',
]));
const WorkspaceSyncUnsupportedEntrySourceKindV1Schema = lazyZodSchema(() => z.enum(['untracked', 'problematic', 'unknown']));

// Mutagen synchronization v1 hashes file content with SHA-1 and exposes the
// raw 20-byte digest as lowercase hexadecimal at the broker boundary.
const WorkspaceSyncFileDigestV1Schema = lazyZodSchema(() => z.string().regex(/^[a-f0-9]{40}$/u));
const WorkspaceSyncDirectoryFingerprintV1Schema = lazyZodSchema(() => z.string().regex(/^[a-f0-9]{64}$/u));

/**
 * An engine-relative path is identity-bearing data, not display/user input.
 * Preserve its bytes exactly. Forward slash is the cross-platform engine
 * separator; the target filesystem owner applies any additional native rules
 * (notably Windows backslash separators and volume/ADS rejection).
 */
const WorkspaceSyncRelativePathV1Schema = lazyZodSchema(() => z.string().min(1).max(MAX_PATH_LENGTH).superRefine((value, context) => {
  const components = value.split('/');
  if (
    value.includes('\0')
    || value.startsWith('/')
    || components.some((component) => component === '' || component === '.' || component === '..')
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'workspace sync path must identify a safe root-relative descendant',
    });
  }
}));

const WorkspaceSyncConflictEndpointV1Schema = lazyZodSchema(() => z.object({
  kind: WorkspaceSyncConflictEndpointEntryKindV1Schema,
  digest: WorkspaceSyncFileDigestV1Schema.optional(),
  size: z.number().int().nonnegative().optional(),
  sourceKind: WorkspaceSyncUnsupportedEntrySourceKindV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'unsupported' && value.sourceKind === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceKind'],
      message: 'unsupported conflict entries require their bounded engine source kind',
    });
  } else if (value.kind !== 'unsupported' && value.sourceKind !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceKind'],
      message: 'supported conflict entries cannot carry an unsupported source kind',
    });
  }
  if (value.kind === 'unsupported' && (value.digest !== undefined || value.size !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'unsupported conflict entries cannot claim file metadata',
    });
  }
}));

export const WorkspaceSyncConflictV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  path: WorkspaceSyncRelativePathV1Schema,
  alpha: WorkspaceSyncConflictEndpointV1Schema,
  beta: WorkspaceSyncConflictEndpointV1Schema,
}).strict());
export type WorkspaceSyncConflictV1 = z.infer<typeof WorkspaceSyncConflictV1Schema>;

export const WorkspaceSyncConflictListV1Schema = lazyZodSchema(() => z
  .object({
    relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
    totalCount: z.number().int().nonnegative(),
    shownCount: z.number().int().nonnegative(),
    truncatedCount: z.number().int().nonnegative(),
    conflicts: z.array(WorkspaceSyncConflictV1Schema).max(MAX_CONFLICTS).readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.shownCount !== value.conflicts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shownCount'],
        message: 'shownCount must equal conflicts.length',
      });
    }
    if (value.totalCount < value.shownCount || value.truncatedCount !== value.totalCount - value.shownCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['truncatedCount'],
        message: 'truncatedCount must equal totalCount minus shownCount',
      });
    }
    for (const [index, conflict] of value.conflicts.entries()) {
      if (conflict.relationshipId !== value.relationshipId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conflicts', index, 'relationshipId'],
          message: 'conflict relationshipId must match the list relationshipId',
        });
      }
    }
  }));
export type WorkspaceSyncConflictListV1 = z.infer<typeof WorkspaceSyncConflictListV1Schema>;

export const WorkspaceSyncConflictPageRequestV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  cursor: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH).optional(),
  limit: z.number().int().positive().max(WORKSPACE_SYNC_CONFLICT_PAGE_MAX_ITEMS),
}).strict());
export type WorkspaceSyncConflictPageRequestV1 = z.infer<typeof WorkspaceSyncConflictPageRequestV1Schema>;

const WorkspaceSyncConflictPageDataV1Schema = lazyZodSchema(() => z.object({
  status: z.literal('page'),
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  totalCount: z.number().int().nonnegative(),
  nextCursor: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH).nullable(),
  conflicts: z.array(WorkspaceSyncConflictV1Schema).max(WORKSPACE_SYNC_CONFLICT_PAGE_MAX_ITEMS).readonly(),
}).strict().superRefine((value, context) => {
  if (value.totalCount < value.conflicts.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalCount'],
      message: 'totalCount must be at least conflicts.length',
    });
  }
  for (const [index, conflict] of value.conflicts.entries()) {
    if (conflict.relationshipId !== value.relationshipId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conflicts', index, 'relationshipId'],
        message: 'conflict relationshipId must match the page relationshipId',
      });
    }
  }
}));

export const WorkspaceSyncConflictPageV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  WorkspaceSyncConflictPageDataV1Schema,
  z.object({
    status: z.literal('cursor_invalidated'),
    relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  }).strict(),
]));
export type WorkspaceSyncConflictPageV1 = z.infer<typeof WorkspaceSyncConflictPageV1Schema>;

/**
 * Complete, effect-authorizing observation of one confined workspace entry.
 * Preview availability is intentionally absent: display bounds never weaken the
 * identity that a reviewed resolution approves.
 */
export const WorkspaceSyncEntryExpectationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing') }).strict(),
  z.object({
    kind: z.literal('file'),
    digest: WorkspaceSyncFileDigestV1Schema,
    executable: z.boolean(),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    kind: z.literal('symlink'),
    target: z.string().max(MAX_PATH_LENGTH),
  }).strict(),
  z.object({
    kind: z.literal('directory'),
    fingerprint: WorkspaceSyncDirectoryFingerprintV1Schema,
  }).strict(),
]));
export type WorkspaceSyncEntryExpectationV1 = z.infer<typeof WorkspaceSyncEntryExpectationV1Schema>;

const WorkspaceSyncResolutionEndpointV1Schema = lazyZodSchema(() => z.object({
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  expected: WorkspaceSyncEntryExpectationV1Schema,
}).strict());

const WorkspaceSyncConflictResolutionBaseV1Schema = lazyZodSchema(() => z.object({
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  hubWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  path: WorkspaceSyncRelativePathV1Schema,
  source: WorkspaceSyncResolutionEndpointV1Schema,
  targets: z.array(WorkspaceSyncResolutionEndpointV1Schema).min(1).readonly(),
  relationshipIds: z.array(z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH)).min(1).readonly(),
}));

export const WorkspaceSyncConflictResolutionV1Schema = lazyZodSchema(() => z.discriminatedUnion('strategy', [
  WorkspaceSyncConflictResolutionBaseV1Schema.extend({ strategy: z.literal('use_source') }).strict(),
  WorkspaceSyncConflictResolutionBaseV1Schema.extend({
    strategy: z.literal('keep_both'),
    alternatives: z.array(z.object({
      source: WorkspaceSyncResolutionEndpointV1Schema,
      destination: z.object({
        workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
        path: WorkspaceSyncRelativePathV1Schema,
        expected: WorkspaceSyncEntryExpectationV1Schema,
      }).strict(),
      consequence: z.object({
        propagatingToWorkspaceRefIds: z.array(z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH)).readonly(),
        unverifiedPropagationToWorkspaceRefIds: z.array(z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH)).readonly().optional(),
      }).strict(),
    }).strict()).min(1).readonly(),
  }).strict(),
]));
export type WorkspaceSyncConflictResolutionV1 = z.infer<typeof WorkspaceSyncConflictResolutionV1Schema>;

/** Fixed, native-safe identity for one captured source or confined destination effect. */
export function deriveWorkspaceSyncConflictOperationId(input: Readonly<{
  actionReceiptId: string;
  kind: 'capture' | 'selected' | 'alternative';
  workspaceRefId: string;
  path: string;
  alternativeIndex?: number;
}>): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([
    'workspace-sync-conflict-effect-v1',
    input.actionReceiptId,
    input.kind,
    input.workspaceRefId,
    input.path,
    input.alternativeIndex ?? null,
  ]))));
}

/** Deterministic same-parent names; the compact form also fits long basenames. */
export function deriveWorkspaceSyncConflictAsidePaths(
  relativePath: string,
  file: Extract<WorkspaceSyncEntryExpectationV1, { kind: 'file' }>,
): readonly [string, string] {
  WorkspaceSyncRelativePathV1Schema.parse(relativePath);
  const components = relativePath.split('/');
  const basename = components.pop()!;
  const parent = components.length > 0 ? `${components.join('/')}/` : '';
  const content = `${file.digest}${file.executable ? '-x' : ''}`;
  const pathKey = bytesToHex(sha256(utf8ToBytes(relativePath))).slice(0, 16);
  const portableName = (normal: string, compact: string): string =>
    utf8ToBytes(normal).length <= 255 ? normal : compact;
  const primary = portableName(
    `${basename}.happier-conflict.${content}`,
    `happier-conflict-${pathKey}.${content}`,
  );
  const alternative = portableName(
    `${basename}.happier-conflict.${content}.alternate`,
    `happier-conflict-${pathKey}.${content}.alternate`,
  );
  const paths = [`${parent}${primary}`, `${parent}${alternative}`] as const;
  for (const path of paths) WorkspaceSyncRelativePathV1Schema.parse(path);
  return paths;
}

export const WorkspaceSyncConflictResolutionEndpointResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH), status: z.literal('applied') }).strict(),
  z.object({ workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH), status: z.literal('applied_paused') }).strict(),
  z.object({ workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH), status: z.literal('changed') }).strict(),
  z.object({ workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH), status: z.literal('offline') }).strict(),
  z.object({ workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH), status: z.literal('cancelled') }).strict(),
  z.object({ workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH), status: z.literal('unknown') }).strict(),
  z.object({
    workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
    status: z.literal('failed'),
    errorCode: z.string().trim().min(1).max(MAX_ERROR_CODE_LENGTH),
  }).strict(),
  z.object({
    workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
    status: z.literal('recovery_needed'),
    recoveryPath: z.string().min(1).max(MAX_PATH_LENGTH),
  }).strict(),
]));
export type WorkspaceSyncConflictResolutionEndpointResultV1 = z.infer<typeof WorkspaceSyncConflictResolutionEndpointResultV1Schema>;

export const WorkspaceSyncConflictResolutionResultV1Schema = lazyZodSchema(() => z.object({
  endpoints: z.array(WorkspaceSyncConflictResolutionEndpointResultV1Schema).min(1).readonly(),
  preserved: z.array(z.object({
    alternativeIndex: z.number().int().nonnegative(),
    sourceWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
    destinationWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
    path: WorkspaceSyncRelativePathV1Schema,
    propagatingToWorkspaceRefIds: z.array(z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH)).readonly(),
    unverifiedPropagationToWorkspaceRefIds: z.array(z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH)).readonly().optional(),
    outcome: z.discriminatedUnion('status', [
      z.object({ status: z.literal('preserved') }).strict(),
      z.object({ status: z.literal('already_present') }).strict(),
      z.object({ status: z.literal('not_started') }).strict(),
      z.object({ status: z.literal('changed') }).strict(),
      z.object({ status: z.literal('offline') }).strict(),
      z.object({ status: z.literal('cancelled') }).strict(),
      z.object({ status: z.literal('unknown') }).strict(),
      z.object({ status: z.literal('failed'), errorCode: z.string().trim().min(1).max(MAX_ERROR_CODE_LENGTH) }).strict(),
      z.object({ status: z.literal('recovery_needed'), recoveryPath: z.string().min(1).max(MAX_PATH_LENGTH) }).strict(),
    ]),
  }).strict()).readonly().optional(),
}).strict());
export type WorkspaceSyncConflictResolutionResultV1 = z.infer<typeof WorkspaceSyncConflictResolutionResultV1Schema>;

/**
 * One relationship conflict page at a time through the exact controller. The
 * existing opaque cursor and bounds are preserved; no aggregate global
 * cursor or unbounded fan-out is representable.
 */
export const WorkspaceSyncConflictsListActionInputV1Schema = lazyZodSchema(() => z.object({
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  cursor: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH).optional(),
  limit: z.number().int().positive().max(WORKSPACE_SYNC_CONFLICT_PAGE_MAX_ITEMS),
}).strict());
export type WorkspaceSyncConflictsListActionInputV1 = z.infer<typeof WorkspaceSyncConflictsListActionInputV1Schema>;

/**
 * Action-owned destructive intent. Binding the controller machine into the
 * approved subject prevents an otherwise valid receipt from being replayed
 * against a different controller placement.
 */
export const WorkspaceSyncConflictResolveActionInputV1Schema = WorkspaceSyncConflictResolutionV1Schema;
export type WorkspaceSyncConflictResolveActionInputV1 = z.infer<typeof WorkspaceSyncConflictResolveActionInputV1Schema>;

/**
 * Private controller-daemon carrier for an already approved conflict Action.
 * The receipt and its exact Action subject travel together so the daemon can
 * revalidate the persisted approval before performing the destructive write.
 */
export const WorkspaceSyncConflictResolveRpcInputV1Schema = lazyZodSchema(() => z.object({
  actionReceiptId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  actionInput: WorkspaceSyncConflictResolveActionInputV1Schema,
}).strict());
export type WorkspaceSyncConflictResolveRpcInputV1 = z.infer<typeof WorkspaceSyncConflictResolveRpcInputV1Schema>;

export const WorkspaceSyncRelationshipIdV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
}).strict());
export type WorkspaceSyncRelationshipIdV1 = z.infer<typeof WorkspaceSyncRelationshipIdV1Schema>;

/** Private two-phase target effect: transfer/capture settles before engine pause. */
export const WorkspaceSyncTargetConflictStageV1Schema = lazyZodSchema(() => z.object({
  actionReceiptId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  actionInput: WorkspaceSyncConflictResolveActionInputV1Schema,
  operationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  alternativeIndex: z.number().int().nonnegative().nullable().default(null),
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  sourceRelationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  sourceMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  sourceWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  sourceExpected: WorkspaceSyncEntryExpectationV1Schema,
  targetMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  targetWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  targetExpected: WorkspaceSyncEntryExpectationV1Schema,
  path: WorkspaceSyncRelativePathV1Schema,
}).strict());
export type WorkspaceSyncTargetConflictStageV1 = z.infer<typeof WorkspaceSyncTargetConflictStageV1Schema>;

/** Release private source material after every reviewed destination has staged or failed. */
export const WorkspaceSyncConflictCaptureReleaseV1Schema = lazyZodSchema(() => z.object({
  actionReceiptId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  actionInput: WorkspaceSyncConflictResolveActionInputV1Schema,
  operationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  sourceMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  sourceWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
}).strict());
export type WorkspaceSyncConflictCaptureReleaseV1 = z.infer<typeof WorkspaceSyncConflictCaptureReleaseV1Schema>;

export const WorkspaceSyncTargetConflictApplyV1Schema = lazyZodSchema(() => z.object({
  actionReceiptId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  actionInput: WorkspaceSyncConflictResolveActionInputV1Schema,
  operationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  alternativeIndex: z.number().int().nonnegative().nullable().default(null),
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  targetMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  targetWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  path: WorkspaceSyncRelativePathV1Schema,
}).strict());
export type WorkspaceSyncTargetConflictApplyV1 = z.infer<typeof WorkspaceSyncTargetConflictApplyV1Schema>;

export const WorkspaceSyncTargetConflictApplyResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('installed') }).strict(),
  z.object({ status: z.literal('restored') }).strict(),
  z.object({ status: z.literal('recovery_needed'), recoveryPath: z.string().min(1).max(MAX_PATH_LENGTH) }).strict(),
]));
export type WorkspaceSyncTargetConflictApplyResultV1 = z.infer<typeof WorkspaceSyncTargetConflictApplyResultV1Schema>;

/** Reconcile retained confined replacement evidence before a touching engine runs. */
export const WorkspaceSyncTargetConflictRecoverV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  targetMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  targetWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
}).strict());
export type WorkspaceSyncTargetConflictRecoverV1 = z.infer<typeof WorkspaceSyncTargetConflictRecoverV1Schema>;

export const WorkspaceSyncTargetConflictRecoverResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('settled') }).strict(),
  z.object({ status: z.literal('recovery_needed'), recoveryPath: z.string().min(1).max(MAX_PATH_LENGTH) }).strict(),
]));
export type WorkspaceSyncTargetConflictRecoverResultV1 = z.infer<typeof WorkspaceSyncTargetConflictRecoverResultV1Schema>;

export const ReadWorkspaceSyncFileV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  side: z.enum(['alpha', 'beta']),
  path: WorkspaceSyncRelativePathV1Schema,
  expectedDigest: WorkspaceSyncFileDigestV1Schema.optional(),
  maxBytes: z.number().int().positive().max(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES)
    .default(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES),
}).strict());
export type ReadWorkspaceSyncFileV1 = z.infer<typeof ReadWorkspaceSyncFileV1Schema>;

/**
 * Target-daemon preview request. The selected side is resolved by the
 * controller before forwarding, and the receiving daemon resolves this
 * workspace reference from its current Account settings. A caller-controlled
 * filesystem root is deliberately absent.
 */
const WorkspaceSyncHexDigestV1Schema = lazyZodSchema(() => z.string().regex(/^[a-f0-9]{64}$/u));

export const WorkspaceSyncTargetBootstrapOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('relationship'),
    relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  }).strict(),
  z.object({
    kind: z.literal('copy_once'),
    operation: WorkspaceSyncCopyOnceV1Schema,
  }).strict(),
]));
export type WorkspaceSyncTargetBootstrapOwnerV1 = z.infer<typeof WorkspaceSyncTargetBootstrapOwnerV1Schema>;

export const HandoffTargetReplacementPreflightV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  serverId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  machineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  operationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  targetPath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  /**
   * Whether this operation activates exact mirroring, which authorizes deleting
   * target-only files later even when the destination is missing or empty now.
   */
  activatesExactMirror: z.boolean().optional(),
  /**
   * What this operation will do with contents already in the destination. The
   * target daemon's bootstrap owner only replaces them for source
   * materialization, so an omitted value keeps that original meaning and an
   * explicit `use_existing` must not raise a replacement consequence. An old
   * daemon rejects the unknown field outright rather than silently answering
   * for a different intent.
   */
  destinationIntent: z.enum(['use_existing', 'materialize_from_source_workspace']).optional(),
}).strict());
export type HandoffTargetReplacementPreflightV1 = z.infer<typeof HandoffTargetReplacementPreflightV1Schema>;

export const HandoffTargetReplacementPreflightResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('not_required') }).strict(),
  z.object({
    type: z.literal('approval_required'),
    approval: HandoffTargetReplacementApprovalV1Schema,
  }).strict(),
]));
export type HandoffTargetReplacementPreflightResultV1 = z.infer<typeof HandoffTargetReplacementPreflightResultV1Schema>;

/**
 * Target-daemon bootstrap prepare request. The receiving daemon resolves the
 * target root and bootstrap source root from its current Account settings; a
 * caller-supplied path, credential or grant is deliberately not representable.
 */
export const WorkspaceSyncTargetBootstrapPrepareV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  bootstrapOperationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  owner: WorkspaceSyncTargetBootstrapOwnerV1Schema,
  /**
   * Operation-scoped definition used only while a newly-created relationship
   * is being proven before its durable Account-settings commit.
   */
  transientRelationship: WorkspaceSyncRelationshipV1Schema.optional(),
  targetWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  endpointRole: z.enum(['alpha', 'beta']),
  policyDigest: WorkspaceSyncHexDigestV1Schema,
  createIfMissing: z.boolean(),
  /** Explicit only for a new copy/relationship target; existing relationships rehydrate READY custody. */
  targetBootstrap: z.enum(['use_existing', 'materialize_from_source_workspace']).optional(),
  /**
   * Host-private proof for the destructive consequences of this destination.
   * The target daemon derives the operation it must be stamped for from the
   * bootstrap owner it resolves locally, so no accompanying caller-supplied
   * operation field is carried here: a caller could align that field with a
   * stolen proof, which would make the binding prove nothing.
   */
  targetReplacementApproval: HandoffTargetReplacementApprovalV1Schema.optional(),
  /** Durable Protocol Action artifact authorizing the exact proof and input below. */
  targetReplacementApprovalReceiptId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH).optional(),
  /** Exact canonical approved Action input stored in the approving artifact. */
  targetReplacementApprovalActionInput: z.unknown().optional(),
}).strict().superRefine((value, context) => {
  const transient = value.transientRelationship;
  const createsTarget = (value.owner.kind === 'copy_once' && value.createIfMissing) || transient !== undefined;
  if (createsTarget !== (value.targetBootstrap !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetBootstrap'],
      message: createsTarget
        ? 'new workspace sync targets require an explicit bootstrap choice'
        : 'existing relationships cannot replace their established bootstrap choice',
    });
  }
  // A destination proof belongs to a new target's bootstrap decision. Source
  // materialization can replace existing contents, and exact mirroring
  // authorizes continuing target-only deletion through either intent, so both
  // spellings of a new target may carry one. An established relationship
  // rehydrating its READY custody still cannot.
  if (value.targetBootstrap === undefined && value.targetReplacementApproval !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetReplacementApproval'],
      message: 'destructive destination approval is valid only for a new target bootstrap',
    });
  }
  const replacementAuthorityParts = [
    value.targetReplacementApproval,
    value.targetReplacementApprovalReceiptId,
    value.targetReplacementApprovalActionInput,
  ];
  if (replacementAuthorityParts.some((part) => part !== undefined)
    && replacementAuthorityParts.some((part) => part === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetReplacementApprovalReceiptId'],
      message: 'target replacement approval requires its Action receipt and exact approved input',
    });
  }
  if (!transient) return;
  if (value.owner.kind !== 'relationship') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transientRelationship'],
      message: 'transient relationship authority requires a relationship owner',
    });
    return;
  }
  const expectedTargetRefId = value.endpointRole === 'alpha'
    ? transient.alphaWorkspaceRefId
    : transient.betaWorkspaceRefId;
  if (
    transient.relationshipId !== value.owner.relationshipId
    || transient.relationshipId !== value.bootstrapOperationId
    || transient.enabled !== true
    || value.targetWorkspaceRefId !== expectedTargetRefId
    || value.policyDigest !== transient.contentPolicy.policyDigest
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transientRelationship'],
      message: 'transient relationship does not match the exact bootstrap authority',
    });
  }
}));
export type WorkspaceSyncTargetBootstrapPrepareV1 = z.infer<typeof WorkspaceSyncTargetBootstrapPrepareV1Schema>;

/** Strict, root-free prepare result: authority fingerprints, never a local handle. */
export const WorkspaceSyncTargetBootstrapPrepareResultV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  bootstrapOperationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  targetWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  state: z.literal('ready'),
  created: z.boolean(),
  rootFingerprint: WorkspaceSyncHexDigestV1Schema,
  policyDigest: WorkspaceSyncHexDigestV1Schema,
}).strict());
export type WorkspaceSyncTargetBootstrapPrepareResultV1 = z.infer<typeof WorkspaceSyncTargetBootstrapPrepareResultV1Schema>;

export const WorkspaceSyncTargetBootstrapReleaseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  bootstrapOperationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  targetWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  reason: z.enum(['abort', 'copy_committed', 'relationship_committed']),
}).strict());
export type WorkspaceSyncTargetBootstrapReleaseV1 = z.infer<typeof WorkspaceSyncTargetBootstrapReleaseV1Schema>;

export const WorkspaceSyncTargetBootstrapReleaseResultV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  released: z.boolean(),
}).strict());
export type WorkspaceSyncTargetBootstrapReleaseResultV1 = z.infer<typeof WorkspaceSyncTargetBootstrapReleaseResultV1Schema>;

export const WorkspaceSyncTargetFileReadV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  path: WorkspaceSyncRelativePathV1Schema,
  expectedDigest: WorkspaceSyncFileDigestV1Schema.optional(),
  maxBytes: z.number().int().positive().max(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES)
    .default(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES),
}).strict());
export type WorkspaceSyncTargetFileReadV1 = z.infer<typeof WorkspaceSyncTargetFileReadV1Schema>;

const WorkspaceSyncFileSizeV1Schema = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

export const ReadWorkspaceSyncFileResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({
    status: z.literal('text'),
    text: z.string().max(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES),
    digest: WorkspaceSyncFileDigestV1Schema,
    size: WorkspaceSyncFileSizeV1Schema,
  }).strict(),
  z.object({
    status: z.literal('binary'),
    digest: WorkspaceSyncFileDigestV1Schema,
    size: WorkspaceSyncFileSizeV1Schema,
  }).strict(),
  z.object({
    status: z.literal('too_large'),
    digest: WorkspaceSyncFileDigestV1Schema.optional(),
    size: WorkspaceSyncFileSizeV1Schema,
  }).strict(),
  z.object({ status: z.literal('missing') }).strict(),
  z.object({
    status: z.literal('changed'),
    actualDigest: WorkspaceSyncFileDigestV1Schema.optional(),
  }).strict(),
]));
export type ReadWorkspaceSyncFileResultV1 = z.infer<typeof ReadWorkspaceSyncFileResultV1Schema>;

/**
 * Selected-path inspection contracts. Metadata is the default: every relevant
 * endpoint is observed independently through the canonical confined entry
 * observer. A preview selector fetches exactly one bounded version; the UI
 * requests its comparison choices independently rather than concatenating
 * previews. The result is coverage for one observation, never a snapshot or
 * an approval capability.
 */
export const WorkspaceSyncTargetEntryObserveV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  path: WorkspaceSyncRelativePathV1Schema,
}).strict());
export type WorkspaceSyncTargetEntryObserveV1 = z.infer<typeof WorkspaceSyncTargetEntryObserveV1Schema>;

const WorkspaceSyncConflictInspectPreviewSelectorV1Schema = lazyZodSchema(() => z.object({
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  expected: WorkspaceSyncEntryExpectationV1Schema,
}).strict());

export const WorkspaceSyncConflictInspectActionInputV1Schema = lazyZodSchema(() => z.object({
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH).optional(),
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  path: WorkspaceSyncRelativePathV1Schema,
  preview: WorkspaceSyncConflictInspectPreviewSelectorV1Schema.optional(),
}).strict());
export type WorkspaceSyncConflictInspectActionInputV1 = z.infer<typeof WorkspaceSyncConflictInspectActionInputV1Schema>;

export const WorkspaceSyncConflictInspectRpcRequestV1Schema = lazyZodSchema(() => z.object({
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  path: WorkspaceSyncRelativePathV1Schema,
  preview: WorkspaceSyncConflictInspectPreviewSelectorV1Schema.optional(),
}).strict());
export type WorkspaceSyncConflictInspectRpcRequestV1 = z.infer<typeof WorkspaceSyncConflictInspectRpcRequestV1Schema>;

export const WorkspaceSyncPathSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('included') }).strict(),
  z.object({
    status: z.literal('excluded'),
    reason: z.enum(['repository_metadata', 'submodule', 'configured_rule', 'git_ignore']),
  }).strict(),
  z.object({
    status: z.literal('unknown'),
    reason: z.enum(['endpoint_unavailable', 'selection_unavailable']),
  }).strict(),
]));
export type WorkspaceSyncPathSelectionV1 = z.infer<typeof WorkspaceSyncPathSelectionV1Schema>;

/**
 * Caller-visible per-link selection query. The controller resolves the live
 * relationship, side, and endpoint authority from current settings; the
 * caller never supplies a root. The decision comes from the endpoint-local
 * engine evaluator, never from configuration guesses.
 */
export const WorkspaceSyncSelectionDiagnoseV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  side: z.enum(['alpha', 'beta']),
  path: WorkspaceSyncRelativePathV1Schema,
}).strict());
export type WorkspaceSyncSelectionDiagnoseV1 = z.infer<typeof WorkspaceSyncSelectionDiagnoseV1Schema>;

/**
 * Target-daemon selection request. The selected side is resolved by the
 * controller before forwarding, and the receiving daemon evaluates it at its
 * retained endpoint root through the same engine producer.
 */
export const WorkspaceSyncTargetSelectionDiagnoseV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  path: WorkspaceSyncRelativePathV1Schema,
}).strict());
export type WorkspaceSyncTargetSelectionDiagnoseV1 = z.infer<typeof WorkspaceSyncTargetSelectionDiagnoseV1Schema>;

const WorkspaceSyncConflictInspectSelectionV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  side: z.enum(['alpha', 'beta']),
  decision: WorkspaceSyncPathSelectionV1Schema,
}).strict());

export const WorkspaceSyncConflictInspectEndpointV1Schema = lazyZodSchema(() => z.object({
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  outcome: z.enum(['observed', 'changed', 'unreachable', 'unsupported', 'revoked']),
  observation: WorkspaceSyncEntryExpectationV1Schema.optional(),
  selections: z.array(WorkspaceSyncConflictInspectSelectionV1Schema).readonly(),
}).strict().superRefine((value, context) => {
  if (value.outcome === 'observed' && value.observation === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['observation'],
      message: 'an observed endpoint requires its canonical entry observation',
    });
  } else if (value.outcome !== 'observed' && value.observation !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['observation'],
      message: 'only an observed endpoint carries a verified entry observation',
    });
  }
}));
export type WorkspaceSyncConflictInspectEndpointV1 = z.infer<typeof WorkspaceSyncConflictInspectEndpointV1Schema>;

const WorkspaceSyncConflictInspectVersionV1Schema = lazyZodSchema(() => z.object({
  endpointWorkspaceRefIds: z.array(z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH)).min(1).readonly(),
  entry: WorkspaceSyncEntryExpectationV1Schema,
  preview: z.object({
    workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
    preview: ReadWorkspaceSyncFileResultV1Schema,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.preview !== undefined && !value.endpointWorkspaceRefIds.includes(value.preview.workspaceRefId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['preview', 'workspaceRefId'],
      message: 'a version preview must come from one of its grouped endpoints',
    });
  }
}));

export function areWorkspaceSyncEntryExpectationsEqual(
  left: WorkspaceSyncEntryExpectationV1,
  right: WorkspaceSyncEntryExpectationV1,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'missing':
      return true;
    case 'file':
      return right.kind === 'file' && left.digest === right.digest && left.executable === right.executable;
    case 'symlink':
      return right.kind === 'symlink' && left.target === right.target;
    case 'directory':
      return right.kind === 'directory' && left.fingerprint === right.fingerprint;
  }
}

export const WorkspaceSyncConflictInspectRpcResultV1Schema = lazyZodSchema(() => z.object({
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  hubWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  path: WorkspaceSyncRelativePathV1Schema,
  endpoints: z.array(WorkspaceSyncConflictInspectEndpointV1Schema).min(1).readonly(),
  versions: z.array(WorkspaceSyncConflictInspectVersionV1Schema).readonly(),
  preservationOptions: z.array(z.discriminatedUnion('status', [
    z.object({
      status: z.literal('available'),
      source: WorkspaceSyncResolutionEndpointV1Schema,
      destination: z.object({
        workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
        path: WorkspaceSyncRelativePathV1Schema,
        expected: WorkspaceSyncEntryExpectationV1Schema,
      }).strict(),
      consequence: z.object({
        propagatingToWorkspaceRefIds: z.array(z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH)).readonly(),
        unverifiedPropagationToWorkspaceRefIds: z.array(z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH)).readonly().optional(),
      }).strict(),
    }).strict(),
    z.object({
      status: z.literal('name_conflict'),
      source: WorkspaceSyncResolutionEndpointV1Schema,
      proposed: z.object({
        workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
        path: WorkspaceSyncRelativePathV1Schema,
      }).strict(),
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      source: WorkspaceSyncResolutionEndpointV1Schema,
      reason: z.enum(['path_unavailable', 'destination_unavailable', 'selection_unavailable']),
    }).strict(),
  ])).readonly().optional(),
  coverage: z.object({ complete: z.boolean() }).strict(),
}).strict().superRefine((value, context) => {
  const previewCount = value.versions.filter((version) => version.preview !== undefined).length;
  if (previewCount > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['versions'],
      message: 'an inspection carries at most one bounded version preview',
    });
  }
  for (const [index, endpoint] of value.endpoints.entries()) {
    const matching = value.versions.filter((version) => version.endpointWorkspaceRefIds.includes(endpoint.workspaceRefId));
    if (endpoint.outcome === 'observed') {
      if (matching.length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints', index, 'workspaceRefId'],
          message: 'an observed endpoint belongs to exactly one version',
        });
      } else if (endpoint.observation !== undefined
        && !areWorkspaceSyncEntryExpectationsEqual(matching[0]!.entry, endpoint.observation)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoints', index, 'observation'],
          message: 'a version entry must equal its endpoint observation',
        });
      }
    } else if (matching.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoints', index, 'workspaceRefId'],
        message: 'an unobserved endpoint is never a verified version',
      });
    }
  }
}));
export type WorkspaceSyncConflictInspectRpcResultV1 = z.infer<typeof WorkspaceSyncConflictInspectRpcResultV1Schema>;

/** The same domain projection serves the Action and its controller transport. */
export const WorkspaceSyncConflictInspectActionOutputV1Schema = WorkspaceSyncConflictInspectRpcResultV1Schema;
export type WorkspaceSyncConflictInspectActionOutputV1 = z.infer<typeof WorkspaceSyncConflictInspectActionOutputV1Schema>;

export const WorkspaceSyncEndpointStatusV1Schema = lazyZodSchema(() => z.object({
  connected: z.boolean(),
  scanned: z.boolean(),
  scanProblemCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  transitionProblemCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict());
export type WorkspaceSyncEndpointStatusV1 = z.infer<typeof WorkspaceSyncEndpointStatusV1Schema>;

export const WorkspaceSyncStatusV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  state: z.enum([
    'starting',
    'watching',
    'flushing',
    'paused',
    'disconnected',
    'conflicted',
    'controller_unavailable',
    'error',
    'stopped',
  ]),
  alphaPath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  betaPath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  mode: WorkspaceSyncModeV1Schema,
  endpointStates: z.object({
    alpha: WorkspaceSyncEndpointStatusV1Schema.nullable(),
    beta: WorkspaceSyncEndpointStatusV1Schema.nullable(),
  }).strict(),
  conflictCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastCycleObservedAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  errorCode: z.string().trim().min(1).max(MAX_ERROR_CODE_LENGTH).optional(),
}).strict());
export type WorkspaceSyncStatusV1 = z.infer<typeof WorkspaceSyncStatusV1Schema>;

/**
 * Controller-scoped relationship inventory for the read Actions. The queried
 * controller is addressed by transport; it never appears in the body. An
 * optional member ref narrows the result to the relationships that contain
 * it, including same-Account discovery references to relationships owned by
 * another controller whose live status stays unknown until queried there.
 */
export const WorkspaceSyncRelationshipsListRpcRequestV1Schema = lazyZodSchema(() => z.object({
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH).optional(),
}).strict());
export type WorkspaceSyncRelationshipsListRpcRequestV1 = z.infer<typeof WorkspaceSyncRelationshipsListRpcRequestV1Schema>;

const WorkspaceSyncRelationshipWithStatusV1Schema = lazyZodSchema(() => z.object({
  definition: WorkspaceSyncRelationshipV1Schema,
  status: WorkspaceSyncStatusV1Schema.nullable(),
}).strict());

const WorkspaceSyncRemoteRelationshipV1Schema = lazyZodSchema(() => z.object({
  definition: WorkspaceSyncRelationshipV1Schema,
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
}).strict().superRefine((value, context) => {
  if (value.definition.controllerMachineId !== value.controllerMachineId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['controllerMachineId'],
      message: 'remote relationship controller must match its definition',
    });
  }
}));

const WorkspaceSyncDerivedSetV1Schema = lazyZodSchema(() => z.object({
  hubWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  relationshipIds: z.array(z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH)).min(1).readonly(),
}).strict());

export const WorkspaceSyncRelationshipsListRpcResultV1Schema = lazyZodSchema(() => z.object({
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  sets: z.array(WorkspaceSyncDerivedSetV1Schema).readonly(),
  relationships: z.array(WorkspaceSyncRelationshipWithStatusV1Schema).readonly(),
  remoteRelationships: z.array(WorkspaceSyncRemoteRelationshipV1Schema).readonly(),
  membership: z.object({
    workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH).nullable(),
    found: z.boolean().nullable(),
  }).strict(),
  discoveryAvailable: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.membership.workspaceRefId === null && value.membership.found !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['membership', 'found'],
      message: 'unfiltered membership cannot claim a found result',
    });
  }
  if (value.membership.workspaceRefId !== null && value.membership.found === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['membership', 'found'],
      message: 'filtered membership must report whether the member was found',
    });
  }
  if (value.membership.workspaceRefId === null && value.remoteRelationships.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['remoteRelationships'],
      message: 'remote discovery requires a member filter',
    });
  }
  for (const [index, entry] of value.relationships.entries()) {
    if (entry.definition.controllerMachineId !== value.controllerMachineId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relationships', index, 'definition', 'controllerMachineId'],
        message: 'local relationship controller must match the queried controller',
      });
    }
  }
  const seenRelationshipIds = new Set<string>();
  for (const [index, set] of value.sets.entries()) {
    for (const relationshipId of set.relationshipIds) {
      if (seenRelationshipIds.has(relationshipId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sets', index, 'relationshipIds'],
          message: 'a relationship belongs to at most one derived set',
        });
      }
      seenRelationshipIds.add(relationshipId);
    }
  }
}));
export type WorkspaceSyncRelationshipsListRpcResultV1 = z.infer<typeof WorkspaceSyncRelationshipsListRpcResultV1Schema>;

/**
 * Agent/UI read input. The controller is explicit when the caller already
 * knows it; otherwise the executor queries the session machine. At least one
 * of the two is required so the request always names its authority scope.
 */
export const WorkspaceSyncRelationshipsListActionInputV1Schema = lazyZodSchema(() => z.object({
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH).optional(),
  workspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH).optional(),
}).strict().superRefine((value, context) => {
  if (value.controllerMachineId === undefined && value.workspaceRefId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'relationships.list requires a controller or a workspace member',
    });
  }
}));
export type WorkspaceSyncRelationshipsListActionInputV1 = z.infer<typeof WorkspaceSyncRelationshipsListActionInputV1Schema>;

/** The same domain projection serves the Action and its controller transport. */
export const WorkspaceSyncRelationshipsListActionOutputV1Schema = WorkspaceSyncRelationshipsListRpcResultV1Schema;
export type WorkspaceSyncRelationshipsListActionOutputV1 = z.infer<typeof WorkspaceSyncRelationshipsListActionOutputV1Schema>;

/**
 * What a new sync destination does with the files already in it. This is
 * deliberately separate from the relationship mode: attaching an existing
 * checkout preserves its contents and lets the engine reconcile them as
 * ordinary conflicts, while source materialization replaces them. Establishing
 * an exact replica is possible either way, and its continuing target-only
 * deletion is approved as its own consequence.
 */
export const WorkspaceSyncDestinationIntentV1Schema = lazyZodSchema(() => z.enum([
  'use_existing',
  'materialize_from_source_workspace',
]));
export type WorkspaceSyncDestinationIntentV1 = z.infer<typeof WorkspaceSyncDestinationIntentV1Schema>;

/**
 * Exact-value identity field for a closed, authority-bearing Action input.
 * Trimming here would let the approval artifact's stored arguments and the
 * parsed input the target replays diverge by whitespace alone, so surrounding
 * whitespace is rejected instead of silently normalized.
 */
function exactBoundedString(max: number) {
  return z.string().min(1).max(max).refine(
    (value) => value === value.trim(),
    'value must not carry surrounding whitespace',
  );
}

/**
 * Direct Project linking input for `workspace.sync.relationship.create`.
 *
 * It names the exact existing source Workspace, the destination Machine/folder
 * and the explicit destination intent. Relationship identity, endpoint
 * WorkspaceRef materialization, controller placement and bootstrap mechanics
 * stay daemon-owned: a caller can neither mint a relationship id, pin a
 * settings version, nor name a physical root.
 */
export const WorkspaceSyncRelationshipCreateActionInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  sourceWorkspaceRefId: exactBoundedString(MAX_WORKSPACE_REF_ID_LENGTH),
  targetMachineId: exactBoundedString(MAX_MACHINE_ID_LENGTH),
  targetPath: exactBoundedString(MAX_PATH_LENGTH),
  mode: WorkspaceSyncPersistentModeV1Schema,
  contentPolicy: WorkspaceContentPolicyV1Schema,
  destinationIntent: WorkspaceSyncDestinationIntentV1Schema,
}).strict());
export type WorkspaceSyncRelationshipCreateActionInputV1 = z.infer<
  typeof WorkspaceSyncRelationshipCreateActionInputV1Schema
>;

/**
 * The committed relationship. `created` is `false` when this operation opened
 * an existing definition for the same endpoint pair rather than persisting a
 * new one. `status` is the real engine status observed at commit: initial
 * conflicts from attaching a divergent existing checkout are a successful link
 * that needs attention, not a failed creation.
 */
export const WorkspaceSyncRelationshipCreateResultV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  created: z.boolean(),
  controllerMachineId: z.string().trim().min(1).max(MAX_MACHINE_ID_LENGTH),
  sourceWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  targetWorkspaceRefId: z.string().trim().min(1).max(MAX_WORKSPACE_REF_ID_LENGTH),
  status: WorkspaceSyncStatusV1Schema,
}).strict());
export type WorkspaceSyncRelationshipCreateResultV1 = z.infer<
  typeof WorkspaceSyncRelationshipCreateResultV1Schema
>;

/**
 * Source-controller transport for the same operation. The admitted Action input
 * travels verbatim so the target daemon replays exactly the bytes the approving
 * artifact stored; there is no second copy of the approved input to keep in
 * step. `operationId` is the admitted Action request identity, never a
 * caller-minted relationship id.
 */
export const WorkspaceSyncRelationshipCreateRpcRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  operationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  actionInput: WorkspaceSyncRelationshipCreateActionInputV1Schema,
  targetReplacementApproval: HandoffTargetReplacementApprovalV1Schema.optional(),
  targetReplacementApprovalReceiptId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH).optional(),
}).strict().superRefine((value, context) => {
  if ((value.targetReplacementApproval === undefined)
    !== (value.targetReplacementApprovalReceiptId === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetReplacementApprovalReceiptId'],
      message: 'target replacement approval requires its Action receipt',
    });
  }
}));
export type WorkspaceSyncRelationshipCreateRpcRequestV1 = z.infer<
  typeof WorkspaceSyncRelationshipCreateRpcRequestV1Schema
>;

const WorkspaceSyncReadyComponentV1Schema = lazyZodSchema(() => z.object({ state: z.literal('ready') }).strict());
const WorkspaceSyncUnavailableComponentV1Schema = lazyZodSchema(() => z.object({
  state: z.literal('unavailable'),
  errorCode: z.string().trim().min(1).max(MAX_ERROR_CODE_LENGTH),
}).strict());

export const WorkspaceSyncRuntimeReadinessV1Schema = lazyZodSchema(() => z.object({
  engine: z.discriminatedUnion('state', [
    z.object({ state: z.literal('starting') }).strict(),
    WorkspaceSyncReadyComponentV1Schema,
    WorkspaceSyncUnavailableComponentV1Schema,
  ]),
  carrier: z.discriminatedUnion('state', [
    WorkspaceSyncReadyComponentV1Schema,
    z.object({
      state: z.literal('unavailable'),
      errorCode: z.literal('machine_carrier_unavailable'),
    }).strict(),
  ]),
}).strict());
export type WorkspaceSyncRuntimeReadinessV1 = z.infer<typeof WorkspaceSyncRuntimeReadinessV1Schema>;

/**
 * One bounded readiness/status publication carried by the existing Machine
 * daemon-state channel. Readiness is always present so a client never infers
 * engine or carrier availability from paths or machine metadata; relationship
 * status is present only when the daemon has one to project. The enclosing
 * daemon-state version provides ordering and this event carries no independent
 * cursor or persisted history.
 */
export const WorkspaceSyncRuntimeEventV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  readiness: WorkspaceSyncRuntimeReadinessV1Schema,
  status: WorkspaceSyncStatusV1Schema.optional(),
}).strict());
export type WorkspaceSyncRuntimeEventV1 = z.infer<typeof WorkspaceSyncRuntimeEventV1Schema>;

/**
 * Post-commit cleanup debt. The operation succeeded and its durable state is
 * published; only a best-effort release failed, so this is reported rather than
 * turned into a failure.
 */
export const WorkspaceSyncCleanupWarningV1Schema = lazyZodSchema(() => z.object({
  code: z.string().trim().min(1).max(MAX_ERROR_CODE_LENGTH),
  message: z.string().trim().min(1).max(2048),
}).strict());
export type WorkspaceSyncCleanupWarningV1 = z.infer<typeof WorkspaceSyncCleanupWarningV1Schema>;

export const WorkspaceSyncLegacyStateInspectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('absent') }).strict(),
  z.object({
    status: z.literal('legacy_workspace_sync_state_unsupported'),
    classification: z.literal('retired_v1'),
    quarantinePath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    schemaVersion: z.literal(1),
  }).strict(),
  z.object({
    status: z.literal('legacy_workspace_sync_state_unknown'),
    path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    reason: z.string().trim().min(1).max(MAX_ERROR_CODE_LENGTH),
  }).strict(),
]));
export type WorkspaceSyncLegacyStateInspectionV1 = z.infer<typeof WorkspaceSyncLegacyStateInspectionV1Schema>;

/**
 * The daemon's terminal, committed workspace result for one handoff. It is the
 * only representation of the workspace outcome that crosses back to the UI:
 * whether a copy was materialized, whether a persistent relationship was newly
 * created or an exact existing definition was reused, the engine status the
 * daemon observed at commit, and any post-commit cleanup debt. The UI renders
 * this Action result directly and keeps no second workspace-outcome store.
 */
export const HandoffWorkspaceOutcomeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('copied'),
    operationId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
    status: WorkspaceSyncStatusV1Schema.optional(),
    cleanupWarning: WorkspaceSyncCleanupWarningV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('relationship'),
    relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
    /** `true` when this handoff persisted a new relationship; `false` when an exact existing definition was reused. */
    created: z.boolean(),
    status: WorkspaceSyncStatusV1Schema.optional(),
    cleanupWarning: WorkspaceSyncCleanupWarningV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('linked_workspace'),
    traversed: z.array(z.object({
      relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
      policyDigest: z.string().trim().min(1).max(256),
      status: WorkspaceSyncStatusV1Schema,
    }).strict()).max(2).readonly(),
    cleanupWarning: WorkspaceSyncCleanupWarningV1Schema.optional(),
  }).strict(),
]));
export type HandoffWorkspaceOutcomeV1 = z.infer<typeof HandoffWorkspaceOutcomeV1Schema>;

export const HandoffWorkspaceActionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('copy_once'),
    contentPolicy: WorkspaceContentPolicyV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('create_relationship'),
    mode: WorkspaceSyncPersistentModeV1Schema,
    contentPolicy: WorkspaceContentPolicyV1Schema,
    flushBeforeCommit: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal('relationship'),
    relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
    flushBeforeCommit: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal('linked_workspace') }).strict(),
]));
export type HandoffWorkspaceActionV1 = z.infer<typeof HandoffWorkspaceActionV1Schema>;

export const WorkspaceSyncPrepareBetweenRequestV1Schema = lazyZodSchema(() => z.object({
  sourceWorkspaceRefId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  targetWorkspaceRefId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
}).strict());
export type WorkspaceSyncPrepareBetweenRequestV1 = z.infer<typeof WorkspaceSyncPrepareBetweenRequestV1Schema>;

const WorkspaceSyncTraversedRelationshipV1Schema = lazyZodSchema(() => z.object({
  relationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH),
  policyDigest: z.string().trim().min(1).max(256),
  status: WorkspaceSyncStatusV1Schema,
}).strict());
export const WorkspaceSyncPrepareBetweenResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    traversed: z.array(WorkspaceSyncTraversedRelationshipV1Schema).max(2).readonly(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: z.string().trim().min(1).max(MAX_ERROR_CODE_LENGTH),
    completed: z.array(WorkspaceSyncTraversedRelationshipV1Schema).max(1).readonly(),
    blockedRelationshipId: z.string().trim().min(1).max(MAX_RELATIONSHIP_ID_LENGTH).optional(),
    blockedStatus: WorkspaceSyncStatusV1Schema.optional(),
  }).strict(),
]));
export type WorkspaceSyncPrepareBetweenResultV1 = z.infer<typeof WorkspaceSyncPrepareBetweenResultV1Schema>;
