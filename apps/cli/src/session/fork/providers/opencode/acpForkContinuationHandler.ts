import type { AcpForkContinuationHandler } from '@/session/fork/acpForkContinuationHandler';

import {
    applyOpenCodeSessionAffinityMetadata,
    buildOpenCodeSessionEnvironmentVariables,
    readOpenCodeSessionAffinityFromMetadata,
} from '@/session/opencode/opencodeSessionAffinity';

export const openCodeAcpForkContinuationHandler: AcpForkContinuationHandler = async (params) => {
    const affinity = readOpenCodeSessionAffinityFromMetadata(params.parentMetadata);
    if (affinity.backendMode !== 'acp') return null;

    return {
        spawn: {
            environmentVariables: buildOpenCodeSessionEnvironmentVariables({
                backendMode: 'acp',
                serverBaseUrl: affinity.serverBaseUrl,
                serverBaseUrlExplicit: affinity.serverBaseUrlExplicit,
            }),
        },
        metadata: applyOpenCodeSessionAffinityMetadata({
            backendMode: 'acp',
            vendorSessionId: params.vendorSessionId,
            serverBaseUrl: affinity.serverBaseUrl,
            serverBaseUrlExplicit: affinity.serverBaseUrlExplicit,
        }),
        providerHint: {
            providerId: params.agentId,
            backendMode: 'acp',
            vendorSessionId: params.vendorSessionId,
        },
    };
};
