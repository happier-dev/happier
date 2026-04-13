import { importClaudeSessionBundle } from './importClaudeSessionBundle';
import { exportClaudeSessionBundle } from './exportClaudeSessionBundle';
import type { SessionHandoffProviderOps } from '@/backends/types';

export const claudeSessionHandoffProviderOps = {
  exportBundle: async (params) => {
    return await exportClaudeSessionBundle({
      metadata: params.metadata,
      remoteSessionId: params.remoteSessionId,
      env: process.env,
    });
  },
  importBundle: async (params) => {
    if (params.bundle.providerId !== 'claude') {
      throw new Error(`Claude session handoff provider ops received unsupported bundle: ${params.bundle.providerId}`);
    }
    return await importClaudeSessionBundle({
      bundle: params.bundle,
      targetPath: params.targetPath,
      env: process.env,
      sessionStorageMode: params.sessionStorageMode,
    });
  },
} satisfies SessionHandoffProviderOps;
