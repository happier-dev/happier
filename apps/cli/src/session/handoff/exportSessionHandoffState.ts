import type { SessionHandoffAgentBundle } from './types';

import { exportSessionHandoffAgentBundle } from './agentBundle/export';

export async function exportSessionHandoffState(params: Readonly<{
  metadata: Record<string, unknown>;
  activeServerDir: string;
}>): Promise<Readonly<{
  agentBundle: SessionHandoffAgentBundle;
  targetPath: string;
}>> {
  return await exportSessionHandoffAgentBundle({
    metadata: params.metadata,
    activeServerDir: params.activeServerDir,
  });
}
