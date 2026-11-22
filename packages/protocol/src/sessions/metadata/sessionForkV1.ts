import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';
import { SessionForkFilesNotCopiedV1Schema } from '../creation/sessionSpawnNewResultV1.js';
import { SessionForkVisualCopyV1Schema } from '../board/forkVisualCopies.js';

const IdentifierSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const OptionalRequestIdSchema = lazyZodSchema(() => z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000))));

/** One lineage shape for owner storage, stored reads and display projections. */
export const SessionForkV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  parentSessionId: IdentifierSchema,
  continuation: z.optional(z.literal(true)),
  parentCutoffSeqInclusive: z.number().check(z.int(), z.nonnegative()),
  createdAtMs: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  strategy: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  requestId: z.optional(OptionalRequestIdSchema),
  filesNotCopied: z.optional(SessionForkFilesNotCopiedV1Schema),
  visualCopies: z.optional(z.array(SessionForkVisualCopyV1Schema)),
  agentHint: z.optional(z.strictObject({
    agentId: z.optional(IdentifierSchema),
    backendMode: z.optional(IdentifierSchema),
    agentSessionId: z.optional(z.nullable(NonBlankOpaqueIdentifierSchema.check(z.maxLength(2_000)))),
  })),
}));

/** Compact owner display excludes native identities and copy outcomes. */
export const SessionForkDisplayV1Schema = lazyZodSchema(() => z.pick(SessionForkV1Schema, {
  v: true, parentSessionId: true, continuation: true,
  parentCutoffSeqInclusive: true, createdAtMs: true, strategy: true,
}));
