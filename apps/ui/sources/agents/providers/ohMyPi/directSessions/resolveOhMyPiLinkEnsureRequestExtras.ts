import type { DirectBrowseLinkEnsureRequestExtras } from '@/agents/registry/registryUiBehavior';

function readOhMyPiSource(details: Record<string, unknown> | undefined) {
    const source = details?.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const record = source as Record<string, unknown>;
    if (record.kind !== 'ohMyPiAgentDir') return null;
    return {
        kind: 'ohMyPiAgentDir' as const,
        ...(typeof record.agentDir === 'string' ? { agentDir: record.agentDir } : {}),
    };
}

export function resolveOhMyPiLinkEnsureRequestExtras(params: Readonly<{
    source: Readonly<{
        kind: 'ohMyPiAgentDir';
        agentDir?: string | null;
    }>;
    candidate: Readonly<{ details?: Record<string, unknown> }>;
}>): DirectBrowseLinkEnsureRequestExtras {
    const candidateSource = readOhMyPiSource(params.candidate.details);
    if (!candidateSource) return {};

    const selectedAgentDir = typeof params.source.agentDir === 'string' ? params.source.agentDir.trim() : '';
    const candidateAgentDir = typeof candidateSource.agentDir === 'string' ? candidateSource.agentDir.trim() : '';
    if (selectedAgentDir && selectedAgentDir !== candidateAgentDir) {
        return {};
    }

    return { source: candidateSource };
}
