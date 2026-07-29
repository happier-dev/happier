import type { ExternalSessionsSource } from '@happier-dev/protocol';

export type ExternalSessionBrowseCompatibleLinkSourceResolver = (ctx: Readonly<{
    selectedSource: ExternalSessionsSource;
    candidateSource: ExternalSessionsSource;
}>) => ExternalSessionsSource | null;

function normalizeOptionalString(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function isCompatibleExternalSessionBrowseLinkSource(selectedSource: ExternalSessionsSource, candidateSource: ExternalSessionsSource): boolean {
    if (selectedSource.kind !== candidateSource.kind) {
        return false;
    }

    if (selectedSource.kind === 'codexHome' && candidateSource.kind === 'codexHome') {
        if (selectedSource.home !== candidateSource.home) {
            return false;
        }
        if (selectedSource.home === 'connectedService') {
            if (normalizeOptionalString(selectedSource.connectedServiceId) !== normalizeOptionalString(candidateSource.connectedServiceId)) {
                return false;
            }
            const selectedGroupId = normalizeOptionalString(selectedSource.connectedServiceGroupId);
            const candidateGroupId = normalizeOptionalString(candidateSource.connectedServiceGroupId);
            if (selectedGroupId !== null || candidateGroupId !== null) {
                return selectedGroupId !== null && selectedGroupId === candidateGroupId;
            }
            return normalizeOptionalString(selectedSource.connectedServiceProfileId)
                === normalizeOptionalString(candidateSource.connectedServiceProfileId);
        }
        return true;
    }

    if (selectedSource.kind === 'ohMyPiAgentDir' && candidateSource.kind === 'ohMyPiAgentDir') {
        const selectedAgentDir = normalizeOptionalString(selectedSource.agentDir);
        return selectedAgentDir == null || selectedAgentDir === normalizeOptionalString(candidateSource.agentDir);
    }

    if (selectedSource.kind === 'claudeConfig' && candidateSource.kind === 'claudeConfig') {
        const selectedConfigDir = normalizeOptionalString(selectedSource.configDir);
        const selectedProjectId = normalizeOptionalString(selectedSource.projectId);
        return (selectedConfigDir == null || selectedConfigDir === normalizeOptionalString(candidateSource.configDir))
            && (selectedProjectId == null || selectedProjectId === normalizeOptionalString(candidateSource.projectId));
    }

    return false;
}

export function resolveCompatibleExternalSessionBrowseLinkSource(params: Readonly<{
    selectedSource: ExternalSessionsSource;
    candidateSource?: ExternalSessionsSource | null;
    resolveCompatibleLinkSource?: ExternalSessionBrowseCompatibleLinkSourceResolver;
}>): ExternalSessionsSource {
    if (!params.candidateSource) {
        return params.selectedSource;
    }
    const resolved = params.resolveCompatibleLinkSource?.({
        selectedSource: params.selectedSource,
        candidateSource: params.candidateSource,
    });
    if (resolved) {
        return resolved;
    }
    return isCompatibleExternalSessionBrowseLinkSource(params.selectedSource, params.candidateSource)
        ? params.candidateSource
        : params.selectedSource;
}
