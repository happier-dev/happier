import { importCodexSessionBundle } from './importCodexSessionBundle';
import { exportCodexSessionBundle } from './exportCodexSessionBundle';
import type { SessionHandoffProviderOps } from '@/backends/types';

export const codexSessionHandoffProviderOps = {
  exportBundle: async (params) => {
    return await exportCodexSessionBundle({
      metadata: params.metadata,
      remoteSessionId: params.remoteSessionId,
      env: process.env,
      activeServerDir: params.activeServerDir,
    });
  },
  importBundle: async (params) => {
    if (params.bundle.providerId !== 'codex') {
      throw new Error(`Codex session handoff provider ops received unsupported bundle: ${params.bundle.providerId}`);
    }
    return await importCodexSessionBundle({
      bundle: params.bundle,
      targetPath: params.targetPath,
      env: process.env,
      sessionStorageMode: params.sessionStorageMode,
    });
  },
} satisfies SessionHandoffProviderOps;
