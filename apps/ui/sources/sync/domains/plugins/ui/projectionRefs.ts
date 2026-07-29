export function resolvePluginUiProjectionContributionId(params: Readonly<{
    family: 'hostedWeb' | 'reactNativeBundle';
    pluginId: string;
    contributionId: unknown;
    entriesById: Readonly<Record<string, unknown>>;
}>): string | null {
    if (typeof params.contributionId !== 'string' || params.contributionId.trim().length === 0) {
        return null;
    }

    const contributionId = params.contributionId.trim();
    if (contributionId in params.entriesById) {
        return contributionId;
    }

    const qualifiedId = `${params.family}:${params.pluginId}:${contributionId}`;
    return qualifiedId in params.entriesById ? qualifiedId : null;
}
