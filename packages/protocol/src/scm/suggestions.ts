import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SessionTargetV1Schema } from '../actions/sessionTargetV1.js';
import { ScmCommitOidSchema } from './commitPublication.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

/** The original right-side lines on the review comment's original commit. */
export const ScmSuggestionV1Schema = lazyZodSchema(() => z.strictObject({
  path: z.string().check(z.minLength(1)),
  commitOid: ScmCommitOidSchema,
  startLine: z.number().check(z.int(), z.positive()),
  endLine: z.number().check(z.int(), z.positive()),
  originalLines: z.array(z.string().check(z.refine(line => !line.includes('\n')))),
  replacement: z.string(),
  outdated: z.boolean(),
}).check(z.refine(value => value.endLine >= value.startLine
  && value.originalLines.length === value.endLine - value.startLine + 1, 'Invalid suggestion line range')));
export type ScmSuggestionV1 = z.infer<typeof ScmSuggestionV1Schema>;
export const ScmSuggestionV1ProtocolSchema = projectZodProtocolSchema(ScmSuggestionV1Schema);

export const ScmSuggestionApplyRequestSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  cwd: z.optional(z.string()),
  suggestions: z.array(ScmSuggestionV1Schema).check(z.minLength(1)),
  outcomeVersion: z.optional(z.literal(1)),
}));
export type ScmSuggestionApplyRequest = z.infer<typeof ScmSuggestionApplyRequestSchema>;

export const ScmSuggestionApplyResponseSchema = lazyZodSchema(() => z.strictObject({
  success: z.boolean(),
  files: z.array(z.discriminatedUnion('status', [
    z.strictObject({ path: z.string(), status: z.literal('applied') }),
    z.strictObject({ path: z.string(), status: z.literal('refused'),
      errorCode: z.enum(['suggestion_conflict', 'suggestion_outdated', 'invalid_path', 'file_replace_failed']),
      error: z.string() }),
  ])),
}));
export type ScmSuggestionApplyResponse = z.infer<typeof ScmSuggestionApplyResponseSchema>;
