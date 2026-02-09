import { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';
import { kimiTransport } from '@/backends/kimi/acp/transport';

export const cliCapability = createAcpCliCapability({
  agentId: 'kimi',
  title: 'Kimi CLI',
  acpArgs: ['acp'],
  transport: kimiTransport,
});
