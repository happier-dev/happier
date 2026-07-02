export type TokenUsageTone = 'neutral' | 'warning' | 'critical';

export function resolveTokenUsageToneColor(params: Readonly<{
    tone: TokenUsageTone;
    neutralColor: string;
    warningColor: string;
    criticalColor: string;
}>): string {
    if (params.tone === 'critical') return params.criticalColor;
    if (params.tone === 'warning') return params.warningColor;
    return params.neutralColor;
}
