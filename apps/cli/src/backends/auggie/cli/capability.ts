import { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';
import { auggieTransport } from '@/backends/auggie/acp/transport';

export const cliCapability = createAcpCliCapability({
  agentId: 'auggie',
  title: 'Auggie CLI',
  acpArgs: ['--acp'],
  transport: auggieTransport,
});
