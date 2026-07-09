import type { Theme } from '@/theme';
import { t } from '@/text';
import {
    computeContextPercentUsed,
    type SessionContextUsageSnapshotV1,
} from '@happier-dev/protocol';

export function getContextWarning({
    contextSize,
    contextWindowTokens,
    contextSnapshot,
    contextSnapshotStale = false,
    alwaysShow = false,
    theme,
}: {
    contextSize: number;
    contextWindowTokens: number | null;
    contextSnapshot?: SessionContextUsageSnapshotV1;
    contextSnapshotStale?: boolean;
    alwaysShow?: boolean;
    theme: Pick<Theme, 'colors'>;
}) {
    if (contextSnapshotStale || typeof contextWindowTokens !== 'number' || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
        return null;
    }

    const safeContextSize = Number.isFinite(contextSize) && contextSize >= 0 ? contextSize : 0;
    const percentageUsed = computeContextPercentUsed(contextSnapshot
        ? { ...contextSnapshot, windowTokens: contextWindowTokens }
        : {
            v: 1,
            modelId: null,
            usedTokens: safeContextSize,
            windowTokens: contextWindowTokens,
            totalProcessedTokens: null,
            baselineTokens: null,
            isAutoCompactEnabled: null,
            categories: null,
            observedAtMs: 0,
            source: 'derived_estimate',
        });
    if (percentageUsed === null) return null;
    const percentageRemaining = Math.max(0, Math.min(100, 100 - percentageUsed));

    if (percentageRemaining <= 5) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.state.danger.foreground };
    } else if (percentageRemaining <= 15) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.state.warning.foreground };
    } else if (alwaysShow) {
        // Show context remaining in neutral color when not near limit
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.state.neutral.foreground };
    }
    return null; // No display needed
}
