import {
    buildOpenCodeAgentRuntimeDescriptor,
    normalizeOpenCodeBackendMode,
} from '@happier-dev/agents';
import type { ExternalSessionsSource, RuntimeDescriptorV1 } from '@happier-dev/protocol';
import { readCanonicalRuntimeDescriptorV1ForProvider } from '@happier-dev/protocol';

import type { AgentSessionHandoffProviderPatch } from '@/agents/registry/registryUiBehavior';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

function readTargetOpenCodeServerBaseUrl(
    metadata: Record<string, unknown>,
    targetDirectSource: ExternalSessionsSource | Record<string, unknown>,
): string | null {
    const directSourceRecord = asRecord(targetDirectSource);
    if (directSourceRecord?.kind === 'opencodeServer') {
        return normalizeTrimmedString(directSourceRecord.baseUrl);
    }

    if (metadata.opencodeServerBaseUrlExplicit === true) {
        return normalizeTrimmedString(metadata.opencodeServerBaseUrl);
    }

    return null;
}

function resolveTargetOpenCodeBackendMode(
    metadata: Record<string, unknown>,
    targetDirectSource: ExternalSessionsSource | Record<string, unknown>,
): 'server' | 'acp' | null {
    const directSourceRecord = asRecord(targetDirectSource);
    if (directSourceRecord?.kind === 'opencodeServer') {
        return 'server';
    }

    return normalizeOpenCodeBackendMode(metadata.opencodeBackendMode);
}

function buildOpenCodeRuntimeDescriptor(input: Readonly<{
    metadata: Record<string, unknown>;
    targetRemoteSessionId: string;
    targetDirectSource: ExternalSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: RuntimeDescriptorV1;
}>): RuntimeDescriptorV1 | null {
    const importedRuntimeDescriptor = readCanonicalRuntimeDescriptorV1ForProvider(input.targetRuntimeDescriptor, 'opencode');
    if (importedRuntimeDescriptor) {
        return buildOpenCodeAgentRuntimeDescriptor({
            backendMode: importedRuntimeDescriptor.backendMode ?? 'server',
            vendorSessionId: importedRuntimeDescriptor.vendorSessionId,
            ...(importedRuntimeDescriptor.serverBaseUrl ? { serverBaseUrl: importedRuntimeDescriptor.serverBaseUrl } : {}),
            ...(importedRuntimeDescriptor.serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
        });
    }

    const backendMode = resolveTargetOpenCodeBackendMode(input.metadata, input.targetDirectSource);
    if (!backendMode) return null;

    const serverBaseUrl = readTargetOpenCodeServerBaseUrl(input.metadata, input.targetDirectSource);
    return buildOpenCodeAgentRuntimeDescriptor({
        backendMode,
        vendorSessionId: input.targetRemoteSessionId,
        ...(serverBaseUrl ? { serverBaseUrl } : {}),
        ...(serverBaseUrl ? { serverBaseUrlExplicit: true } : {}),
    });
}

export function buildOpenCodeSessionHandoffProviderPatch(input: Readonly<{
    metadata: Record<string, unknown>;
    targetRemoteSessionId: string;
    targetDirectSource: ExternalSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: RuntimeDescriptorV1;
}>): AgentSessionHandoffProviderPatch {
    const runtimeDescriptor = buildOpenCodeRuntimeDescriptor(input);
    const canonicalRuntimeDescriptor = readCanonicalRuntimeDescriptorV1ForProvider(runtimeDescriptor, 'opencode');
    const backendMode = canonicalRuntimeDescriptor?.backendMode
        ?? resolveTargetOpenCodeBackendMode(input.metadata, input.targetDirectSource);
    const serverBaseUrl = canonicalRuntimeDescriptor?.serverBaseUrl
        ?? readTargetOpenCodeServerBaseUrl(input.metadata, input.targetDirectSource);

    return {
        clearMetadataKeys: serverBaseUrl ? [] : ['opencodeServerBaseUrl', 'opencodeServerBaseUrlExplicit'],
        metadataPatch: {
            ...(backendMode ? { opencodeBackendMode: backendMode } : {}),
            ...(serverBaseUrl
                ? {
                    opencodeServerBaseUrl: serverBaseUrl,
                    opencodeServerBaseUrlExplicit: true,
                }
                : {}),
        },
        runtimeDescriptor,
        externalSessionRuntimeDescriptor: runtimeDescriptor,
    };
}
