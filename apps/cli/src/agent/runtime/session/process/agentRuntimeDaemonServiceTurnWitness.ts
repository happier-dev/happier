import { z } from 'zod';
import { SESSION_PERMISSION_MODES } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import { SessionInputCausalPermissionAuthorityV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { AgentStartSessionCallerV1Schema, readAgentStartCallerWorkDepthV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

const OpaqueIdSchema = z.string().trim().min(1).max(512);
const HostSessionInputCausalPermissionAuthorityV1Schema =
  asHostProtocolZod(SessionInputCausalPermissionAuthorityV1Schema);
const HostAgentStartSessionCallerV1Schema =
  asHostProtocolZod(AgentStartSessionCallerV1Schema);

export const AgentRuntimeDaemonServiceTurnWitnessV1Schema =
  z.object({
    turnId: OpaqueIdSchema,
    inputId: OpaqueIdSchema,
    userMessageSeq:
      z.number().int().nonnegative().nullable(),
    userMessageSeqs: z.array(
      z.number().int().nonnegative(),
    ),
    causalPermissionAuthority:
      HostSessionInputCausalPermissionAuthorityV1Schema.optional(),
    callerPermissionMode:
      z.enum(SESSION_PERMISSION_MODES).nullable().optional(),
    agentStartCaller: HostAgentStartSessionCallerV1Schema.optional(),
    workDepth: z.number().int().nonnegative().safe().optional(),
  }).strict().refine((witness) => witness.agentStartCaller
    ? witness.workDepth === readAgentStartCallerWorkDepthV1(witness.agentStartCaller)
    : witness.workDepth === undefined, {
    message: 'Work depth must match the host Session caller facts',
    path: ['workDepth'],
  });

export type AgentRuntimeDaemonServiceTurnWitnessV1 =
  z.infer<
    typeof AgentRuntimeDaemonServiceTurnWitnessV1Schema
  >;

export type AgentRuntimeDaemonServiceTurnWitnessInputV1 =
  Readonly<{
    turnId: string;
    inputId: string;
    userMessageSeq: number | null;
    userMessageSeqs: readonly number[];
    causalPermissionAuthority?: import('@happier-dev/protocol')
      .SessionInputCausalPermissionAuthorityV1;
    callerPermissionMode?: import('@happier-dev/protocol')
      .SessionPermissionMode | null;
    agentStartCaller?: import('@happier-dev/protocol').AgentStartSessionCallerV1;
  }>;

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
    userMessageSeq: witness.userMessageSeq,
    userMessageSeqs: [...witness.userMessageSeqs],
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
