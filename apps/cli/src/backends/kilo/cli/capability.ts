import { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';
import { kiloTransport } from '@/backends/kilo/acp/transport';

export const cliCapability = createAcpCliCapability({
  agentId: 'kilo',
  title: 'Kilo CLI',
  acpArgs: ['acp'],
  transport: kiloTransport,
});
