import type { AgentAcpInFlightSteerDefinition } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';

import type { AcpBackend } from '@/agent/acp/AcpBackend';

/** Complete projection before the composer installs the dispatched input's authority. */
export function prepareAcpSteer(
  steer: AgentAcpInFlightSteerDefinition,
  input: Parameters<AgentAcpInFlightSteerDefinition['buildParams']>[0],
): ReturnType<typeof AgentRuntimeJsonValueV1Schema.parse> {
  return AgentRuntimeJsonValueV1Schema.parse(steer.buildParams(input));
}

/** The native codec describes evidence; the composer remains the input custody owner. */
export async function deliverAcpSteer(
  backend: Pick<AcpBackend, 'requestExtension'>,
  steer: AgentAcpInFlightSteerDefinition,
  params: NonNullable<ReturnType<typeof prepareAcpSteer>>,
): Promise<'accepted' | 'rejected'> {
  const response = AgentRuntimeJsonValueV1Schema.parse(await backend.requestExtension(steer.method, params));
  if (steer.isAccepted(response)) return 'accepted';
  if (steer.isRejected?.(response) === true) return 'rejected';
  throw new Error('ACP provider steer extension did not establish input custody');
}
