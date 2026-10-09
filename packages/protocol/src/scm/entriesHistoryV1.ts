import * as z from 'zod/mini';
import { ScmRequestBaseSchema } from './requestBase.js';
import { ScmCommitOidSchema } from './commitPublication.js';
import { ScmOperationErrorCodeSchema } from './operationError.js';

/** Literal, already-normalized repository identities. Never trim a filename. */
const literalPath = z.string().check(z.refine((path) => path === '' || (
    !path.includes('\0') && !path.includes('\\') && !path.startsWith('/') && !/^[A-Za-z]:\//.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
), 'Expected a normalized repository-relative literal path'));

/** Wire epoch 1: closed request, entries and commit facts; no retained history index. */
export const ScmHistoryEntriesInputV1Schema = z.lazy(() => z.strictObject({
    cwd: z.string().check(z.minLength(1)),
    backendPreference: z.optional(ScmRequestBaseSchema.shape.backendPreference.unwrap().strict()),
    outcomeVersion: ScmRequestBaseSchema.shape.outcomeVersion,
    folder: literalPath,
    paths: z.array(literalPath),
    headOid: z.optional(ScmCommitOidSchema),
}).check(z.refine(request => request.folder === '' || request.paths.every(path => path === request.folder || path.startsWith(`${request.folder}/`)),
    'Demanded entries must belong to the requested folder')));
export type ScmHistoryEntriesInputV1 = z.infer<typeof ScmHistoryEntriesInputV1Schema>;

export const ScmEntryHistoryV1Schema = z.lazy(() => z.discriminatedUnion('kind', [
    z.strictObject({ path: literalPath, kind: z.literal('commit'), commit: z.strictObject({
        oid: ScmCommitOidSchema, subject: z.string(), authorName: z.string(), committedAt: z.number().check(z.int()),
    }) }),
    z.strictObject({ path: literalPath, kind: z.literal('none') }),
    z.strictObject({ path: literalPath, kind: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }),
]));
export type ScmEntryHistoryV1 = z.infer<typeof ScmEntryHistoryV1Schema>;
export const ScmHistoryEntriesOutputV1Schema = z.lazy(() => z.strictObject({
    headOid: z.nullable(ScmCommitOidSchema), entries: z.array(ScmEntryHistoryV1Schema),
}));
export type ScmHistoryEntriesOutputV1 = z.infer<typeof ScmHistoryEntriesOutputV1Schema>;
export const ScmHistoryEntriesRequestSchema = ScmHistoryEntriesInputV1Schema;
export type ScmHistoryEntriesRequest = ScmHistoryEntriesInputV1;
export const ScmHistoryEntriesResponseSchema = z.lazy(() => z.discriminatedUnion('success', [
    z.strictObject({ success: z.literal(true), headOid: z.nullable(ScmCommitOidSchema), entries: z.array(ScmEntryHistoryV1Schema) }),
    z.strictObject({ success: z.literal(false), errorCode: ScmOperationErrorCodeSchema,
        error: z.optional(z.string()), headOid: z.optional(z.nullable(ScmCommitOidSchema)) }),
]));
export type ScmHistoryEntriesResponse = z.infer<typeof ScmHistoryEntriesResponseSchema>;
