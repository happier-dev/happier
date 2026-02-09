import { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';
import { geminiTransport } from '@/backends/gemini/acp/transport';

export const cliCapability = createAcpCliCapability({
  agentId: 'gemini',
  title: 'Gemini CLI',
  acpArgs: ['--experimental-acp'],
  transport: geminiTransport,
});
