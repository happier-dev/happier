import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ClientActionRpcFailureCodeV1Schema, readUnexpectedActionErrorDiagnosticV1 } from '../../actions/actionExecutionResult.js';

/** Passive-read evidence only; no receiver prose, request content or authority. */
export const ExecutionRunPreflightFailureV1Schema = lazyZodSchema(() => z.strictObject({
  phase: z.literal('capabilities.describe'),
  cause: z.strictObject({
    code: z.nullable(z.union([
      ClientActionRpcFailureCodeV1Schema,
      z.literal('server_scope_mismatch'),
      z.string().check(z.refine(code =>
        readUnexpectedActionErrorDiagnosticV1({ code }).errorCode === code
        || readUnexpectedActionErrorDiagnosticV1({ name: 'JsonRpcApplicationError', code: Number(code) }).errorCode === code)),
    ])),
  }),
}));
