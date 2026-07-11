export type TokenUsageTone = 'neutral' | 'warning' | 'critical';

export function resolveTokenUsageToneColor(params: Readonly<{
    tone: TokenUsageTone;
    neutralColor: string;
    warningColor: string;
    criticalColor: string;
}>): string {
    // Also called from Reanimated worklets (instrument gauge tone derivation on
    // the UI thread); plain JS callers are unaffected by the directive.
    'worklet';
    if (params.tone === 'critical') return params.criticalColor;
    if (params.tone === 'warning') return params.warningColor;
    return params.neutralColor;
}
