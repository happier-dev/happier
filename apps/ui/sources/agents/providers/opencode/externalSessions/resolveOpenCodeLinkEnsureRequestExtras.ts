import type { ExternalSessionBrowseLinkEnsureRequestExtras } from '@/agents/registry/registryUiBehavior';
import {
    buildOpenCodeAgentRuntimeDescriptor,
    normalizeOpenCodeBackendMode,
    readSessionMetadataRuntimeDescriptor,
} from '@happier-dev/agents';

function normalizeCandidateRuntimeDescriptorMetadata(details: Record<string, unknown> | undefined) {
    if (!details) return undefined;
    return {
        ...details,
        runtimeDescriptorV1: details.runtimeDescriptorV1 ?? details.runtimeDescriptor,
        // Ingress-only compat: some candidate sources still return the legacy carrier key.
        agentRuntimeDescriptorV1: details.agentRuntimeDescriptorV1,
    };
}

export function resolveOpenCodeLinkEnsureRequestExtras(params: Readonly<{
    candidate: Readonly<{ details?: Record<string, unknown> }>;
}>): ExternalSessionBrowseLinkEnsureRequestExtras {
    const details = normalizeCandidateRuntimeDescriptorMetadata(params.candidate.details);
    const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(details ?? null, 'opencode');
    return runtimeDescriptor ? {
        runtimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptor({
            backendMode: normalizeOpenCodeBackendMode(runtimeDescriptor.backendMode),
            vendorSessionId: runtimeDescriptor.vendorSessionId,
            serverBaseUrl: runtimeDescriptor.serverBaseUrl,
            serverBaseUrlExplicit: runtimeDescriptor.serverBaseUrlExplicit,
        }),
    } : {};
}
