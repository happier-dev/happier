import { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';
import { copilotTransport } from '@/backends/copilot/acp/transport';

export const cliCapability = createAcpCliCapability({
  agentId: 'copilot',
  title: 'Copilot CLI',
  acpArgs: ['--acp'],
  transport: copilotTransport,
});
