import type { DirectSessionsSource } from '@happier-dev/protocol';

function normalizeOptionalString(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized.length > 0 ? normalized : null;
}

function isCompatibleDirectBrowseLinkSource(selectedSource: DirectSessionsSource, candidateSource: DirectSessionsSource): boolean {
    if (selectedSource.kind !== candidateSource.kind) {
        return false;
    }

    if (selectedSource.kind === 'codexHome' && candidateSource.kind === 'codexHome') {
        if (selectedSource.home !== candidateSource.home) {
            return false;
        }
        if (selectedSource.home === 'connectedService') {
            return normalizeOptionalString(selectedSource.connectedServiceId) === normalizeOptionalString(candidateSource.connectedServiceId)
                && normalizeOptionalString(selectedSource.connectedServiceProfileId) === normalizeOptionalString(candidateSource.connectedServiceProfileId);
        }
        return true;
    }

    if (selectedSource.kind === 'ohMyPiAgentDir' && candidateSource.kind === 'ohMyPiAgentDir') {
        const selectedAgentDir = normalizeOptionalString(selectedSource.agentDir);
        return selectedAgentDir == null || selectedAgentDir === normalizeOptionalString(candidateSource.agentDir);
    }

    if (selectedSource.kind === 'opencodeServer' && candidateSource.kind === 'opencodeServer') {
        const selectedBaseUrl = normalizeOptionalString(selectedSource.baseUrl);
        const selectedDirectory = normalizeOptionalString(selectedSource.directory);
        return (selectedBaseUrl == null || selectedBaseUrl === normalizeOptionalString(candidateSource.baseUrl))
            && (selectedDirectory == null || selectedDirectory === normalizeOptionalString(candidateSource.directory));
    }

    if (selectedSource.kind === 'claudeConfig' && candidateSource.kind === 'claudeConfig') {
        const selectedConfigDir = normalizeOptionalString(selectedSource.configDir);
        const selectedProjectId = normalizeOptionalString(selectedSource.projectId);
        return (selectedConfigDir == null || selectedConfigDir === normalizeOptionalString(candidateSource.configDir))
            && (selectedProjectId == null || selectedProjectId === normalizeOptionalString(candidateSource.projectId));
    }

    return false;
}

export function resolveCompatibleDirectBrowseLinkSource(params: Readonly<{
    selectedSource: DirectSessionsSource;
    candidateSource?: DirectSessionsSource | null;
}>): DirectSessionsSource {
    if (!params.candidateSource) {
        return params.selectedSource;
    }
    return isCompatibleDirectBrowseLinkSource(params.selectedSource, params.candidateSource)
        ? params.candidateSource
        : params.selectedSource;
}
