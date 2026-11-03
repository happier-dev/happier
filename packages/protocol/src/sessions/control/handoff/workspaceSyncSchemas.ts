import { maxCodeUnits } from '../../../strings/maxCodeUnits.js';
import { z } from 'zod/mini';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { HandoffTargetReplacementApprovalV1Schema } from './handoffTargetReplacementApprovalV1.js';
import { MachineInstallationPublicIdentityV1Schema } from '../../../machines/identity/installationKeySchemas.js';
import { WorkspaceRefV1Schema } from '../../../workspaces/workspaceRefV1.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../../json/storedReadSchema.js';

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

const WorkspaceContentPolicyV1FieldsSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  selection: z.enum(['git_worktree', 'all_files']),
  extraIgnorePatterns: z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(WORKSPACE_SYNC_MAX_PATTERN_BYTES), z.refine((value) => utf8ToBytes(value).byteLength <= WORKSPACE_SYNC_MAX_PATTERN_BYTES, 'pattern exceeds UTF-8 byte limit'))).check(z.maxLength(WORKSPACE_SYNC_MAX_PATTERNS))),
  extraIncludePatterns: z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(WORKSPACE_SYNC_MAX_PATTERN_BYTES), z.refine((value) => utf8ToBytes(value).byteLength <= WORKSPACE_SYNC_MAX_PATTERN_BYTES, 'pattern exceeds UTF-8 byte limit'), z.refine((value) => !value.startsWith('!'), 'include patterns must be positive'))).check(z.maxLength(WORKSPACE_SYNC_MAX_PATTERNS))),
  policyDigest: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
}));
export const WorkspaceContentPolicyV1Schema = lazyZodSchema(() => WorkspaceContentPolicyV1FieldsSchema.check(z.superRefine((value, context) => {
  if (value.policyDigest !== computeWorkspaceSyncPolicyDigest(value)) {
    context.addIssue({ code: "custom", path: ['policyDigest'], message: 'policyDigest does not match content policy' });
  }
})));
export type WorkspaceContentPolicyV1 = z.infer<typeof WorkspaceContentPolicyV1Schema>;

/** Existing finite seed-export body, shared by its installed and Account ingress. */
export const WorkspaceSyncSeedExportPrepareV1Schema = lazyZodSchema(() => z.strictObject({
  t: z.literal('workspace_sync_seed_v1'),
  operationId: z.string().check(z.minLength(1)),
  sourceWorkspaceRefId: z.string().check(z.minLength(1)),
  targetMachineId: z.string().check(z.minLength(1)),
  contentPolicy: WorkspaceContentPolicyV1Schema,
}));
export type WorkspaceSyncSeedExportPrepareV1 = z.infer<typeof WorkspaceSyncSeedExportPrepareV1Schema>;

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

export const WorkspaceSyncWorkerCopyProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('worker_clean_copy'),
  sourceWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  targetWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
}));
export type WorkspaceSyncWorkerCopyProvenanceV1 = z.infer<typeof WorkspaceSyncWorkerCopyProvenanceV1Schema>;

const OptionalWorkspaceSyncWorkerCopyProvenanceV1Schema = defineStoredReadProjection(
  z.optional(WorkspaceSyncWorkerCopyProvenanceV1Schema),
  () => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => (
    typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'worker_clean_copy'
      ? value : undefined
  )), z.optional(createStoredReadSchema(WorkspaceSyncWorkerCopyProvenanceV1Schema))),
);

export const WorkspaceSyncRelationshipV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
    controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
    alphaWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
    betaWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
    mode: WorkspaceSyncPersistentModeV1Schema,
    contentPolicy: WorkspaceContentPolicyV1Schema,
    provenance: OptionalWorkspaceSyncWorkerCopyProvenanceV1Schema,
    // null is new, never-committed intent; absent legacy rows retain possible native custody.
    committedAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)))),
    enabled: z.boolean(),
    createdAtMs: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
    updatedAtMs: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  }).check(z.superRefine((value, context) => {
    if (value.alphaWorkspaceRefId === value.betaWorkspaceRefId) {
      context.addIssue({
        code: "custom",
        path: ['betaWorkspaceRefId'],
        message: 'alphaWorkspaceRefId and betaWorkspaceRefId must be distinct',
      });
    }
    if (value.provenance && (value.provenance.sourceWorkspaceRefId === value.provenance.targetWorkspaceRefId
      || ![value.alphaWorkspaceRefId, value.betaWorkspaceRefId].includes(value.provenance.sourceWorkspaceRefId)
      || ![value.alphaWorkspaceRefId, value.betaWorkspaceRefId].includes(value.provenance.targetWorkspaceRefId))) {
      context.addIssue({ code: "custom", path: ['provenance'], message: 'worker copy provenance must bind distinct relationship endpoints' });
    }
  })));
export type WorkspaceSyncRelationshipV1 = z.infer<typeof WorkspaceSyncRelationshipV1Schema>;

/** Only dedicated creation provenance identifies a worker copy; Sync use and receipts do not. */
export function getWorkspaceSyncWorkerCopyV1(
  relationship: WorkspaceSyncRelationshipV1,
): WorkspaceSyncWorkerCopyProvenanceV1 | null {
  const provenance = relationship.provenance;
  if (!provenance || provenance.kind !== 'worker_clean_copy' || provenance.sourceWorkspaceRefId === provenance.targetWorkspaceRefId
    || ![relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].includes(provenance.sourceWorkspaceRefId)
    || ![relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].includes(provenance.targetWorkspaceRefId)) return null;
  return provenance;
}

/** Provenance is immutable creation evidence, independent of Mutagen runtime identity. */
export function areWorkspaceSyncWorkerCopyProvenancesEqual(
  left: WorkspaceSyncRelationshipV1,
  right: WorkspaceSyncRelationshipV1,
): boolean {
  const a = getWorkspaceSyncWorkerCopyV1(left);
  const b = getWorkspaceSyncWorkerCopyV1(right);
  return a === null ? b === null : b !== null
    && a.sourceWorkspaceRefId === b.sourceWorkspaceRefId && a.targetWorkspaceRefId === b.targetWorkspaceRefId;
}

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

// Finite copy locators may belong to different Accounts. Endpoint qualification,
// not opaque ID inequality, establishes whether their execution roots differ.
export const WorkspaceSyncCopyOnceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  alphaWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  betaWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  contentPolicy: WorkspaceContentPolicyV1Schema,
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
const WorkspaceSyncFileDigestV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[a-f0-9]{40}$/u)));
const WorkspaceSyncDirectoryFingerprintV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[a-f0-9]{64}$/u)));

/**
 * An engine-relative path is identity-bearing data, not display/user input.
 * Preserve its bytes exactly. Forward slash is the cross-platform engine
 * separator; the target filesystem owner applies any additional native rules
 * (notably Windows backslash separators and volume/ADS rejection).
 */
const WorkspaceSyncRelativePathV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH), z.superRefine((value, context) => {
  const components = value.split('/');
  if (
    value.includes('\0')
    || value.startsWith('/')
    || components.some((component) => component === '' || component === '.' || component === '..')
  ) {
    context.addIssue({
      code: "custom",
      message: 'workspace sync path must identify a safe root-relative descendant',
    });
  }
})));

