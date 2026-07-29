import {
  createAgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBuffer,
} from '@happier-dev/agents/runtime/session/preAdmissionBuffer';

import type { AgentMessage } from '@/agent/core/AgentMessage';

export function createPublicAcpPreAcknowledgementBuffer(): AgentSessionPreAdmissionBuffer<AgentMessage> {
  return createAgentSessionPreAdmissionBuffer<AgentMessage>();
}
