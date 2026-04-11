import {
    buildCodexAgentRuntimeDescriptor,
    normalizeCodexBackendMode,
} from '@happier-dev/agents';
import type { AgentRuntimeDescriptorV1, DirectSessionsSource } from '@happier-dev/protocol';
import { readCanonicalAgentRuntimeDescriptorV1ForProvider } from '@happier-dev/protocol';

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

function resolveCodexRuntimeSourceAffinity(
    targetDirectSource: DirectSessionsSource | Record<string, unknown>,
): Readonly<{
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    homePath?: string;
}> {
    const directSourceRecord = asRecord(targetDirectSource);
    if (directSourceRecord?.kind !== 'codexHome') {
        return {};
    }

    return directSourceRecord.home === 'connectedService'
        ? {
            home: 'connectedService',
            connectedServiceId: normalizeTrimmedString(directSourceRecord.connectedServiceId) ?? undefined,
            connectedServiceProfileId: normalizeTrimmedString(directSourceRecord.connectedServiceProfileId) ?? undefined,
            homePath: normalizeTrimmedString(directSourceRecord.homePath) ?? undefined,
        }
        : {
            home: 'user',
            homePath: normalizeTrimmedString(directSourceRecord.homePath) ?? undefined,
        };
}

function buildCodexRuntimeDescriptor(input: Readonly<{
    metadata: Record<string, unknown>;
    targetRemoteSessionId: string;
    targetDirectSource: DirectSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: AgentRuntimeDescriptorV1;
}>): AgentRuntimeDescriptorV1 | null {
    const importedRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(input.targetRuntimeDescriptor, 'codex');
    if (importedRuntimeDescriptor) {
        return buildCodexAgentRuntimeDescriptor({
            backendMode: importedRuntimeDescriptor.backendMode ?? 'appServer',
            vendorSessionId: importedRuntimeDescriptor.vendorSessionId,
            home: importedRuntimeDescriptor.home,
            connectedServiceId: importedRuntimeDescriptor.connectedServiceId,
            connectedServiceProfileId: importedRuntimeDescriptor.connectedServiceProfileId,
            homePath: importedRuntimeDescriptor.homePath,
        });
    }

    const backendMode = normalizeCodexBackendMode(input.metadata.codexBackendMode);
    if (!backendMode) return null;
    return buildCodexAgentRuntimeDescriptor({
        backendMode,
        vendorSessionId: input.targetRemoteSessionId,
        ...resolveCodexRuntimeSourceAffinity(input.targetDirectSource),
    });
}

export function buildCodexSessionHandoffProviderPatch(input: Readonly<{
    metadata: Record<string, unknown>;
    targetRemoteSessionId: string;
    targetDirectSource: DirectSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: AgentRuntimeDescriptorV1;
}>): AgentSessionHandoffProviderPatch {
    const runtimeDescriptor = buildCodexRuntimeDescriptor(input);
    const canonicalRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(runtimeDescriptor, 'codex');
    const backendMode = canonicalRuntimeDescriptor?.backendMode ?? normalizeCodexBackendMode(input.metadata.codexBackendMode);

    return {
        ...(backendMode ? { metadataPatch: { codexBackendMode: backendMode } } : {}),
        runtimeDescriptor,
        directSessionRuntimeDescriptor: runtimeDescriptor,
    };
}