const WorkspaceSyncConflictEndpointV1Schema = lazyZodSchema(() => z.strictObject({
  kind: WorkspaceSyncConflictEndpointEntryKindV1Schema,
  digest: z.optional(WorkspaceSyncFileDigestV1Schema),
  size: z.optional(z.number().check(z.int(), z.nonnegative())),
  sourceKind: z.optional(WorkspaceSyncUnsupportedEntrySourceKindV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.kind === 'unsupported' && value.sourceKind === undefined) {
    context.addIssue({
      code: "custom",
      path: ['sourceKind'],
      message: 'unsupported conflict entries require their bounded engine source kind',
    });
  } else if (value.kind !== 'unsupported' && value.sourceKind !== undefined) {
    context.addIssue({
      code: "custom",
      path: ['sourceKind'],
      message: 'supported conflict entries cannot carry an unsupported source kind',
    });
  }
  if (value.kind === 'unsupported' && (value.digest !== undefined || value.size !== undefined)) {
    context.addIssue({
      code: "custom",
      message: 'unsupported conflict entries cannot claim file metadata',
    });
  }
})));

export const WorkspaceSyncConflictV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  path: WorkspaceSyncRelativePathV1Schema,
  alpha: WorkspaceSyncConflictEndpointV1Schema,
  beta: WorkspaceSyncConflictEndpointV1Schema,
}));
export type WorkspaceSyncConflictV1 = z.infer<typeof WorkspaceSyncConflictV1Schema>;

export const WorkspaceSyncConflictListV1Schema = lazyZodSchema(() => z.strictObject({
    relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
    totalCount: z.number().check(z.int(), z.nonnegative()),
    shownCount: z.number().check(z.int(), z.nonnegative()),
    truncatedCount: z.number().check(z.int(), z.nonnegative()),
    conflicts: z.readonly(z.array(WorkspaceSyncConflictV1Schema).check(z.maxLength(MAX_CONFLICTS))),
  }).check(z.superRefine((value, context) => {
    if (value.shownCount !== value.conflicts.length) {
      context.addIssue({
        code: "custom",
        path: ['shownCount'],
        message: 'shownCount must equal conflicts.length',
      });
    }
    if (value.totalCount < value.shownCount || value.truncatedCount !== value.totalCount - value.shownCount) {
      context.addIssue({
        code: "custom",
        path: ['truncatedCount'],
        message: 'truncatedCount must equal totalCount minus shownCount',
      });
    }
    for (const [index, conflict] of value.conflicts.entries()) {
      if (conflict.relationshipId !== value.relationshipId) {
        context.addIssue({
          code: "custom",
          path: ['conflicts', index, 'relationshipId'],
          message: 'conflict relationshipId must match the list relationshipId',
        });
      }
    }
  })));
export type WorkspaceSyncConflictListV1 = z.infer<typeof WorkspaceSyncConflictListV1Schema>;

export const WorkspaceSyncConflictPageRequestV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  cursor: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))),
  limit: z.number().check(z.int(), z.positive(), z.maximum(WORKSPACE_SYNC_CONFLICT_PAGE_MAX_ITEMS)),
}));
export type WorkspaceSyncConflictPageRequestV1 = z.infer<typeof WorkspaceSyncConflictPageRequestV1Schema>;

const WorkspaceSyncConflictPageDataV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal('page'),
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  totalCount: z.number().check(z.int(), z.nonnegative()),
  nextCursor: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))),
  conflicts: z.readonly(z.array(WorkspaceSyncConflictV1Schema).check(z.maxLength(WORKSPACE_SYNC_CONFLICT_PAGE_MAX_ITEMS))),
}).check(z.superRefine((value, context) => {
  if (value.totalCount < value.conflicts.length) {
    context.addIssue({
      code: "custom",
      path: ['totalCount'],
      message: 'totalCount must be at least conflicts.length',
    });
  }
  for (const [index, conflict] of value.conflicts.entries()) {
    if (conflict.relationshipId !== value.relationshipId) {
      context.addIssue({
        code: "custom",
        path: ['conflicts', index, 'relationshipId'],
        message: 'conflict relationshipId must match the page relationshipId',
      });
    }
  }
})));

export const WorkspaceSyncConflictPageV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  WorkspaceSyncConflictPageDataV1Schema,
  z.strictObject({
    status: z.literal('cursor_invalidated'),
    relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  }),
]));
export type WorkspaceSyncConflictPageV1 = z.infer<typeof WorkspaceSyncConflictPageV1Schema>;

/**
 * Complete, effect-authorizing observation of one confined workspace entry.
 * Preview availability is intentionally absent: display bounds never weaken the
 * identity that a reviewed resolution approves.
 */
export const WorkspaceSyncEntryExpectationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('missing') }),
  z.strictObject({
    kind: z.literal('file'),
    digest: WorkspaceSyncFileDigestV1Schema,
    executable: z.boolean(),
    size: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  }),
  z.strictObject({
    kind: z.literal('symlink'),
    target: z.string().check(z.maxLength(MAX_PATH_LENGTH)),
  }),
  z.strictObject({
    kind: z.literal('directory'),
    fingerprint: WorkspaceSyncDirectoryFingerprintV1Schema,
  }),
]));
export type WorkspaceSyncEntryExpectationV1 = z.infer<typeof WorkspaceSyncEntryExpectationV1Schema>;

const WorkspaceSyncResolutionEndpointV1Schema = lazyZodSchema(() => z.strictObject({
  workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  expected: WorkspaceSyncEntryExpectationV1Schema,
}));

const WorkspaceSyncConflictResolutionBaseV1Schema = lazyZodSchema(() => z.object({
  controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  hubWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  path: WorkspaceSyncRelativePathV1Schema,
  source: WorkspaceSyncResolutionEndpointV1Schema,
  targets: z.readonly(z.array(WorkspaceSyncResolutionEndpointV1Schema).check(z.minLength(1))),
  relationshipIds: z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))).check(z.minLength(1))),
}));

export const WorkspaceSyncConflictResolutionV1Schema = lazyZodSchema(() => z.discriminatedUnion('strategy', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkspaceSyncConflictResolutionBaseV1Schema, { strategy: z.literal('use_source') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkspaceSyncConflictResolutionBaseV1Schema, {
    strategy: z.literal('keep_both'),
    alternatives: z.readonly(z.array(z.strictObject({
      source: WorkspaceSyncResolutionEndpointV1Schema,
      destination: z.strictObject({
        workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
        path: WorkspaceSyncRelativePathV1Schema,
        expected: WorkspaceSyncEntryExpectationV1Schema,
      }),
      consequence: z.strictObject({
        propagatingToWorkspaceRefIds: z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)))),
        unverifiedPropagationToWorkspaceRefIds: z.optional(z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH))))),
      }),
    })).check(z.minLength(1))),
  })),
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
  z.strictObject({ workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)), status: z.literal('applied') }),
  z.strictObject({ workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)), status: z.literal('applied_paused') }),
  z.strictObject({ workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)), status: z.literal('changed') }),
  z.strictObject({ workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)), status: z.literal('offline') }),
  z.strictObject({ workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)), status: z.literal('cancelled') }),
  z.strictObject({ workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)), status: z.literal('unknown') }),
  z.strictObject({
    workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
    status: z.literal('failed'),
    errorCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_ERROR_CODE_LENGTH)),
  }),
  z.strictObject({
    workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
    status: z.literal('recovery_needed'),
    recoveryPath: z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
  }),
]));
export type WorkspaceSyncConflictResolutionEndpointResultV1 = z.infer<typeof WorkspaceSyncConflictResolutionEndpointResultV1Schema>;

