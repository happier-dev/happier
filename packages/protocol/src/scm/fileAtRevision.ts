import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ScmRequestBaseSchema } from './requestBase.js';
import { ScmCommitOidSchema } from './commitPublication.js';
import { ScmDiffAreaSchema } from './workingSnapshot.js';
import { ScmOperationErrorCodeSchema } from './operationError.js';
import { FilesystemPreparedExportSchema } from '../actions/filesystemActionFamily.js';

/** A literal repository path, not a Git revision expression or a pathspec. */
export const ScmFileAtRevisionRequestSchema = lazyZodSchema(() => z.strictObject({
  ...ScmRequestBaseSchema.shape,
  path: z.string().check(z.refine(path => path.length > 0 && !path.includes('\0')
    && !path.startsWith('/') && !path.startsWith('\\') && !/^[A-Za-z]:/.test(path)
    && path.replace(/\\/g, '/').split('/').every(part => part !== '..'),
  'Expected a repository-relative literal file path')),
  selector: z.union([
    z.strictObject({ blobId: ScmCommitOidSchema }),
    z.strictObject({ commit: ScmCommitOidSchema }),
    z.strictObject({ side: z.literal('before'), area: ScmDiffAreaSchema }),
  ]),
  /** Caller preview admission only; in-process restore readers omit it. */
  maxBytes: z.optional(z.number().check(z.int(), z.minimum(0))),
}));
export type ScmFileAtRevisionRequest = z.infer<typeof ScmFileAtRevisionRequestSchema>;

/** Current read projection: unknown fields are rejected, never interpreted as content. */
export const ScmFileAtRevisionResponseSchema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), contentBase64: z.string(),
    sizeBytes: z.number().check(z.int(), z.minimum(0)),
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  }),
  z.strictObject({ success: z.literal(false), errorCode: ScmOperationErrorCodeSchema, error: z.optional(z.string()) }),
]));
export type ScmFileAtRevisionResponse = z.infer<typeof ScmFileAtRevisionResponseSchema>;

/** RPC/Action delivery reuses prepared filesystem exports above the containing response budget. */
export const ScmFileReadResponseSchema = lazyZodSchema(() => z.union([
  ScmFileAtRevisionResponseSchema,
  z.strictObject({ success: z.literal(true),
    sizeBytes: z.number().check(z.int(), z.minimum(0)),
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    prepared: FilesystemPreparedExportSchema,
  }),
]));
export type ScmFileReadResponse = z.infer<typeof ScmFileReadResponseSchema>;
