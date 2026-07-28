import { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';
import { GROK_ACP_ARGS } from '@/backends/grok/acp/launch';
import { grokTransport } from '@/backends/grok/acp/transport';

export const cliCapability = createAcpCliCapability({
  agentId: 'grok',
  title: 'Grok Build CLI',
  acpArgs: [...GROK_ACP_ARGS],
  transport: grokTransport,
});
