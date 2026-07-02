import {
    buildCodexAgentRuntimeDescriptor,
    normalizeCodexBackendMode,
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

function normalizeCodexHome(value: unknown): 'user' | 'connectedService' | undefined {
    return value === 'user' || value === 'connectedService' ? value : undefined;
}

function resolveCodexRuntimeSourceAffinity(
    targetDirectSource: ExternalSessionsSource | Record<string, unknown>,
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
    targetDirectSource: ExternalSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: RuntimeDescriptorV1;
}>): RuntimeDescriptorV1 | null {
    const importedRuntimeDescriptor = readCanonicalRuntimeDescriptorV1ForProvider(input.targetRuntimeDescriptor, 'codex');
    if (importedRuntimeDescriptor) {
        return buildCodexAgentRuntimeDescriptor({
            backendMode: normalizeCodexBackendMode(importedRuntimeDescriptor.backendMode) ?? 'appServer',
            providerSessionId: normalizeTrimmedString(importedRuntimeDescriptor.providerSessionId),
            home: normalizeCodexHome(importedRuntimeDescriptor.home),
            connectedServiceId: normalizeTrimmedString(importedRuntimeDescriptor.connectedServiceId),
            connectedServiceProfileId: normalizeTrimmedString(importedRuntimeDescriptor.connectedServiceProfileId),
            homePath: normalizeTrimmedString(importedRuntimeDescriptor.homePath),
        });
    }

    const backendMode = normalizeCodexBackendMode(input.metadata.codexBackendMode);
    if (!backendMode) return null;
    return buildCodexAgentRuntimeDescriptor({
        backendMode,
        providerSessionId: input.targetRemoteSessionId,
        ...resolveCodexRuntimeSourceAffinity(input.targetDirectSource),
    });
}

export function buildCodexSessionHandoffProviderPatch(input: Readonly<{
    metadata: Record<string, unknown>;
    targetRemoteSessionId: string;
    targetDirectSource: ExternalSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: RuntimeDescriptorV1;
}>): AgentSessionHandoffProviderPatch {
    const runtimeDescriptor = buildCodexRuntimeDescriptor(input);
    const canonicalRuntimeDescriptor = readCanonicalRuntimeDescriptorV1ForProvider(runtimeDescriptor, 'codex');
    const backendMode = canonicalRuntimeDescriptor?.backendMode ?? normalizeCodexBackendMode(input.metadata.codexBackendMode);

    return {
        ...(backendMode ? { metadataPatch: { codexBackendMode: backendMode } } : {}),
        runtimeDescriptor,
        externalSessionRuntimeDescriptor: runtimeDescriptor,
    };
}
