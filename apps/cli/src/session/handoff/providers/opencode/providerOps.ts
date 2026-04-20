import type { SessionHandoffProviderOps } from '@/backends/types';

import { exportOpenCodeSessionBundle } from './exportOpenCodeSessionBundle';
import { importOpenCodeSessionBundle } from './importOpenCodeSessionBundle';

export const openCodeSessionHandoffProviderOps = {
    exportBundle: async (params) => {
        return await exportOpenCodeSessionBundle({
            metadata: params.metadata,
            remoteSessionId: params.remoteSessionId,
        });
    },
    importBundle: async (params) => {
        if (params.bundle.providerId !== 'opencode') {
            throw new Error(`OpenCode session handoff provider ops received unsupported bundle: ${params.bundle.providerId}`);
        }
        return await importOpenCodeSessionBundle({
            bundle: params.bundle,
            targetPath: params.targetPath,
            sessionStorageMode: params.sessionStorageMode,
        });
    },
} satisfies SessionHandoffProviderOps;
