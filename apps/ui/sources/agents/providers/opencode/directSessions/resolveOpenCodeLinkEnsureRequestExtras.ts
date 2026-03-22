import type { DirectBrowseLinkEnsureRequestExtras } from '@/agents/registry/registryUiBehavior';
import {
    buildOpenCodeAgentRuntimeDescriptor,
    normalizeOpenCodeBackendMode,
    readSessionMetadataRuntimeDescriptor,
} from '@happier-dev/agents';

export function resolveOpenCodeLinkEnsureRequestExtras(params: Readonly<{
    candidate: Readonly<{ details?: Record<string, unknown> }>;
}>): DirectBrowseLinkEnsureRequestExtras {
    const details = params.candidate.details;
    const runtimeDescriptor = readSessionMetadataRuntimeDescriptor({ agentRuntimeDescriptorV1: details?.agentRuntimeDescriptorV1 }, 'opencode');
    return runtimeDescriptor ? {
        runtimeDescriptor: buildOpenCodeAgentRuntimeDescriptor({
            backendMode: normalizeOpenCodeBackendMode(runtimeDescriptor.backendMode),
            vendorSessionId: runtimeDescriptor.vendorSessionId,
            serverBaseUrl: runtimeDescriptor.serverBaseUrl,
            serverBaseUrlExplicit: runtimeDescriptor.serverBaseUrlExplicit,
        }),
    } : {};
}
