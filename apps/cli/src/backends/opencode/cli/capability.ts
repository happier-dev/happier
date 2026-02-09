import { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';
import { openCodeTransport } from '@/backends/opencode/acp/transport';

export const cliCapability = createAcpCliCapability({
  agentId: 'opencode',
  title: 'OpenCode CLI',
  acpArgs: ['acp'],
  transport: openCodeTransport,
});
