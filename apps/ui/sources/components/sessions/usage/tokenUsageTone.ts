import { mixColor } from '@/components/ui/avatar/meshGradient/deriveMeshGradientAvatar';

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

/**
 * Single continuous colour for a usage ring: 100% remaining = `fullColor`, 0% = `emptyColor`,
 * blended through `midColor` in between so the gradient never turns muddy.
 */
export function resolveRemainingUsageColor(params: Readonly<{
    remainingPct: number;
    fullColor: string;
    midColor: string;
    emptyColor: string;
}>): string {
    const remaining = Number.isFinite(params.remainingPct) ? Math.max(0, Math.min(100, params.remainingPct)) / 100 : 0;
    return remaining >= 0.5
        ? mixColor(params.midColor, params.fullColor, (remaining - 0.5) * 2)
        : mixColor(params.emptyColor, params.midColor, remaining * 2);
}
