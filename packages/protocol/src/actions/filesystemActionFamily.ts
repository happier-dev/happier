import { FILESYSTEM_ACTION_IDS, FILESYSTEM_MUTATION_ACTION_IDS, FILESYSTEM_TRANSFER_ACTION_IDS } from './filesystemActionIdsV1.js';
export { FILESYSTEM_ACTION_IDS, FILESYSTEM_MUTATION_ACTION_IDS, FILESYSTEM_TRANSFER_ACTION_IDS } from './filesystemActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { TransferEndpointCandidateSchema } from '../machines/transfer/transferStream.js';
import { WorkspaceSyncEntryExpectationV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';

export const FILESYSTEM_WRITE_GUARD_ERROR_CODES = ['hash_mismatch', 'expected_file_missing', 'expected_file_absent'] as const;
export type FilesystemWriteGuardErrorCode = typeof FILESYSTEM_WRITE_GUARD_ERROR_CODES[number];
export function isFilesystemWriteGuardErrorCode(value: unknown): value is FilesystemWriteGuardErrorCode {
  return typeof value === 'string' && (FILESYSTEM_WRITE_GUARD_ERROR_CODES as readonly string[]).includes(value);
}





export type FilesystemActionId = typeof FILESYSTEM_ACTION_IDS[number];
export type FilesystemMutationActionId = typeof FILESYSTEM_MUTATION_ACTION_IDS[number];
export type FilesystemTransferActionId = typeof FILESYSTEM_TRANSFER_ACTION_IDS[number];

export function isFilesystemActionId(value: string): value is FilesystemActionId {
  return (FILESYSTEM_ACTION_IDS as readonly string[]).includes(value);
}

const FilesystemFailureSchema = lazyZodSchema(() => z.strictObject({
  success: z.literal(false), error: z.string(), errorCode: z.optional(z.string()),
}));

export const FilesystemReadFileInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)),
  offset: z.optional(z.number().check(z.int(), z.nonnegative())),
  length: z.optional(z.number().check(z.int(), z.positive())),
}).check(z.refine(input => input.offset === undefined || input.length !== undefined, {
  message: 'A byte offset requires a read length', path: ['length'],
})));
export const FilesystemReadFileOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ success: z.literal(true), content: z.string(),
    sizeBytes: z.optional(z.number().check(z.int(), z.nonnegative())), eof: z.optional(z.boolean()) }),
  FilesystemFailureSchema,
]));
export const FilesystemWriteFileInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)), content: z.string(),
  expectedHash: z.optional(z.nullable(z.string())),
}));
export const FilesystemWriteFileOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ success: z.literal(true), hash: z.string().check(z.minLength(1)) }),
  FilesystemFailureSchema,
]));
export const FilesystemDirectoryEntrySchema = lazyZodSchema(() => z.strictObject({
  name: z.string(), type: z.enum(['file', 'directory', 'other']), size: z.optional(z.number()),
  modified: z.optional(z.number()), gitIgnored: z.optional(z.boolean()),
}));
export const FilesystemListDirectoryInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)), includeGitIgnore: z.optional(z.boolean()),
}));
export const FilesystemListDirectoryOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ success: z.literal(true), entries: z.array(FilesystemDirectoryEntrySchema),
    truncated: z.optional(z.boolean()), gitIgnoreAvailable: z.optional(z.boolean()) }),
  FilesystemFailureSchema,
]));
export interface FilesystemTreeNode {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly size?: number;
  readonly modified?: number;
  readonly children?: readonly FilesystemTreeNode[];
}
export const FilesystemTreeNodeSchema: z.ZodMiniType<FilesystemTreeNode> = z.lazy(() => z.strictObject({
  name: z.string(), path: z.string(), type: z.enum(['file', 'directory']), size: z.optional(z.number()),
  modified: z.optional(z.number()), children: z.optional(z.array(FilesystemTreeNodeSchema)),
}));
export const FilesystemGetDirectoryTreeInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)), maxDepth: z.number().check(z.int(), z.nonnegative()),
}));
export const FilesystemGetDirectoryTreeOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ success: z.literal(true), tree: FilesystemTreeNodeSchema, truncated: z.optional(z.boolean()) }),
  FilesystemFailureSchema,
]));

