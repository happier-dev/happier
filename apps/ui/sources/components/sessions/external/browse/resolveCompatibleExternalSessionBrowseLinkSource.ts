import type { ExternalSessionsSource } from '@happier-dev/protocol';

export type ExternalSessionBrowseCompatibleLinkSourceResolver = (ctx: Readonly<{
    selectedSource: ExternalSessionsSource;
    candidateSource: ExternalSessionsSource;
}>) => ExternalSessionsSource | null;

export function resolveCompatibleExternalSessionBrowseLinkSource(params: Readonly<{
    selectedSource: ExternalSessionsSource;
    candidateSource?: ExternalSessionsSource | null;
    resolveCompatibleLinkSource?: ExternalSessionBrowseCompatibleLinkSourceResolver;
}>): ExternalSessionsSource {
    if (!params.candidateSource) {
        return params.selectedSource;
    }
    return params.resolveCompatibleLinkSource?.({
        selectedSource: params.selectedSource,
        candidateSource: params.candidateSource,
    }) ?? params.selectedSource;
}