export const WorkspaceSyncConflictResolutionResultV1Schema = lazyZodSchema(() => z.strictObject({
  endpoints: z.readonly(z.array(WorkspaceSyncConflictResolutionEndpointResultV1Schema).check(z.minLength(1))),
  preserved: z.optional(z.readonly(z.array(z.strictObject({
    alternativeIndex: z.number().check(z.int(), z.nonnegative()),
    sourceWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
    destinationWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
    path: WorkspaceSyncRelativePathV1Schema,
    propagatingToWorkspaceRefIds: z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)))),
    unverifiedPropagationToWorkspaceRefIds: z.optional(z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH))))),
    outcome: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('preserved') }),
      z.strictObject({ status: z.literal('already_present') }),
      z.strictObject({ status: z.literal('not_started') }),
      z.strictObject({ status: z.literal('changed') }),
      z.strictObject({ status: z.literal('offline') }),
      z.strictObject({ status: z.literal('cancelled') }),
      z.strictObject({ status: z.literal('unknown') }),
      z.strictObject({ status: z.literal('failed'), errorCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_ERROR_CODE_LENGTH)) }),
      z.strictObject({ status: z.literal('recovery_needed'), recoveryPath: z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH)) }),
    ]),
  })))),
}));
export type WorkspaceSyncConflictResolutionResultV1 = z.infer<typeof WorkspaceSyncConflictResolutionResultV1Schema>;

/**
 * One relationship conflict page at a time through the exact controller. The
 * existing opaque cursor and bounds are preserved; no aggregate global
 * cursor or unbounded fan-out is representable.
 */
export const WorkspaceSyncConflictsListActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  cursor: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))),
  limit: z.number().check(z.int(), z.positive(), z.maximum(WORKSPACE_SYNC_CONFLICT_PAGE_MAX_ITEMS)),
}));
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
export const WorkspaceSyncConflictResolveRpcInputV1Schema = lazyZodSchema(() => z.strictObject({
  actionReceiptId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  actionInput: WorkspaceSyncConflictResolveActionInputV1Schema,
}));
export type WorkspaceSyncConflictResolveRpcInputV1 = z.infer<typeof WorkspaceSyncConflictResolveRpcInputV1Schema>;

export const WorkspaceSyncRelationshipIdV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
}));
export type WorkspaceSyncRelationshipIdV1 = z.infer<typeof WorkspaceSyncRelationshipIdV1Schema>;

/** Private two-phase target effect: transfer/capture settles before engine pause. */
export const WorkspaceSyncTargetConflictStageV1Schema = lazyZodSchema(() => z.strictObject({
  actionReceiptId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  actionInput: WorkspaceSyncConflictResolveActionInputV1Schema,
  operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  alternativeIndex: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  sourceRelationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  sourceMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  sourceWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  sourceExpected: WorkspaceSyncEntryExpectationV1Schema,
  targetMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  targetWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  targetExpected: WorkspaceSyncEntryExpectationV1Schema,
  path: WorkspaceSyncRelativePathV1Schema,
}));
export type WorkspaceSyncTargetConflictStageV1 = z.infer<typeof WorkspaceSyncTargetConflictStageV1Schema>;

/** Release private source material after every reviewed destination has staged or failed. */
export const WorkspaceSyncConflictCaptureReleaseV1Schema = lazyZodSchema(() => z.strictObject({
  actionReceiptId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  actionInput: WorkspaceSyncConflictResolveActionInputV1Schema,
  operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  sourceMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  sourceWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
}));
export type WorkspaceSyncConflictCaptureReleaseV1 = z.infer<typeof WorkspaceSyncConflictCaptureReleaseV1Schema>;

export const WorkspaceSyncTargetConflictApplyV1Schema = lazyZodSchema(() => z.strictObject({
  actionReceiptId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  actionInput: WorkspaceSyncConflictResolveActionInputV1Schema,
  operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  alternativeIndex: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  targetMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  targetWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  path: WorkspaceSyncRelativePathV1Schema,
}));
export type WorkspaceSyncTargetConflictApplyV1 = z.infer<typeof WorkspaceSyncTargetConflictApplyV1Schema>;

export const WorkspaceSyncTargetConflictApplyResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('installed') }),
  z.strictObject({ status: z.literal('restored') }),
  z.strictObject({ status: z.literal('recovery_needed'), recoveryPath: z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH)) }),
]));
export type WorkspaceSyncTargetConflictApplyResultV1 = z.infer<typeof WorkspaceSyncTargetConflictApplyResultV1Schema>;

/** Reconcile retained confined replacement evidence before a touching engine runs. */
export const WorkspaceSyncTargetConflictRecoverV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  targetMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  targetWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
}));
export type WorkspaceSyncTargetConflictRecoverV1 = z.infer<typeof WorkspaceSyncTargetConflictRecoverV1Schema>;

export const WorkspaceSyncTargetConflictRecoverResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('settled') }),
  z.strictObject({ status: z.literal('recovery_needed'), recoveryPath: z.string().check(z.minLength(1), z.maxLength(MAX_PATH_LENGTH)) }),
]));
export type WorkspaceSyncTargetConflictRecoverResultV1 = z.infer<typeof WorkspaceSyncTargetConflictRecoverResultV1Schema>;

export const ReadWorkspaceSyncFileV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  side: z.enum(['alpha', 'beta']),
  path: WorkspaceSyncRelativePathV1Schema,
  expectedDigest: z.optional(WorkspaceSyncFileDigestV1Schema),
  maxBytes: z._default(z.number().check(z.int(), z.positive(), z.maximum(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES)), WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES),
}));
export type ReadWorkspaceSyncFileV1 = z.infer<typeof ReadWorkspaceSyncFileV1Schema>;

/**
 * Target-daemon preview request. The selected side is resolved by the
 * controller before forwarding, and the receiving daemon resolves this
 * workspace reference from its current Account settings. A caller-controlled
 * filesystem root is deliberately absent.
 */
const WorkspaceSyncHexDigestV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[a-f0-9]{64}$/u)));

export const WorkspaceSyncTargetBootstrapOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('relationship'),
    relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  }),
  z.strictObject({
    kind: z.literal('copy_once'),
    operation: WorkspaceSyncCopyOnceV1Schema,
  }),
]));
export type WorkspaceSyncTargetBootstrapOwnerV1 = z.infer<typeof WorkspaceSyncTargetBootstrapOwnerV1Schema>;

export const HandoffTargetReplacementPreflightV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  serverId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  targetPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
  /**
   * Whether this operation activates exact mirroring, which authorizes deleting
   * target-only files later even when the destination is missing or empty now.
   */
  activatesExactMirror: z.optional(z.boolean()),
  /**
   * What this operation will do with contents already in the destination. The
   * target daemon's bootstrap owner only replaces them for source
   * materialization, so an omitted value keeps that original meaning and an
   * explicit `use_existing` must not raise a replacement consequence. An old
   * daemon rejects the unknown field outright rather than silently answering
   * for a different intent.
   */
  destinationIntent: z.optional(z.enum(['use_existing', 'materialize_from_source_workspace'])),
}));
export type HandoffTargetReplacementPreflightV1 = z.infer<typeof HandoffTargetReplacementPreflightV1Schema>;

export const HandoffTargetReplacementPreflightResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('not_required'), physicalEndpoint: z.optional(MachineInstallationPublicIdentityV1Schema),
    targetWorkspace: z.optional(WorkspaceRefV1Schema) }),
  z.strictObject({
    type: z.literal('approval_required'),
    approval: HandoffTargetReplacementApprovalV1Schema,
    physicalEndpoint: z.optional(MachineInstallationPublicIdentityV1Schema),
    targetWorkspace: z.optional(WorkspaceRefV1Schema),
  }),
]));
export type HandoffTargetReplacementPreflightResultV1 = z.infer<typeof HandoffTargetReplacementPreflightResultV1Schema>;

/**
 * Target-daemon bootstrap prepare request. The receiving daemon resolves the
 * target root and bootstrap source root from its current Account settings; a
 * caller-supplied path, credential or grant is deliberately not representable.
 */
export const WorkspaceSyncTargetBootstrapPrepareV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  bootstrapOperationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  owner: WorkspaceSyncTargetBootstrapOwnerV1Schema,
  /**
   * Operation-scoped definition used only while a newly-created relationship
   * is being proven before its durable Account-settings commit.
   */
  transientRelationship: z.optional(WorkspaceSyncRelationshipV1Schema),
  targetWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  endpointRole: z.enum(['alpha', 'beta']),
  policyDigest: WorkspaceSyncHexDigestV1Schema,
  createIfMissing: z.boolean(),
  /** Explicit only for a new copy/relationship target; existing relationships rehydrate READY custody. */
  targetBootstrap: z.optional(z.enum(['use_existing', 'materialize_from_source_workspace'])),
  /**
   * Host-private proof for the destructive consequences of this destination.
   * The target daemon derives the operation it must be stamped for from the
   * bootstrap owner it resolves locally, so no accompanying caller-supplied
   * operation field is carried here: a caller could align that field with a
   * stolen proof, which would make the binding prove nothing.
   */
  targetReplacementApproval: z.optional(HandoffTargetReplacementApprovalV1Schema),
  /** Durable Protocol Action artifact authorizing the exact proof and input below. */
  targetReplacementApprovalReceiptId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))),
  /** Exact canonical approved Action input stored in the approving artifact. */
  targetReplacementApprovalActionInput: z.optional(z.unknown()),
}).check(z.superRefine((value, context) => {
  const transient = value.transientRelationship;
  const createsTarget = (value.owner.kind === 'copy_once' && value.createIfMissing) || transient !== undefined;
  if (createsTarget !== (value.targetBootstrap !== undefined)) {
    context.addIssue({
      code: "custom",
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
      code: "custom",
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
      code: "custom",
      path: ['targetReplacementApprovalReceiptId'],
      message: 'target replacement approval requires its Action receipt and exact approved input',
    });
  }
  if (!transient) return;
  if (value.owner.kind !== 'relationship') {
    context.addIssue({
      code: "custom",
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
      code: "custom",
      path: ['transientRelationship'],
      message: 'transient relationship does not match the exact bootstrap authority',
    });
  }
})));
export type WorkspaceSyncTargetBootstrapPrepareV1 = z.infer<typeof WorkspaceSyncTargetBootstrapPrepareV1Schema>;

/** Strict, root-free prepare result: authority fingerprints, never a local handle. */
export const WorkspaceSyncTargetBootstrapPrepareResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  bootstrapOperationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  targetWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  state: z.literal('ready'),
  created: z.boolean(),
  rootFingerprint: WorkspaceSyncHexDigestV1Schema,
  policyDigest: WorkspaceSyncHexDigestV1Schema,
  physicalEndpoint: z.optional(MachineInstallationPublicIdentityV1Schema),
  /** Existing physical owner row, carried only for an admitted finite copy. */
  targetWorkspace: z.optional(WorkspaceRefV1Schema),
}));
export type WorkspaceSyncTargetBootstrapPrepareResultV1 = z.infer<typeof WorkspaceSyncTargetBootstrapPrepareResultV1Schema>;

export const WorkspaceSyncTargetBootstrapReleaseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  bootstrapOperationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  targetWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  reason: z.enum(['abort', 'copy_committed', 'relationship_committed']),
}));
export type WorkspaceSyncTargetBootstrapReleaseV1 = z.infer<typeof WorkspaceSyncTargetBootstrapReleaseV1Schema>;

export const WorkspaceSyncTargetBootstrapReleaseResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  released: z.boolean(),
}));
export type WorkspaceSyncTargetBootstrapReleaseResultV1 = z.infer<typeof WorkspaceSyncTargetBootstrapReleaseResultV1Schema>;

export const WorkspaceSyncTargetFileReadV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  path: WorkspaceSyncRelativePathV1Schema,
  expectedDigest: z.optional(WorkspaceSyncFileDigestV1Schema),
  maxBytes: z._default(z.number().check(z.int(), z.positive(), z.maximum(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES)), WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES),
}));
export type WorkspaceSyncTargetFileReadV1 = z.infer<typeof WorkspaceSyncTargetFileReadV1Schema>;

const WorkspaceSyncFileSizeV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));

export const ReadWorkspaceSyncFileResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('text'),
    text: z.string().check(maxCodeUnits(WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES)),
    digest: WorkspaceSyncFileDigestV1Schema,
    size: WorkspaceSyncFileSizeV1Schema,
  }),
  z.strictObject({
    status: z.literal('binary'),
    digest: WorkspaceSyncFileDigestV1Schema,
    size: WorkspaceSyncFileSizeV1Schema,
  }),
  z.strictObject({
    status: z.literal('too_large'),
    digest: z.optional(WorkspaceSyncFileDigestV1Schema),
    size: WorkspaceSyncFileSizeV1Schema,
  }),
  z.strictObject({ status: z.literal('missing') }),
  z.strictObject({
    status: z.literal('changed'),
    actualDigest: z.optional(WorkspaceSyncFileDigestV1Schema),
  }),
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
export const WorkspaceSyncTargetEntryObserveV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  path: WorkspaceSyncRelativePathV1Schema,
}));
export type WorkspaceSyncTargetEntryObserveV1 = z.infer<typeof WorkspaceSyncTargetEntryObserveV1Schema>;

const WorkspaceSyncConflictInspectPreviewSelectorV1Schema = lazyZodSchema(() => z.strictObject({
  workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  expected: WorkspaceSyncEntryExpectationV1Schema,
}));

export const WorkspaceSyncConflictInspectActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  controllerMachineId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH))),
  workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  path: WorkspaceSyncRelativePathV1Schema,
  preview: z.optional(WorkspaceSyncConflictInspectPreviewSelectorV1Schema),
}));
export type WorkspaceSyncConflictInspectActionInputV1 = z.infer<typeof WorkspaceSyncConflictInspectActionInputV1Schema>;

export const WorkspaceSyncConflictInspectRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  path: WorkspaceSyncRelativePathV1Schema,
  preview: z.optional(WorkspaceSyncConflictInspectPreviewSelectorV1Schema),
}));
export type WorkspaceSyncConflictInspectRpcRequestV1 = z.infer<typeof WorkspaceSyncConflictInspectRpcRequestV1Schema>;

export const WorkspaceSyncPathSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('included') }),
  z.strictObject({
    status: z.literal('excluded'),
    reason: z.enum(['repository_metadata', 'submodule', 'configured_rule', 'git_ignore']),
  }),
  z.strictObject({
    status: z.literal('unknown'),
    reason: z.enum(['endpoint_unavailable', 'selection_unavailable']),
  }),
]));
export type WorkspaceSyncPathSelectionV1 = z.infer<typeof WorkspaceSyncPathSelectionV1Schema>;

/**
 * Caller-visible per-link selection query. The controller resolves the live
 * relationship, side, and endpoint authority from current settings; the
 * caller never supplies a root. The decision comes from the endpoint-local
 * engine evaluator, never from configuration guesses.
 */
export const WorkspaceSyncSelectionDiagnoseV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  side: z.enum(['alpha', 'beta']),
  path: WorkspaceSyncRelativePathV1Schema,
}));
export type WorkspaceSyncSelectionDiagnoseV1 = z.infer<typeof WorkspaceSyncSelectionDiagnoseV1Schema>;

/**
 * Target-daemon selection request. The selected side is resolved by the
 * controller before forwarding, and the receiving daemon evaluates it at its
 * retained endpoint root through the same engine producer.
 */
export const WorkspaceSyncTargetSelectionDiagnoseV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  path: WorkspaceSyncRelativePathV1Schema,
}));
export type WorkspaceSyncTargetSelectionDiagnoseV1 = z.infer<typeof WorkspaceSyncTargetSelectionDiagnoseV1Schema>;

const WorkspaceSyncConflictInspectSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  side: z.enum(['alpha', 'beta']),
  decision: WorkspaceSyncPathSelectionV1Schema,
}));

export const WorkspaceSyncConflictInspectEndpointV1Schema = lazyZodSchema(() => z.strictObject({
  workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  outcome: z.enum(['observed', 'changed', 'unreachable', 'unsupported', 'revoked']),
  observation: z.optional(WorkspaceSyncEntryExpectationV1Schema),
  selections: z.readonly(z.array(WorkspaceSyncConflictInspectSelectionV1Schema)),
}).check(z.superRefine((value, context) => {
  if (value.outcome === 'observed' && value.observation === undefined) {
    context.addIssue({
      code: "custom",
      path: ['observation'],
      message: 'an observed endpoint requires its canonical entry observation',
    });
  } else if (value.outcome !== 'observed' && value.observation !== undefined) {
    context.addIssue({
      code: "custom",
      path: ['observation'],
      message: 'only an observed endpoint carries a verified entry observation',
    });
  }
})));
export type WorkspaceSyncConflictInspectEndpointV1 = z.infer<typeof WorkspaceSyncConflictInspectEndpointV1Schema>;

const WorkspaceSyncConflictInspectVersionV1Schema = lazyZodSchema(() => z.strictObject({
  endpointWorkspaceRefIds: z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH))).check(z.minLength(1))),
  entry: WorkspaceSyncEntryExpectationV1Schema,
  preview: z.optional(z.strictObject({
    workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
    preview: ReadWorkspaceSyncFileResultV1Schema,
  })),
}).check(z.superRefine((value, context) => {
  if (value.preview !== undefined && !value.endpointWorkspaceRefIds.includes(value.preview.workspaceRefId)) {
    context.addIssue({
      code: "custom",
      path: ['preview', 'workspaceRefId'],
      message: 'a version preview must come from one of its grouped endpoints',
    });
  }
})));

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

export const WorkspaceSyncConflictInspectRpcResultV1Schema = lazyZodSchema(() => z.strictObject({
  controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  hubWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  path: WorkspaceSyncRelativePathV1Schema,
  endpoints: z.readonly(z.array(WorkspaceSyncConflictInspectEndpointV1Schema).check(z.minLength(1))),
  versions: z.readonly(z.array(WorkspaceSyncConflictInspectVersionV1Schema)),
  preservationOptions: z.optional(z.readonly(z.array(z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      source: WorkspaceSyncResolutionEndpointV1Schema,
      destination: z.strictObject({
        workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
        path: WorkspaceSyncRelativePathV1Schema,
        expected: WorkspaceSyncEntryExpectationV1Schema,
      }),
      consequence: z.strictObject({
        propagatingToWorkspaceRefIds: z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)))),
        unverifiedPropagationToWorkspaceRefIds: z.optional(z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH))))),
      }),
    }),
    z.strictObject({
      status: z.literal('name_conflict'),
      source: WorkspaceSyncResolutionEndpointV1Schema,
      proposed: z.strictObject({
        workspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
        path: WorkspaceSyncRelativePathV1Schema,
      }),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      source: WorkspaceSyncResolutionEndpointV1Schema,
      reason: z.enum(['path_unavailable', 'destination_unavailable', 'selection_unavailable']),
    }),
  ])))),
  coverage: z.strictObject({ complete: z.boolean() }),
}).check(z.superRefine((value, context) => {
  const previewCount = value.versions.filter((version) => version.preview !== undefined).length;
  if (previewCount > 1) {
    context.addIssue({
      code: "custom",
      path: ['versions'],
      message: 'an inspection carries at most one bounded version preview',
    });
  }
  for (const [index, endpoint] of value.endpoints.entries()) {
    const matching = value.versions.filter((version) => version.endpointWorkspaceRefIds.includes(endpoint.workspaceRefId));
    if (endpoint.outcome === 'observed') {
      if (matching.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ['endpoints', index, 'workspaceRefId'],
          message: 'an observed endpoint belongs to exactly one version',
        });
      } else if (endpoint.observation !== undefined
        && !areWorkspaceSyncEntryExpectationsEqual(matching[0]!.entry, endpoint.observation)) {
        context.addIssue({
          code: "custom",
          path: ['endpoints', index, 'observation'],
          message: 'a version entry must equal its endpoint observation',
        });
      }
    } else if (matching.length > 0) {
      context.addIssue({
        code: "custom",
        path: ['endpoints', index, 'workspaceRefId'],
        message: 'an unobserved endpoint is never a verified version',
      });
    }
  }
})));
export type WorkspaceSyncConflictInspectRpcResultV1 = z.infer<typeof WorkspaceSyncConflictInspectRpcResultV1Schema>;

/** The same domain projection serves the Action and its controller transport. */
export const WorkspaceSyncConflictInspectActionOutputV1Schema = WorkspaceSyncConflictInspectRpcResultV1Schema;
export type WorkspaceSyncConflictInspectActionOutputV1 = z.infer<typeof WorkspaceSyncConflictInspectActionOutputV1Schema>;