// These are public Action schemas: their classic carriers supply the existing
// author DTO/JSON-schema projections, constructed lazily at this public seam.
export const FilesystemCreateDirectoryInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)),
  path: z.string().check(z.minLength(1)),
}));
export const FilesystemRenameInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)),
  from: z.string().check(z.minLength(1)),
  to: z.string().check(z.minLength(1)),
  overwrite: z.boolean(),
}));
export const FilesystemDeleteInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)),
  path: z.string().check(z.minLength(1)),
  recursive: z.boolean(),
}));
export const FilesystemLocalCopyInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)),
  from: z.string().check(z.minLength(1)),
  to: z.string().check(z.minLength(1)),
  overwrite: z.boolean(),
  recursive: z.boolean(),
}));
export const FilesystemEntryTreeDescriptorSchema = lazyZodSchema(() => z.strictObject({
  operationId: z.string().check(z.minLength(1)),
  expectation: WorkspaceSyncEntryExpectationV1Schema,
  blobs: z.array(z.strictObject({ transferId: z.string().check(z.minLength(1)), sizeBytes: z.number().check(z.int(), z.nonnegative()),
    manifestHash: z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/i)) })),
}));
const FilesystemPreparedCopyFileSourceSchema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('file'),
    serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
    rootPath: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)),
    sourceId: z.string().check(z.minLength(1)), sizeBytes: z.number().check(z.int(), z.nonnegative()),
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/i)),
}));
const FilesystemPreparedCopyEntrySourceSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(FilesystemPreparedCopyFileSourceSchema, { kind: true }), { kind: z.literal('entry_tree'), entryTree: FilesystemEntryTreeDescriptorSchema })));
export const FilesystemPreparedCopyInputSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('prepared_transfer'),
  source: z.union([FilesystemPreparedCopyFileSourceSchema, FilesystemPreparedCopyEntrySourceSchema]),
  destination: z.strictObject({
    serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
    rootPath: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)),
  }),
  overwrite: z.boolean(), recursive: z.boolean(),
}));
export const FilesystemTargetCopyInputSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('target_copy'),
  source: z.strictObject({
    serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
    rootPath: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)),
  }),
  destination: z.strictObject({
    serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
    rootPath: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)),
  }),
  overwrite: z.boolean(), recursive: z.boolean(),
}));
export const FilesystemCopyInputSchema = lazyZodSchema(() => z.union([
  FilesystemLocalCopyInputSchema, FilesystemPreparedCopyInputSchema, FilesystemTargetCopyInputSchema,
]));
export const FilesystemMutationOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ success: z.literal(true) }),
  FilesystemFailureSchema,
]));

export type FilesystemCreateDirectoryInput = z.infer<typeof FilesystemCreateDirectoryInputSchema>;
export type FilesystemRenameInput = z.infer<typeof FilesystemRenameInputSchema>;
export type FilesystemDeleteInput = z.infer<typeof FilesystemDeleteInputSchema>;
export type FilesystemCopyInput = z.infer<typeof FilesystemCopyInputSchema>;
export type FilesystemLocalCopyInput = z.infer<typeof FilesystemLocalCopyInputSchema>;
export type FilesystemPreparedCopyInput = z.infer<typeof FilesystemPreparedCopyInputSchema>;
export type FilesystemTargetCopyInput = z.infer<typeof FilesystemTargetCopyInputSchema>;
export type FilesystemMutationOutput = z.infer<typeof FilesystemMutationOutputSchema>;

export const FilesystemUploadInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)),
  path: z.string().check(z.minLength(1)),
  source: z.strictObject({ sourceId: z.string().check(z.minLength(1)), sizeBytes: z.number().check(z.int(), z.nonnegative()),
    sha256: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/i))) }),
  overwrite: z.boolean(),
  expectedHash: z.optional(z.nullable(z.string())),
}));
export const FilesystemDownloadInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)),
  path: z.string().check(z.minLength(1)),
  destination: z.strictObject({ destinationId: z.string().check(z.minLength(1)) }),
  asZip: z.boolean(),
  format: z.optional(z.literal('entry_tree')),
}).check(z.refine(input => !input.format || !input.asZip, { message: 'Entry-tree export cannot also be a ZIP export' })));
export const FilesystemTransferCancelInputSchema = lazyZodSchema(() => z.strictObject({
  rootPath: z.string().check(z.minLength(1)), direction: z.enum(['upload', 'download']), transferId: z.string().check(z.minLength(1)),
}));

