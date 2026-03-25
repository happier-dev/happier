import type { SessionHandoffProviderBundle } from './types';

import { exportSessionHandoffProviderBundle } from './exportSessionHandoffProviderBundle';

export async function exportSessionHandoffState(params: Readonly<{
  metadata: Record<string, unknown>;
  activeServerDir: string;
}>): Promise<Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  targetPath: string;
}>> {
  return await exportSessionHandoffProviderBundle({
    metadata: params.metadata,
    activeServerDir: params.activeServerDir,
  });
}