export const WorkspaceSyncEndpointStatusV1Schema = lazyZodSchema(() => z.strictObject({
  connected: z.boolean(),
  scanned: z.boolean(),
  scanProblemCount: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  transitionProblemCount: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
export type WorkspaceSyncEndpointStatusV1 = z.infer<typeof WorkspaceSyncEndpointStatusV1Schema>;

export const WorkspaceSyncStatusV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
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
  alphaPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
  betaPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
  mode: WorkspaceSyncModeV1Schema,
  endpointStates: z.strictObject({
    alpha: z.nullable(WorkspaceSyncEndpointStatusV1Schema),
    beta: z.nullable(WorkspaceSyncEndpointStatusV1Schema),
  }),
  conflictCount: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  lastCycleObservedAtMs: z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
  /** Known clean flush completion; absent/null on older producers or after runtime history is lost. */
  lastCleanSyncAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)))),
  errorCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_ERROR_CODE_LENGTH))),
}));
export type WorkspaceSyncStatusV1 = z.infer<typeof WorkspaceSyncStatusV1Schema>;

/** Private current-development Machine watch; the daemon owns its park window. */
export const WorkspaceSyncStatusWatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sinceRevision: z.optional(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
}));
export type WorkspaceSyncStatusWatchRequestV1 = z.infer<typeof WorkspaceSyncStatusWatchRequestV1Schema>;
export const WorkspaceSyncStatusWatchSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  revision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  statuses: z.readonly(z.array(WorkspaceSyncStatusV1Schema)),
}));
export type WorkspaceSyncStatusWatchSnapshotV1 = z.infer<typeof WorkspaceSyncStatusWatchSnapshotV1Schema>;
export const WorkspaceSyncStatusWatchResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('changed', [
  z.strictObject({ changed: z.literal(false) }),
  z.strictObject({ changed: z.literal(true), snapshot: WorkspaceSyncStatusWatchSnapshotV1Schema }),
]));
export type WorkspaceSyncStatusWatchResultV1 = z.infer<typeof WorkspaceSyncStatusWatchResultV1Schema>;

/**
 * Controller-scoped relationship inventory for the read Actions. The queried
 * controller is addressed by transport; it never appears in the body. An
 * optional member ref narrows the result to the relationships that contain
 * it, including same-Account discovery references to relationships owned by
 * another controller whose live status stays unknown until queried there.
 */
export const WorkspaceSyncRelationshipsListRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  workspaceRefId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH))),
}));
export type WorkspaceSyncRelationshipsListRpcRequestV1 = z.infer<typeof WorkspaceSyncRelationshipsListRpcRequestV1Schema>;

const WorkspaceSyncRelationshipWithStatusV1Schema = lazyZodSchema(() => z.strictObject({
  definition: WorkspaceSyncRelationshipV1Schema,
  status: z.nullable(WorkspaceSyncStatusV1Schema),
}));

const WorkspaceSyncRemoteRelationshipV1Schema = lazyZodSchema(() => z.strictObject({
  definition: WorkspaceSyncRelationshipV1Schema,
  controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
}).check(z.superRefine((value, context) => {
  if (value.definition.controllerMachineId !== value.controllerMachineId) {
    context.addIssue({
      code: "custom",
      path: ['controllerMachineId'],
      message: 'remote relationship controller must match its definition',
    });
  }
})));

const WorkspaceSyncDerivedSetV1Schema = lazyZodSchema(() => z.strictObject({
  hubWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  relationshipIds: z.readonly(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))).check(z.minLength(1))),
}));

export const WorkspaceSyncRelationshipsListRpcResultV1Schema = lazyZodSchema(() => z.strictObject({
  controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  sets: z.readonly(z.array(WorkspaceSyncDerivedSetV1Schema)),
  relationships: z.readonly(z.array(WorkspaceSyncRelationshipWithStatusV1Schema)),
  remoteRelationships: z.readonly(z.array(WorkspaceSyncRemoteRelationshipV1Schema)),
  membership: z.strictObject({
    workspaceRefId: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH))),
    found: z.nullable(z.boolean()),
  }),
  discoveryAvailable: z.boolean(),
}).check(z.superRefine((value, context) => {
  if (value.membership.workspaceRefId === null && value.membership.found !== null) {
    context.addIssue({
      code: "custom",
      path: ['membership', 'found'],
      message: 'unfiltered membership cannot claim a found result',
    });
  }
  if (value.membership.workspaceRefId !== null && value.membership.found === null) {
    context.addIssue({
      code: "custom",
      path: ['membership', 'found'],
      message: 'filtered membership must report whether the member was found',
    });
  }
  if (value.membership.workspaceRefId === null && value.remoteRelationships.length > 0) {
    context.addIssue({
      code: "custom",
      path: ['remoteRelationships'],
      message: 'remote discovery requires a member filter',
    });
  }
  for (const [index, entry] of value.relationships.entries()) {
    if (entry.definition.controllerMachineId !== value.controllerMachineId) {
      context.addIssue({
        code: "custom",
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
          code: "custom",
          path: ['sets', index, 'relationshipIds'],
          message: 'a relationship belongs to at most one derived set',
        });
      }
      seenRelationshipIds.add(relationshipId);
    }
  }
})));
export type WorkspaceSyncRelationshipsListRpcResultV1 = z.infer<typeof WorkspaceSyncRelationshipsListRpcResultV1Schema>;

/**
 * Agent/UI read input. The controller is explicit when the caller already
 * knows it; otherwise the executor queries the session machine. At least one
 * of the two is required so the request always names its authority scope.
 */
export const WorkspaceSyncRelationshipsListActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  controllerMachineId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH))),
  workspaceRefId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH))),
}).check(z.superRefine((value, context) => {
  if (value.controllerMachineId === undefined && value.workspaceRefId === undefined) {
    context.addIssue({
      code: "custom",
      message: 'relationships.list requires a controller or a workspace member',
    });
  }
})));
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
  return z.string().check(z.minLength(1), z.maxLength(max), z.refine((value) => value === value.trim(), 'value must not carry surrounding whitespace'));
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
export const WorkspaceSyncRelationshipCreateActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sourceWorkspaceRefId: exactBoundedString(MAX_WORKSPACE_REF_ID_LENGTH),
  targetMachineId: exactBoundedString(MAX_MACHINE_ID_LENGTH),
  targetPath: exactBoundedString(MAX_PATH_LENGTH),
  mode: WorkspaceSyncPersistentModeV1Schema,
  contentPolicy: WorkspaceContentPolicyV1Schema,
  destinationIntent: WorkspaceSyncDestinationIntentV1Schema,
  purpose: z.optional(z.literal('worker_clean_copy')),
}));
export type WorkspaceSyncRelationshipCreateActionInputV1 = z.infer<
  typeof WorkspaceSyncRelationshipCreateActionInputV1Schema
>;

/** Exact authority subject for permanently stopping one persisted relationship. */
export const WorkspaceSyncRelationshipTerminateActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  controllerMachineId: exactBoundedString(MAX_MACHINE_ID_LENGTH),
  relationshipId: exactBoundedString(MAX_RELATIONSHIP_ID_LENGTH),
}));
export type WorkspaceSyncRelationshipTerminateActionInputV1 = z.infer<
  typeof WorkspaceSyncRelationshipTerminateActionInputV1Schema
>;

/** Semantic acknowledgement from the existing relationship lifecycle owner. */
export const WorkspaceSyncRelationshipTerminateActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  relationshipId: exactBoundedString(MAX_RELATIONSHIP_ID_LENGTH),
  terminated: z.literal(true),
}));
export type WorkspaceSyncRelationshipTerminateActionOutputV1 = z.infer<
  typeof WorkspaceSyncRelationshipTerminateActionOutputV1Schema