const PreparedFilesystemEndpointSchema = lazyZodSchema(() => z.intersection(TransferEndpointCandidateSchema, z.strictObject({
  kind: z.enum(['http', 'https']), url: z.string(), authorizationToken: z.optional(z.string()),
  expiresAt: z.number().check(z.int(), z.nonnegative()),
})));
const FilesystemTransferFailureSchema = lazyZodSchema(() => z.strictObject({
  success: z.literal(false), status: z.enum(['failed', 'cancelled', 'unknown']),
  error: z.string(), errorCode: z.optional(z.string()),
}));
export const FilesystemPreparedImportSchema = lazyZodSchema(() => z.strictObject({
  uploadId: z.string().check(z.minLength(1)), destDisplayPath: z.string().check(z.minLength(1)), expectedSizeBytes: z.number().check(z.int(), z.nonnegative()),
  chunkSizeBytes: z.number().check(z.int(), z.positive()), recipientPublicKeyBase64: z.string().check(z.minLength(1)),
  expiresAt: z.number().check(z.int(), z.positive()), endpointCandidates: z.array(PreparedFilesystemEndpointSchema),
}));
export const FilesystemPreparedExportSchema = lazyZodSchema(() => z.strictObject({
  transferId: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)), sizeBytes: z.number().check(z.int(), z.nonnegative()),
  manifestHash: z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/i)), expiresAt: z.number().check(z.int(), z.positive()),
  endpointCandidates: z.array(PreparedFilesystemEndpointSchema),
}));
export const FilesystemUploadOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ success: z.literal(true), status: z.literal('accepted'), operationId: z.string().check(z.minLength(1)),
    sourceId: z.string().check(z.minLength(1)), prepared: FilesystemPreparedImportSchema }),
  z.strictObject({ success: z.literal(true), status: z.literal('completed'), transferId: z.string().check(z.minLength(1)),
    sourceId: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)), sizeBytes: z.number().check(z.int(), z.nonnegative()),
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/i)) }),
  FilesystemTransferFailureSchema,
]));
export const FilesystemDownloadOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ success: z.literal(true), status: z.literal('accepted'), operationId: z.string().check(z.minLength(1)),
    destinationId: z.string().check(z.minLength(1)), prepared: FilesystemPreparedExportSchema, entryTree: FilesystemEntryTreeDescriptorSchema }),
  z.strictObject({ success: z.literal(true), status: z.literal('accepted'), operationId: z.string().check(z.minLength(1)),
    destinationId: z.string().check(z.minLength(1)), prepared: FilesystemPreparedExportSchema }),
  z.strictObject({ success: z.literal(true), status: z.literal('completed'), transferId: z.string().check(z.minLength(1)),
    destinationId: z.string().check(z.minLength(1)), name: z.string().check(z.minLength(1)), sizeBytes: z.number().check(z.int(), z.nonnegative()),
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/i)) }),
  FilesystemTransferFailureSchema,
]));
export const FilesystemTransferCancelOutputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ success: z.literal(true), aborted: z.boolean() }),
  z.strictObject({ success: z.literal(false), error: z.string(), errorCode: z.optional(z.string()) }),
]));
export type FilesystemUploadInput = z.infer<typeof FilesystemUploadInputSchema>;
export type FilesystemUploadOutput = z.infer<typeof FilesystemUploadOutputSchema>;
export type FilesystemDownloadInput = z.infer<typeof FilesystemDownloadInputSchema>;
export type FilesystemDownloadOutput = z.infer<typeof FilesystemDownloadOutputSchema>;
export type FilesystemTransferCancelInput = z.infer<typeof FilesystemTransferCancelInputSchema>;
export type FilesystemTransferCancelOutput = z.infer<typeof FilesystemTransferCancelOutputSchema>;
export const FilesystemCopyOutputSchema = lazyZodSchema(() => z.union([
  FilesystemMutationOutputSchema, FilesystemUploadOutputSchema,
  z.strictObject({ success: z.literal(true), status: z.literal('accepted'), operationId: z.string().check(z.minLength(1)), sourceId: z.string().check(z.minLength(1)),
    prepared: z.strictObject({ manifest: FilesystemPreparedImportSchema,
      blobs: z.array(z.strictObject({ transferId: z.string().check(z.minLength(1)), prepared: FilesystemPreparedImportSchema })) }) }),
  z.strictObject({ success: z.literal(true), status: z.literal('completed'), sourceId: z.string().check(z.minLength(1)),
    path: z.string().check(z.minLength(1)), expectation: WorkspaceSyncEntryExpectationV1Schema }),
]));
export type FilesystemCopyOutput = z.infer<typeof FilesystemCopyOutputSchema>;
export type FilesystemEntryTreeDescriptor = z.infer<typeof FilesystemEntryTreeDescriptorSchema>;

export { type FilesystemEffectFailureDetailsV1 } from '../machines/filesystemFailure.js';
