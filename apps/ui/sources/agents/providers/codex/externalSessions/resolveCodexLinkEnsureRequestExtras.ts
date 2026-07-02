import { buildCodexAgentRuntimeDescriptor, readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';
import { normalizeCodexBackendMode, type CodexBackendMode } from '@happier-dev/protocol';

import type { ExternalSessionBrowseLinkEnsureRequestExtras } from '@/agents/registry/registryUiBehavior';

function normalizeCandidateRuntimeDescriptorMetadata(details: Record<string, unknown> | undefined) {
    if (!details) return undefined;
    return {
        ...details,
        runtimeDescriptorV1: details.runtimeDescriptorV1 ?? details.runtimeDescriptor,
        // Ingress-only compat: some candidate sources still return the legacy carrier key.
        agentRuntimeDescriptorV1: details.agentRuntimeDescriptorV1,
    };
}

function readCandidateCodexRuntimeDescriptor(details: Record<string, unknown> | undefined) {
    return readSessionMetadataRuntimeDescriptor(normalizeCandidateRuntimeDescriptorMetadata(details) ?? null, 'codex');
}

function readCodexBackendMode(details: Record<string, unknown> | undefined): CodexBackendMode | null {
    const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(normalizeCandidateRuntimeDescriptorMetadata(details) ?? null, 'codex');
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
        providerSessionId: typeof runtimeDescriptor.providerSessionId === 'string' ? runtimeDescriptor.providerSessionId : null,
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

function shouldUseCandidateCodexSource(params: Readonly<{
    selectedSource: Readonly<{
        kind: 'codexHome';
        home: 'user' | 'connectedService';
        connectedServiceId?: string;
        connectedServiceProfileId?: string;
        homePath?: string;
    }>;
    candidateSource: Readonly<{
        kind: 'codexHome';
        home: 'user' | 'connectedService';
        connectedServiceId?: string;
        connectedServiceProfileId?: string;
        homePath?: string;
    }>;
}>): boolean {
    if (params.selectedSource.home !== params.candidateSource.home) return false;
    if (params.selectedSource.home === 'connectedService') {
        return params.selectedSource.connectedServiceId === params.candidateSource.connectedServiceId
            && (params.selectedSource.connectedServiceProfileId ?? '') === (params.candidateSource.connectedServiceProfileId ?? '');
    }
    return true;
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
}>): ExternalSessionBrowseLinkEnsureRequestExtras {
    const codexBackendMode = readCodexBackendMode(params.candidate.details);
    const candidateSource = readCodexSource(params.candidate.details);
    const compatibleCandidateSource = candidateSource && shouldUseCandidateCodexSource({
        selectedSource: params.source,
        candidateSource,
    })
        ? candidateSource
        : null;
    const effectiveSource = compatibleCandidateSource ?? params.source;
    const runtimeDescriptor = buildCanonicalRuntimeDescriptor({
        details: params.candidate.details,
        source: effectiveSource,
    });
    return {
        ...(codexBackendMode ? { codexBackendMode } : {}),
        ...(compatibleCandidateSource ? { source: compatibleCandidateSource } : {}),
        ...(runtimeDescriptor ? { runtimeDescriptorV1: runtimeDescriptor } : {}),
    };
}