>;

/** Exact authority subject for pausing one persisted relationship. */
export const WorkspaceSyncRelationshipDisableActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  controllerMachineId: exactBoundedString(MAX_MACHINE_ID_LENGTH),
  relationshipId: exactBoundedString(MAX_RELATIONSHIP_ID_LENGTH),
}));
export type WorkspaceSyncRelationshipDisableActionInputV1 = z.infer<
  typeof WorkspaceSyncRelationshipDisableActionInputV1Schema
>;
export const WorkspaceSyncRelationshipDisableActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  relationshipId: exactBoundedString(MAX_RELATIONSHIP_ID_LENGTH),
  enabled: z.literal(false),
}));
export type WorkspaceSyncRelationshipDisableActionOutputV1 = z.infer<
  typeof WorkspaceSyncRelationshipDisableActionOutputV1Schema
>;

/** Exact authority subject for resuming one persisted relationship. */
export const WorkspaceSyncRelationshipEnableActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  controllerMachineId: exactBoundedString(MAX_MACHINE_ID_LENGTH),
  relationshipId: exactBoundedString(MAX_RELATIONSHIP_ID_LENGTH),
}));
export type WorkspaceSyncRelationshipEnableActionInputV1 = z.infer<
  typeof WorkspaceSyncRelationshipEnableActionInputV1Schema
>;
export const WorkspaceSyncRelationshipEnableActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  relationshipId: exactBoundedString(MAX_RELATIONSHIP_ID_LENGTH),
  enabled: z.literal(true),
}));
export type WorkspaceSyncRelationshipEnableActionOutputV1 = z.infer<
  typeof WorkspaceSyncRelationshipEnableActionOutputV1Schema
>;

/** Exact authority subject for synchronizing one persisted relationship now. */
export const WorkspaceSyncRelationshipFlushActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  controllerMachineId: exactBoundedString(MAX_MACHINE_ID_LENGTH),
  relationshipId: exactBoundedString(MAX_RELATIONSHIP_ID_LENGTH),
}));
export type WorkspaceSyncRelationshipFlushActionInputV1 = z.infer<
  typeof WorkspaceSyncRelationshipFlushActionInputV1Schema
>;
export const WorkspaceSyncRelationshipFlushActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  relationshipId: exactBoundedString(MAX_RELATIONSHIP_ID_LENGTH),
  status: WorkspaceSyncStatusV1Schema,
}));
export type WorkspaceSyncRelationshipFlushActionOutputV1 = z.infer<
  typeof WorkspaceSyncRelationshipFlushActionOutputV1Schema
>;

/**
 * The committed relationship. `created` is `false` when this operation opened
 * an existing definition for the same endpoint pair rather than persisting a
 * new one. `status` is the real engine status observed at commit: initial
 * conflicts from attaching a divergent existing checkout are a successful link
 * that needs attention, not a failed creation.
 */
export const WorkspaceSyncRelationshipCreateResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  created: z.boolean(),
  controllerMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  sourceWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  targetWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH)),
  status: WorkspaceSyncStatusV1Schema,
}));
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
export const WorkspaceSyncRelationshipCreateRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  actionInput: WorkspaceSyncRelationshipCreateActionInputV1Schema,
  targetReplacementApproval: z.optional(HandoffTargetReplacementApprovalV1Schema),
  targetReplacementApprovalReceiptId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))),
}).check(z.superRefine((value, context) => {
  if ((value.targetReplacementApproval === undefined)
    !== (value.targetReplacementApprovalReceiptId === undefined)) {
    context.addIssue({
      code: "custom",
      path: ['targetReplacementApprovalReceiptId'],
      message: 'target replacement approval requires its Action receipt',
    });
  }
})));
export type WorkspaceSyncRelationshipCreateRpcRequestV1 = z.infer<
  typeof WorkspaceSyncRelationshipCreateRpcRequestV1Schema
>;

/** Read-back of an admitted operation; never authorizes creation or bootstrap. */
export const WorkspaceSyncRelationshipCreationObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('unknown') }),
  z.strictObject({ outcome: z.literal('failed'), errorCode: z.enum([
    'workspace_sync_relationship_not_committed', 'workspace_sync_copy_absent',
  ]) }),
  z.strictObject({ outcome: z.literal('succeeded'), relationshipId: exactBoundedString(MAX_RELATIONSHIP_ID_LENGTH),
    controllerMachineId: exactBoundedString(MAX_MACHINE_ID_LENGTH), sourceWorkspaceRefId: exactBoundedString(MAX_WORKSPACE_REF_ID_LENGTH),
    targetWorkspaceRefId: exactBoundedString(MAX_WORKSPACE_REF_ID_LENGTH) }),
]));
export type WorkspaceSyncRelationshipCreationObservationV1 = z.infer<typeof WorkspaceSyncRelationshipCreationObservationV1Schema>;

const WorkspaceSyncReadyComponentV1Schema = lazyZodSchema(() => z.strictObject({ state: z.literal('ready') }));
const WorkspaceSyncUnavailableComponentV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.literal('unavailable'),
  errorCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_ERROR_CODE_LENGTH)),
}));

export const WorkspaceSyncRuntimeReadinessV1Schema = lazyZodSchema(() => z.strictObject({
  engine: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('starting') }),
    WorkspaceSyncReadyComponentV1Schema,
    WorkspaceSyncUnavailableComponentV1Schema,
  ]),
  carrier: z.discriminatedUnion('state', [
    WorkspaceSyncReadyComponentV1Schema,
    z.strictObject({
      state: z.literal('unavailable'),
      errorCode: z.literal('machine_carrier_unavailable'),
    }),
  ]),
}));
export type WorkspaceSyncRuntimeReadinessV1 = z.infer<typeof WorkspaceSyncRuntimeReadinessV1Schema>;

/**
 * One bounded readiness publication carried by the existing Machine
 * daemon-state channel. Readiness is always present so a client never infers
 * engine or carrier availability from paths or machine metadata. Private
 * relationship status remains at admitted relationship reads. The enclosing
 * daemon-state version provides ordering and this event carries no independent
 * cursor or persisted history.
 */
export const WorkspaceSyncRuntimeEventV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  readiness: WorkspaceSyncRuntimeReadinessV1Schema,
}));
export type WorkspaceSyncRuntimeEventV1 = z.infer<typeof WorkspaceSyncRuntimeEventV1Schema>;

/**
 * Post-commit cleanup debt. The operation succeeded and its durable state is
 * published; only a best-effort release failed, so this is reported rather than
 * turned into a failure.
 */
export const WorkspaceSyncCleanupWarningV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_ERROR_CODE_LENGTH)),
  message: z.string().check(z.trim(), z.minLength(1), z.maxLength(2048)),
}));
export type WorkspaceSyncCleanupWarningV1 = z.infer<typeof WorkspaceSyncCleanupWarningV1Schema>;

export const WorkspaceSyncLegacyStateInspectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('absent') }),
  z.strictObject({
    status: z.literal('preserved'),
    path: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
  }),
  // Read older development-daemon diagnostics; current daemons never quarantine.
  z.strictObject({
    status: z.literal('legacy_workspace_sync_state_unsupported'),
    classification: z.literal('retired_v1'),
    quarantinePath: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
    schemaVersion: z.literal(1),
  }),
  z.strictObject({
    status: z.literal('legacy_workspace_sync_state_unknown'),
    path: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
    reason: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_ERROR_CODE_LENGTH)),
  }),
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
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('copied'),
    operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
    status: z.optional(WorkspaceSyncStatusV1Schema),
    cleanupWarning: z.optional(WorkspaceSyncCleanupWarningV1Schema),
  }),
  z.strictObject({
    kind: z.literal('relationship'),
    relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
    /** `true` when this handoff persisted a new relationship; `false` when an exact existing definition was reused. */
    created: z.boolean(),
    status: z.optional(WorkspaceSyncStatusV1Schema),
    cleanupWarning: z.optional(WorkspaceSyncCleanupWarningV1Schema),
  }),
  z.strictObject({
    kind: z.literal('linked_workspace'),
    traversed: z.readonly(z.array(z.strictObject({
      relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
      policyDigest: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
      status: WorkspaceSyncStatusV1Schema,
    })).check(z.maxLength(2))),
    cleanupWarning: z.optional(WorkspaceSyncCleanupWarningV1Schema),
  }),
]));
export type HandoffWorkspaceOutcomeV1 = z.infer<typeof HandoffWorkspaceOutcomeV1Schema>;

export const HandoffWorkspaceActionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('copy_once'),
    contentPolicy: WorkspaceContentPolicyV1Schema,
  }),
  z.strictObject({
    kind: z.literal('create_relationship'),
    mode: WorkspaceSyncPersistentModeV1Schema,
    contentPolicy: WorkspaceContentPolicyV1Schema,
    flushBeforeCommit: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal('relationship'),
    relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
    flushBeforeCommit: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('linked_workspace') }),
]));
export type HandoffWorkspaceActionV1 = z.infer<typeof HandoffWorkspaceActionV1Schema>;

export const WorkspaceSyncPrepareBetweenRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sourceWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  targetWorkspaceRefId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
}));
export type WorkspaceSyncPrepareBetweenRequestV1 = z.infer<typeof WorkspaceSyncPrepareBetweenRequestV1Schema>;

const WorkspaceSyncTraversedRelationshipV1Schema = lazyZodSchema(() => z.strictObject({
  relationshipId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  policyDigest: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  status: WorkspaceSyncStatusV1Schema,
}));
export const WorkspaceSyncPrepareBetweenResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    traversed: z.readonly(z.array(WorkspaceSyncTraversedRelationshipV1Schema).check(z.maxLength(2))),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_ERROR_CODE_LENGTH)),
    completed: z.readonly(z.array(WorkspaceSyncTraversedRelationshipV1Schema).check(z.maxLength(1))),
    blockedRelationshipId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))),
    blockedStatus: z.optional(WorkspaceSyncStatusV1Schema),
  }),
]));
export type WorkspaceSyncPrepareBetweenResultV1 = z.infer<typeof WorkspaceSyncPrepareBetweenResultV1Schema>;

/** Private source workspace phases retain the admitted child namespace, not physical aliases. */
export const WorkspaceSyncHandoffSourceInputV1Schema = lazyZodSchema(() => z.strictObject({
  operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  accountServerId: z.string().check(z.trim(), z.minLength(1)),
  sourceSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  action: HandoffWorkspaceActionV1Schema.check(z.refine(action => action.kind === 'copy_once' || action.kind === 'create_relationship')),
  sourceMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  targetMachineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_MACHINE_ID_LENGTH)),
  sourceWorkspaceRefId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH))),
  targetWorkspaceRefId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_WORKSPACE_REF_ID_LENGTH))),
  sourceRootPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
  targetRootPath: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PATH_LENGTH)),
  targetReplacementApproval: z.optional(HandoffTargetReplacementApprovalV1Schema),
  targetReplacementApprovalReceiptId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))),
  // The incumbent receipt authorizer parses this original Action, never the physical mapping.
  targetReplacementApprovalActionInput: z.optional(z.unknown()),
}));
export type WorkspaceSyncHandoffSourceInputV1 = z.infer<typeof WorkspaceSyncHandoffSourceInputV1Schema>;

export const WorkspaceSyncHandoffPreparedV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['none', 'copy_once', 'create_relationship', 'relationship', 'linked_workspace']),
  operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  relationshipId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))),
  relationshipCreated: z.optional(z.boolean()),
  action: HandoffWorkspaceActionV1Schema,
  status: z.optional(WorkspaceSyncStatusV1Schema),
  traversed: z.optional(z.readonly(z.array(WorkspaceSyncTraversedRelationshipV1Schema).check(z.maxLength(2)))),
}).check(z.refine(value => value.kind === value.action.kind)));
export type WorkspaceSyncHandoffPreparedV1 = z.infer<typeof WorkspaceSyncHandoffPreparedV1Schema>;
export const WorkspaceSyncHandoffSettledV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['none', 'copy_once', 'create_relationship', 'relationship', 'linked_workspace']),
  operationId: z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH)),
  relationshipId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_RELATIONSHIP_ID_LENGTH))),
  relationshipCreated: z.optional(z.boolean()),
  status: z.optional(WorkspaceSyncStatusV1Schema),
  traversed: z.optional(z.readonly(z.array(WorkspaceSyncTraversedRelationshipV1Schema).check(z.maxLength(2)))),
}));
export type WorkspaceSyncHandoffSettledV1 = z.infer<typeof WorkspaceSyncHandoffSettledV1Schema>;
export const WorkspaceSyncHandoffSourcePhaseRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('phase', [
  z.strictObject({ v: z.literal(1), phase: z.literal('prepare'), input: WorkspaceSyncHandoffSourceInputV1Schema }),
  z.strictObject({ v: z.literal(1), phase: z.literal('finalize'), input: WorkspaceSyncHandoffSourceInputV1Schema,
    prepared: WorkspaceSyncHandoffPreparedV1Schema }),
  z.strictObject({ v: z.literal(1), phase: z.literal('commit'), input: WorkspaceSyncHandoffSourceInputV1Schema,
    prepared: WorkspaceSyncHandoffPreparedV1Schema }),
  z.strictObject({ v: z.literal(1), phase: z.literal('abort'), input: WorkspaceSyncHandoffSourceInputV1Schema,
    prepared: z.optional(WorkspaceSyncHandoffPreparedV1Schema) }),
]));
export type WorkspaceSyncHandoffSourcePhaseRequestV1 = z.infer<typeof WorkspaceSyncHandoffSourcePhaseRequestV1Schema>;
export const WorkspaceSyncHandoffSourcePhaseResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('phase', [
  z.strictObject({ v: z.literal(1), phase: z.literal('prepared'), prepared: WorkspaceSyncHandoffPreparedV1Schema }),
  z.strictObject({ v: z.literal(1), phase: z.literal('finalized'), result: WorkspaceSyncHandoffSettledV1Schema }),
  z.strictObject({ v: z.literal(1), phase: z.literal('committed'), result: WorkspaceSyncHandoffSettledV1Schema }),
  z.strictObject({ v: z.literal(1), phase: z.literal('aborted') }),
]));
export type WorkspaceSyncHandoffSourcePhaseResultV1 = z.infer<typeof WorkspaceSyncHandoffSourcePhaseResultV1Schema>;
