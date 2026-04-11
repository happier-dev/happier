import type { Theme } from '@/theme';
import { t } from '@/text';

export function getContextWarning({
    contextSize,
    contextWindowTokens,
    alwaysShow = false,
    theme,
}: {
    contextSize: number;
    contextWindowTokens: number | null;
    alwaysShow?: boolean;
    theme: Pick<Theme, 'colors'>;
}) {
    if (typeof contextWindowTokens !== 'number' || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
        return null;
    }

    const safeContextSize = Number.isFinite(contextSize) && contextSize >= 0 ? contextSize : 0;
    const percentageUsed = (safeContextSize / contextWindowTokens) * 100;
    const percentageRemaining = Math.max(0, Math.min(100, 100 - percentageUsed));

    if (percentageRemaining <= 5) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warningCritical };
    } else if (percentageRemaining <= 10) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    } else if (alwaysShow) {
        // Show context remaining in neutral color when not near limit
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    }
    return null; // No display needed
}
