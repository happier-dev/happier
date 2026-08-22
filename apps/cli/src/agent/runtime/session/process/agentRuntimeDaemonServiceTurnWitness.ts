import { z } from 'zod';

const OpaqueIdSchema = z.string().trim().min(1).max(512);

export const AgentRuntimeDaemonServiceTurnWitnessV1Schema =
  z.object({
    turnId: OpaqueIdSchema,
    inputId: OpaqueIdSchema,
    userMessageSeq:
      z.number().int().nonnegative().nullable(),
    userMessageSeqs: z.array(
      z.number().int().nonnegative(),
    ).max(4_096),
  }).strict();

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
  }>;

/**
 * Keeps host-local admission facts at their owner while projecting only the
 * daemon protocol's strict turn identity onto a loopback request.
 */
export function projectAgentRuntimeDaemonServiceTurnWitnessV1(
  witness: AgentRuntimeDaemonServiceTurnWitnessInputV1,
): AgentRuntimeDaemonServiceTurnWitnessV1 {
  return AgentRuntimeDaemonServiceTurnWitnessV1Schema.parse({
    turnId: witness.turnId,
    inputId: witness.inputId,
    userMessageSeq: witness.userMessageSeq,
    userMessageSeqs: [...witness.userMessageSeqs],
  });
}
