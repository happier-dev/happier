import {
  createAgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBuffer,
} from '@happier-dev/agents/runtime/session/preAdmissionBuffer';

import type { AgentMessage } from '@/agent/core/AgentMessage';

export function createPublicAcpPreAcknowledgementBuffer<Message = AgentMessage>(): AgentSessionPreAdmissionBuffer<Message> {
  return createAgentSessionPreAdmissionBuffer<Message>();
}
