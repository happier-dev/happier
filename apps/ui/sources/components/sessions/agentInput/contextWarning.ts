import type { Theme } from '@/theme';
import { t } from '@/text';
import {
    formatTokenUsageCount,
    formatTokenUsagePercent,
} from '@/components/sessions/usage/tokenUsageFormatting';

import { toContextWarningWindowTokens } from './resolveContextWarningWindowTokens';

export type ContextUsageSeverity = 'neutral' | 'warning' | 'critical';

export type ContextUsageState = Readonly<{
    contextWindowTokens: number;
    warningWindowTokens: number;
    usedTokens: number;
    usedRatio: number;
    usedPercentage: number;
    remainingWarningPercentage: number;
    severity: ContextUsageSeverity;
}>;

function normalizeContextWindowTokens(raw: number | null | undefined): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.trunc(raw)
        : null;
}

export function formatContextUsagePercent(value: number): string {
    return formatTokenUsagePercent(value);
}

export function formatContextTokenCount(value: number): string {
    return formatTokenUsageCount(value);
}

export function getContextUsageState(
    contextSize: number | null | undefined,
    alwaysShow: boolean = false,
    contextWindowTokens: number | null = null,
): ContextUsageState | null {
    const safeContextWindowTokens = normalizeContextWindowTokens(contextWindowTokens);
    if (safeContextWindowTokens === null) return null;
    if (typeof contextSize !== 'number' || !Number.isFinite(contextSize)) return null;
    const safeContextSize = Math.max(0, contextSize);
    const warningWindowTokens = toContextWarningWindowTokens(safeContextWindowTokens);
    // A stale window can undercount the real maximum (e.g. 1M enabled provider-side); usage can
    // then exceed it. Never report >100% — raw token counts stay honest for detail copy.
    const usedRatio = Math.min(1, safeContextSize / safeContextWindowTokens);
    const usedPercentage = usedRatio * 100;
    const warningPercentageUsed = (safeContextSize / warningWindowTokens) * 100;
    const remainingWarningPercentage = Math.max(0, Math.min(100, 100 - warningPercentageUsed));

    const severity: ContextUsageSeverity =
        remainingWarningPercentage <= 5
            ? 'critical'
            : remainingWarningPercentage <= 10
                ? 'warning'
                : 'neutral';

    if (!alwaysShow && severity === 'neutral') return null;

    return {
        contextWindowTokens: safeContextWindowTokens,
        warningWindowTokens,
        usedTokens: safeContextSize,
        usedRatio,
        usedPercentage,
        remainingWarningPercentage,
        severity,
    };
}

export function getContextWarning(
    contextSize: number,
    alwaysShow: boolean = false,
    theme: Theme,
    maxContextSize: number | null = null,
) {
    const usageState = getContextUsageState(contextSize, alwaysShow, maxContextSize);
    if (!usageState) return null;

    return {
        text: t('agentInput.context.remaining', { percent: Math.round(usageState.remainingWarningPercentage) }),
        color:
            usageState.severity === 'critical'
                ? theme.colors.state.danger.foreground
                : usageState.severity === 'warning'
                    ? theme.colors.state.neutral.foreground
                    : theme.colors.text.secondary,
    };
}
