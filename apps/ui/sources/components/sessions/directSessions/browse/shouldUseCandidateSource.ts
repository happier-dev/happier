import type { DirectSessionsSource } from '@happier-dev/protocol';

export function shouldUseCandidateSource(
    selectedSource: DirectSessionsSource,
    candidateSource: DirectSessionsSource | undefined,
): boolean {
    if (!candidateSource || candidateSource.kind !== selectedSource.kind) return false;

    if (selectedSource.kind === 'codexHome' && candidateSource.kind === 'codexHome') {
        if (selectedSource.home !== candidateSource.home) return false;
        if (selectedSource.home === 'connectedService') {
            return selectedSource.connectedServiceId === candidateSource.connectedServiceId
                && (selectedSource.connectedServiceProfileId ?? '') === (candidateSource.connectedServiceProfileId ?? '');
        }
        return true;
    }

    if (selectedSource.kind === 'claudeConfig' && candidateSource.kind === 'claudeConfig') {
        return (selectedSource.configDir ?? '') === (candidateSource.configDir ?? '')
            && (selectedSource.projectId ?? '') === (candidateSource.projectId ?? '');
    }

    if (selectedSource.kind === 'opencodeServer' && candidateSource.kind === 'opencodeServer') {
        return (selectedSource.baseUrl ?? '') === (candidateSource.baseUrl ?? '')
            && (selectedSource.directory ?? '') === (candidateSource.directory ?? '');
    }

    return false;
}

