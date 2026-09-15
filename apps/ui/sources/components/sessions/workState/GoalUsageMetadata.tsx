import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { formatTokenUsageCount } from '@/components/sessions/usage';
import { t } from '@/text';

import { formatGoalTimeUsed } from './goalUsageFormatting';
import type { SessionWorkStateItem } from './sessionWorkStateTypes';

/**
 * Compact, flat active-goal usage line (Zcode-style). Renders only for an existing goal — the
 * set-first-goal form shows no usage. Time/tokens are inline metadata (no cards, no elevated
 * surfaces).
 */
export function GoalUsageMetadata(props: Readonly<{ goal: SessionWorkStateItem }>) {
    const { theme } = useUnistyles();
    const usedTokens = props.goal.tokensUsed ?? 0;
    const timeSeconds = props.goal.timeUsedSeconds ?? 0;
    const hasUsage = usedTokens > 0 || timeSeconds > 0;
    const timeText = timeSeconds > 0 ? formatGoalTimeUsed(timeSeconds) : null;

    if (!hasUsage) {
        // An ACTIVE goal with no usage yet (e.g. Claude, which reports usage only on completion)
        // renders nothing — "No usage yet" under a running goal reads as "nothing is happening".
        // Honest emptiness beats fake status. Non-active goals (paused/complete with genuinely no
        // usage) keep the muted fallback line.
        if (props.goal.status === 'active') {
            return null;
        }
        return (
            <Text
                testID="session-goal-usage-meta"
                accessibilityLiveRegion="none"
                style={[styles.meta, { color: theme.colors.text.secondary }]}
            >
                {t('session.workState.goal.noUsageYet')}
            </Text>
        );
    }

    const segments = [
        timeText,
        t('session.workState.goal.tokensSuffix', { count: formatTokenUsageCount(usedTokens) }),
    ].filter((segment): segment is string => Boolean(segment));
    return (
        <Text
            testID="session-goal-usage-meta"
            accessibilityLiveRegion="none"
            style={[styles.meta, { color: theme.colors.text.secondary }]}
        >
            {segments.join(' · ')}
        </Text>
    );
}

const styles = StyleSheet.create(() => ({
    meta: {
        fontSize: 12,
        fontWeight: '500',
        fontVariant: ['tabular-nums'],
    },
}));
