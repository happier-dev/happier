import { buildCodexAgentRuntimeDescriptor, readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import { normalizeCodexBackendMode } from '@happier-dev/protocol';

import type { DirectBrowseLinkEnsureRequestExtras } from '@/agents/registry/registryUiBehavior';

function readCandidateCodexRuntimeDescriptor(details: Record<string, unknown> | undefined) {
    return readSessionMetadataRuntimeDescriptor({ agentRuntimeDescriptorV1: details?.agentRuntimeDescriptorV1 }, 'codex')
        ?? readSessionMetadataRuntimeDescriptor({ agentRuntimeDescriptorV1: details?.runtimeDescriptor }, 'codex');
}

function readCodexBackendMode(details: Record<string, unknown> | undefined): 'mcp' | 'acp' | 'appServer' | null {
    const runtimeDescriptor = readSessionMetadataRuntimeDescriptor({ agentRuntimeDescriptorV1: details?.agentRuntimeDescriptorV1 }, 'codex')
        ?? readSessionMetadataRuntimeDescriptor({ agentRuntimeDescriptorV1: details?.runtimeDescriptor }, 'codex');
    const runtimeMode = normalizeCodexBackendMode(runtimeDescriptor?.backendMode);
    if (runtimeMode) return runtimeMode;
    return normalizeCodexBackendMode(details?.codexBackendMode);
}

function buildCanonicalRuntimeDescriptor(params: Readonly<{
    details: Record<string, unknown> | undefined;
    source: Readonly<{
        kind: 'codexHome';
        home: 'user' | 'connectedService';
        connectedServiceId?: string;
        connectedServiceProfileId?: string;
        homePath?: string;
    }>;
}>) {
    const runtimeDescriptor = readCandidateCodexRuntimeDescriptor(params.details);
    if (!runtimeDescriptor) {
        return null;
    }

    return buildCodexAgentRuntimeDescriptor({
        backendMode: normalizeCodexBackendMode(runtimeDescriptor.backendMode) ?? 'appServer',
        vendorSessionId: typeof runtimeDescriptor.vendorSessionId === 'string' ? runtimeDescriptor.vendorSessionId : null,
        homePath: params.source.homePath ?? null,
        home: params.source.home,
        connectedServiceId: params.source.home === 'connectedService' ? params.source.connectedServiceId ?? null : null,
        connectedServiceProfileId: params.source.home === 'connectedService' ? params.source.connectedServiceProfileId ?? null : null,
    });
}

function readCodexSource(details: Record<string, unknown> | undefined) {
    const source = details?.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const record = source as Record<string, unknown>;
    if (record.kind !== 'codexHome') return null;
    if (record.home !== 'user' && record.home !== 'connectedService') return null;
    const home = record.home as 'user' | 'connectedService';
    return {
        kind: 'codexHome' as const,
        home,
        ...(typeof record.connectedServiceId === 'string' ? { connectedServiceId: record.connectedServiceId } : {}),
        ...(typeof record.connectedServiceProfileId === 'string' ? { connectedServiceProfileId: record.connectedServiceProfileId } : {}),
        ...(typeof record.homePath === 'string' ? { homePath: record.homePath } : {}),
    };
}

export function resolveCodexLinkEnsureRequestExtras(params: Readonly<{
    source: Readonly<{
        kind: 'codexHome';
        home: 'user' | 'connectedService';
        connectedServiceId?: string;
        connectedServiceProfileId?: string;
        homePath?: string;
    }>;
    candidate: Readonly<{ details?: Record<string, unknown> }>;
}>): DirectBrowseLinkEnsureRequestExtras {
    const codexBackendMode = readCodexBackendMode(params.candidate.details);
    const candidateSource = readCodexSource(params.candidate.details);
    const effectiveSource = candidateSource ?? params.source;
    const runtimeDescriptor = buildCanonicalRuntimeDescriptor({
        details: params.candidate.details,
        source: effectiveSource,
    });
    return {
        ...(codexBackendMode ? { codexBackendMode } : {}),
        ...(candidateSource ? { source: candidateSource } : {}),
        ...(runtimeDescriptor ? { runtimeDescriptor } : {}),
    };
}
