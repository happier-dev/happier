import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { SocketRpcSessionWriteAuthorizationContextSchema } from '../rpc/socket.js';
import { ScmBranchWorkEvidenceSchema } from './branches.js';
import { ScmPullRequestWorkEvidenceSchema } from './pullRequests.js';
import { ScmBackendPreferenceSchema } from './backendIdentity.js';

const sessionIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));

/** Public selectors carry no authority; Home replaces them with its decisions. */
export const ScmWorkEvidenceAuthorizationSelectorSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('scm.workEvidence'),
  sessionIds: z.array(sessionIdSchema),
}));
export type ScmWorkEvidenceAuthorizationSelector = z.infer<typeof ScmWorkEvidenceAuthorizationSelectorSchema>;

/** Only Home may produce this context, outside the encrypted caller payload. */
export const ScmWorkEvidenceAdmissionSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('scm.workEvidence.admitted'),
  admissions: z.array(z.union([
    SocketRpcSessionWriteAuthorizationContextSchema,
    z.strictObject({ kind: z.literal('refused'), sessionId: sessionIdSchema, errorCode: z.string().check(z.minLength(1)) }),
  ])),
}));
export type ScmWorkEvidenceAdmission = z.infer<typeof ScmWorkEvidenceAdmissionSchema>;

export const ScmWorkEvidenceReadRequestSchema = lazyZodSchema(() => z.strictObject({
  backendPreference: z.optional(ScmBackendPreferenceSchema),
  sessions: z.array(z.strictObject({
    sessionId: sessionIdSchema,
    cwd: z.string().check(z.minLength(1)),
    turnIds: z.array(z.string().check(z.minLength(1))),
  })).check(z.refine(sessions => new Set(sessions.map(session => session.sessionId)).size === sessions.length)),
}));
export type ScmWorkEvidenceReadRequest = z.infer<typeof ScmWorkEvidenceReadRequestSchema>;

/** Per-Session failures withdraw only that Session's private witnesses. */
export const ScmWorkEvidenceSessionResultSchema = lazyZodSchema(() => z.strictObject({
  sessionId: sessionIdSchema,
  status: z.enum(['partial', 'unsupported', 'error', 'unknown']),
  evidence: z.optional(z.array(ScmPullRequestWorkEvidenceSchema)),
  branchEvidence: z.optional(z.array(ScmBranchWorkEvidenceSchema)),
  errorCode: z.optional(z.string().check(z.minLength(1))),
}));
export type ScmWorkEvidenceSessionResult = z.infer<typeof ScmWorkEvidenceSessionResultSchema>;
export const ScmWorkEvidenceReadResponseSchema = lazyZodSchema(() => z.strictObject({
  sessions: z.array(ScmWorkEvidenceSessionResultSchema),
}));
export type ScmWorkEvidenceReadResponse = z.infer<typeof ScmWorkEvidenceReadResponseSchema>;
