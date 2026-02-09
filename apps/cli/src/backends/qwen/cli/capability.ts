import { createAcpCliCapability } from '@/capabilities/probes/createAcpCliCapability';
import { qwenTransport } from '@/backends/qwen/acp/transport';

export const cliCapability = createAcpCliCapability({
  agentId: 'qwen',
  title: 'Qwen Code CLI',
  acpArgs: ['--acp'],
  transport: qwenTransport,
});
