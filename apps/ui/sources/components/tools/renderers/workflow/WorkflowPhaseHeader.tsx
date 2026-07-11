import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { WorkflowPhaseRollup } from '@/components/sessions/workState/sessionWorkflowActivityTypes';

/**
 * Phase header row (UIW3/UIW4) — phase title + a per-phase status rollup. Primitive props keep the
 * memoized header from re-rendering on unrelated progress. Rollup string is i18n-composed.
 */

export type WorkflowPhaseHeaderProps = Readonly<{
    title?: string;
    fallback?: 'activity';
    rollup: WorkflowPhaseRollup;
}>;

/**
 * Compose a concise rollup string from exact counts, e.g. `3/3 complete`, `2/5 active · 1 failed`.
 * Returns the highest-signal summary so phase headers stay scannable.
 */
export function formatPhaseRollup(rollup: WorkflowPhaseRollup): string {
    const segments: string[] = [];
    if (rollup.total > 0) {
        segments.push(t('tools.workflowActivityView.phaseComplete', { complete: rollup.complete, total: rollup.total }));
    }
    if (rollup.active > 0) segments.push(t('tools.workflowActivityView.phaseActive', { count: rollup.active }));
    if (rollup.failed > 0) segments.push(t('tools.workflowActivityView.phaseFailed', { count: rollup.failed }));
    if (rollup.blocked > 0) segments.push(t('tools.workflowActivityView.phaseBlocked', { count: rollup.blocked }));
    if (rollup.pending > 0 && rollup.active === 0 && rollup.complete === 0) {
        segments.push(t('tools.workflowActivityView.phasePending', { count: rollup.pending }));
    }
    return segments.join(' · ');
}

export const WorkflowPhaseHeader = React.memo<WorkflowPhaseHeaderProps>((props) => {
    const rollupLabel = formatPhaseRollup(props.rollup);
    const title = props.title
        ?? (props.fallback === 'activity'
            ? t('tools.workflowActivityView.phaseActivity')
            : t('tools.workflowActivityView.phaseUntitled'));
    return (
        <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
                {title}
            </Text>
            {rollupLabel ? (
                <Text style={styles.rollup} numberOfLines={1}>
                    {rollupLabel}
                </Text>
            ) : null}
        </View>
    );
});
WorkflowPhaseHeader.displayName = 'WorkflowPhaseHeader';

const styles = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        minHeight: 28,
        paddingTop: 8,
        paddingBottom: 2,
    },
    title: {
        flexShrink: 1,
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    rollup: {
        fontSize: 11,
        color: theme.colors.text.secondary,
    },
}));
