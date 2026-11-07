import { z } from 'zod/mini';
import { SESSION_PERMISSION_MODES } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import { SessionInputCausalPermissionAuthorityV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { AgentStartSessionCallerV1Schema, readAgentStartCallerWorkDepthV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { ActionRequestAttributionV1Schema } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { DiscussionAddressingV1Schema, type DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/references';

const OpaqueIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(512));
/** Private host input fact. It never identifies a Queue record or a provider turn. */
export const NativeRealtimeInputAdmissionV1Schema = z.strictObject({
  admissionId: OpaqueIdSchema,
  occurrenceId: OpaqueIdSchema,
  attemptId: OpaqueIdSchema,
});
export type NativeRealtimeInputAdmissionV1 = z.infer<typeof NativeRealtimeInputAdmissionV1Schema>;

export function nativeRealtimeInputAdmissionV1Equal(
  left: NativeRealtimeInputAdmissionV1 | null | undefined,
  right: NativeRealtimeInputAdmissionV1 | null | undefined,
): boolean {
  return Boolean(left && right && left.admissionId === right.admissionId
    && left.occurrenceId === right.occurrenceId && left.attemptId === right.attemptId);
}
const HostSessionInputCausalPermissionAuthorityV1Schema =
  asHostProtocolZod(SessionInputCausalPermissionAuthorityV1Schema);
const HostAgentStartSessionCallerV1Schema =
  asHostProtocolZod(AgentStartSessionCallerV1Schema);

export const AgentRuntimeDaemonServiceTurnWitnessV1Schema =
  z.strictObject({
    turnId: OpaqueIdSchema,
    inputId: OpaqueIdSchema,
    nativeRealtimeAdmission: z.optional(NativeRealtimeInputAdmissionV1Schema),
    discussionAddressing: z.optional(asHostProtocolZod(DiscussionAddressingV1Schema)),
    userMessageSeq:
      z.nullable(z.number().check(z.int(), z.nonnegative())),
    userMessageSeqs: z.array(
      z.number().check(z.int(), z.nonnegative()),
    ),
    causalPermissionAuthority:
      z.optional(HostSessionInputCausalPermissionAuthorityV1Schema),
    actionRequestAttributionV1: z.optional(asHostProtocolZod(ActionRequestAttributionV1Schema)),
    callerPermissionMode:
      z.optional(z.nullable(z.enum(SESSION_PERMISSION_MODES))),
    agentStartCaller: z.optional(HostAgentStartSessionCallerV1Schema),
    workDepth: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
  }).check(z.refine((witness) => witness.agentStartCaller
    ? witness.workDepth === readAgentStartCallerWorkDepthV1(witness.agentStartCaller)
    : witness.workDepth === undefined, {
    message: 'Work depth must match the host Session caller facts',
    path: ['workDepth'],
  }));

export type AgentRuntimeDaemonServiceTurnWitnessV1 =
  z.infer<
    typeof AgentRuntimeDaemonServiceTurnWitnessV1Schema
  >;

export type AgentRuntimeDaemonServiceTurnWitnessInputV1 =
  Readonly<{
    turnId: string;
    inputId: string;
    nativeRealtimeAdmission?: NativeRealtimeInputAdmissionV1;
    discussionAddressing?: DiscussionAddressingV1;
    userMessageSeq: number | null;
    userMessageSeqs: readonly number[];
    actionRequestAttributionV1?: import('@happier-dev/protocol/actions/actionRequestAttributionV1').ActionRequestAttributionV1;
    causalPermissionAuthority?: import('@happier-dev/protocol')
      .SessionInputCausalPermissionAuthorityV1;
    callerPermissionMode?: import('@happier-dev/protocol')
      .SessionPermissionMode | null;
    agentStartCaller?: import('@happier-dev/protocol').AgentStartSessionCallerV1;
  }>;

/** Subject owners separately prove runner/source custody before comparing this input fact. */
export function nativeRealtimeInputWitnessMatchesV1(
  admission: NativeRealtimeInputAdmissionV1 | null | undefined,
  witness: AgentRuntimeDaemonServiceTurnWitnessInputV1,
  sessionId: string,
): boolean {
  return Boolean(admission && witness.agentStartCaller?.sessionId === sessionId
    && nativeRealtimeInputAdmissionV1Equal(admission, witness.nativeRealtimeAdmission)
    && witness.inputId === admission.admissionId
    && witness.userMessageSeq === null && witness.userMessageSeqs.length === 0);
}

/**
 * Projects the strict active-turn identity and its complete permission facts
 * onto the private runner-to-daemon loopback request. The daemon Session owner
 * consumes these facts; plugin input can neither author nor replace them.
 */
export function projectAgentRuntimeDaemonServiceTurnWitnessV1(
  witness: AgentRuntimeDaemonServiceTurnWitnessInputV1,
): AgentRuntimeDaemonServiceTurnWitnessV1 {
  return AgentRuntimeDaemonServiceTurnWitnessV1Schema.parse({
    turnId: witness.turnId,
    inputId: witness.inputId,
    ...(witness.nativeRealtimeAdmission ? { nativeRealtimeAdmission: witness.nativeRealtimeAdmission } : {}),
    ...(witness.discussionAddressing ? { discussionAddressing: witness.discussionAddressing } : {}),
    userMessageSeq: witness.userMessageSeq,
    userMessageSeqs: [...witness.userMessageSeqs],
    ...(witness.actionRequestAttributionV1 ? { actionRequestAttributionV1: witness.actionRequestAttributionV1 } : {}),
    ...(witness.causalPermissionAuthority
      ? { causalPermissionAuthority: witness.causalPermissionAuthority }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(witness, 'callerPermissionMode')
      ? { callerPermissionMode: witness.callerPermissionMode ?? null }
      : {}),
    ...(witness.agentStartCaller ? {
      agentStartCaller: witness.agentStartCaller,
      workDepth: readAgentStartCallerWorkDepthV1(witness.agentStartCaller),
    } : {}),
  });
}
