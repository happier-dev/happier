import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, SCOPED_RPC_SOCKET_CONNECTION_PHASES } from '../../rpc/errors.js';
import { utf8ByteLength } from '../../bugs/reports/utf8.js';
import { ConnectedServicePoolSelectionV1Schema } from '../../connect/connectedServicePoolSelection.js';
import { ConnectedServiceUxDiagnosticV1Schema } from '../../connect/connectedServiceUxDiagnostics.js';
import { SessionRuntimeFailureCauseV1Schema } from '../control/runtimeIssueV1.js';
import { MachineElevatedNotAppliedResultV1Schema, MachineElevationFailureV1Schema } from '../../machines/adminAccessV1.js';
import { MachineAgentIsolationProbeFailureV1Schema, MachineAgentIsolationUnavailableStatusV1Schema } from '../../machines/agentIsolationV1.js';
import { MachineTargetV1Schema } from '../../machines/machineAccessV1.js';
import { SpawnFailureV1Schema } from '../../machines/processes/spawnFailureV1.js';

/** Presentation of the requester's existing access; never a setup or permission grant. */
export const SessionAgentIsolationRefusalRemedyV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ask_machine_manager') }),
  z.strictObject({ kind: z.literal('open_machine_security'), target: MachineTargetV1Schema }),
]));

/** Closed presentation of native isolation refusal, shared by launch and install replies. */
export const SessionAgentIsolationRefusalV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.union([z.literal('member_setup_required'), MachineAgentIsolationUnavailableStatusV1Schema.shape.code]),
  phase: z.enum(['native_identity_binding', 'native_execution_preparation']),
  reasonCode: z.optional(MachineElevatedNotAppliedResultV1Schema.shape.reasonCode),
  nativeFailure: z.optional(z.pick(MachineElevationFailureV1Schema, { kind: true, reason: true, phase: true })),
  probeFailure: z.optional(MachineAgentIsolationProbeFailureV1Schema),
  readinessCode: z.optional(MachineAgentIsolationUnavailableStatusV1Schema.shape.code),
  operationErrorCode: z.optional(z.literal('machine_setup_operation_unavailable')),
  remedy: z.optional(SessionAgentIsolationRefusalRemedyV1Schema),
}));

/** Existing daemon child-stderr diagnostic budget, shared by producer and wire reader. */
export const SESSION_SPAWN_CHILD_STDERR_MAX_BYTES = 2_048;
const diagnosticText = () => z.string().check(z.refine(
  value => utf8ByteLength(value) <= SESSION_SPAWN_CHILD_STDERR_MAX_BYTES,
));

/** Closed, redacted presentation only; absence means the exit was not observed. */
export const SessionSpawnChildExitV1Schema = lazyZodSchema(() => z.strictObject({
  code: z.nullable(z.number().check(z.int())),
  signal: z.nullable(z.string().check(z.regex(/^SIG[A-Z0-9]+$/u))),
  stderrHead: z.optional(diagnosticText()),
  cause: z.optional(z.strictObject({
    kind: z.literal('module_not_found'),
    specifierBasename: diagnosticText().check(z.regex(/^[^/\\\u0000-\u001f\u007f]+$/u)),
  })),
}));

/** Payload-free failure of the Account observation required before Session birth. */
export const SessionCreationCurrentnessFailureV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.enum(['timeout', 'network', 'http_error', 'invalid_response']),
  retryable: z.boolean(),
  statusCode: z.optional(z.number().check(z.int(), z.gte(100), z.lte(599))),
}));

/** Redacted presentation of a failed launch; never launch or retry authority. */
export const SessionSpawnLaunchErrorV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('launch_error'),
  code: z.string().check(z.regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u)),
  subtype: z.optional(z.enum(['writer_active', 'no_closure', 'closure_changed', 'check_failed'])),
  message: z.string().check(z.refine(value => value.trim().length > 0)),
  rpcErrorCode: z.optional(z.enum([MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES.OUTCOME_UNKNOWN, RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE])),
  connectionPhase: z.optional(z.enum(SCOPED_RPC_SOCKET_CONNECTION_PHASES)),
  currentnessFailure: z.optional(SessionCreationCurrentnessFailureV1Schema),
  childExit: z.optional(SessionSpawnChildExitV1Schema),
  spawnFailure: z.optional(SpawnFailureV1Schema),
  failureCause: z.optional(SessionRuntimeFailureCauseV1Schema),
  pluginCodeRefusal: z.optional(z.strictObject({
    remedy: SessionAgentIsolationRefusalRemedyV1Schema,
  })),
  agentIsolationRefusal: z.optional(SessionAgentIsolationRefusalV1Schema),
  profileRefusal: z.optional(z.strictObject({
    profileId: z.string().check(z.trim(), z.minLength(1)),
    reason: z.enum(['profile_catalog_unavailable', 'profile_overlay_mismatch', 'profile_resume_unavailable', 'profile_target_incompatible']),
    catalogStatus: z.optional(z.enum(['loading', 'partial', 'unavailable'])),
  })),
  uxDiagnostic: z.optional(ConnectedServiceUxDiagnosticV1Schema),
  connectedAccountPool: z.optional(z.strictObject({
    serviceId: z.string().check(z.minLength(1)),
    excluded: ConnectedServicePoolSelectionV1Schema.shape.excluded,
  })),
}));
export type SessionSpawnLaunchErrorV1 = z.infer<typeof SessionSpawnLaunchErrorV1Schema>;
