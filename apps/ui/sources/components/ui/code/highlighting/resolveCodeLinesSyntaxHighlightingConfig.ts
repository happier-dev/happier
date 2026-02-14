export type CodeLinesSyntaxHighlightingMode = 'off' | 'simple' | 'advanced';

export function resolveCodeLinesSyntaxHighlightingMode(params: Readonly<{
    featureEnabled: boolean;
    requestedMode: CodeLinesSyntaxHighlightingMode;
    advancedFeatureEnabled: boolean;
    platformOS: string;
}>): CodeLinesSyntaxHighlightingMode {
    if (!params.featureEnabled) return 'off';
    if (params.requestedMode === 'off') return 'off';

    if (params.requestedMode === 'advanced') {
        if (!params.advancedFeatureEnabled) return 'simple';
        // Advanced tokenization is web-only for now (Shiki/Monaco); native uses simple tokenizer.
        if (params.platformOS !== 'web') return 'simple';
        return 'advanced';
    }

    return 'simple';
}

