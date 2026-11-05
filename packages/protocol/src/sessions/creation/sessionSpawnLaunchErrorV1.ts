import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, SCOPED_RPC_SOCKET_CONNECTION_PHASES } from '../../rpc/errors.js';
import { utf8ByteLength } from '../../bugs/reports/utf8.js';
import { ConnectedServicePoolSelectionV1Schema } from '../../connect/connectedServicePoolSelection.js';
import { ConnectedServiceUxDiagnosticV1Schema } from '../../connect/connectedServiceUxDiagnostics.js';
import { SessionRuntimeFailureCauseV1Schema } from '../control/runtimeIssueV1.js';

/** Existing daemon child-stderr diagnostic budget, shared by producer and wire reader. */
export const SESSION_SPAWN_CHILD_STDERR_MAX_BYTES = 2_048;
const diagnosticText = () => z.string().check(z.refine(
  value => utf8ByteLength(value) <= SESSION_SPAWN_CHILD_STDERR_MAX_BYTES,
));

/** Closed, redacted presentation only; absence means the exit was not observed. */
const SessionSpawnChildExitV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.nullable(z.number().check(z.int())),
  signal: z.nullable(z.string().check(z.regex(/^SIG[A-Z0-9]+$/u))),
  stderrHead: z.optional(diagnosticText()),
  cause: z.optional(z.strictObject({
    kind: z.literal('module_not_found'),
    specifierBasename: diagnosticText().check(z.regex(/^[^/\\\u0000-\u001f\u007f]+$/u)),
  })),
}));

/** Redacted presentation of a failed launch; never launch or retry authority. */
export const SessionSpawnLaunchErrorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('launch_error'),
  code: z.string().check(z.regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u)),
  subtype: z.optional(z.enum(['writer_active', 'no_closure', 'closure_changed', 'check_failed'])),
  message: z.string().check(z.refine(value => value.trim().length > 0)),
  rpcErrorCode: z.optional(z.enum([MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES.OUTCOME_UNKNOWN, RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE])),
  connectionPhase: z.optional(z.enum(SCOPED_RPC_SOCKET_CONNECTION_PHASES)),
  childExit: z.optional(SessionSpawnChildExitV1Schema),
  failureCause: z.optional(SessionRuntimeFailureCauseV1Schema),
  uxDiagnostic: z.optional(ConnectedServiceUxDiagnosticV1Schema),
  connectedAccountPool: z.optional(z.strictObject({
    serviceId: z.string().check(z.minLength(1)),
    excluded: ConnectedServicePoolSelectionV1Schema.shape.excluded,
  })),
}));
export type SessionSpawnLaunchErrorV1 = z.infer<typeof SessionSpawnLaunchErrorV1Schema>;
