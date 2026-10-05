import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import type { SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Switch } from '@/components/ui/forms/Switch';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The one bar over a comparison (Walkthrough lab WT1/WT8): the view switch and scope on the left, the
 * comparison's actions on the right. Files and Walkthrough draw the same bar, so switching views keeps
 * every control where it was.
 */
export function ScmComparisonBar(props: Readonly<{ leading: React.ReactNode; trailing?: React.ReactNode; children?: React.ReactNode }>) {
    return (
        <View testID="scm-comparison-bar" style={styles.bar}>
            <View style={styles.leading}>{props.leading}</View>
            {props.trailing ? <View style={styles.trailing}>{props.trailing}</View> : null}
            {props.children}
        </View>
    );
}

/** The wide review entry, including the same in-place reason the phone action menu carries. */
export function ScmComparisonStartReview(props: Readonly<{ onPress: () => void; disabled?: boolean; disabledReason?: string | null }>) {
    const { theme } = useUnistyles();
    return <View style={styles.reviewAction}>
        <RoundButton testID="scm-comparison-start-review" size="small" display="secondary"
            title={t('scmComparison.startReview')} disabled={props.disabled}
            accessibilityHint={props.disabledReason ?? undefined} onPress={props.onPress}
            leading={<Icon name="shield-check" size={ICON_SIZE.xs} color={theme.colors.text.primary} />} />
        {props.disabledReason ? <Text testID="scm-comparison-review-reason" style={styles.reviewReason}>{props.disabledReason}</Text> : null}
    </View>;
}

/** Files | Walkthrough over one comparison; Commits joins only where the owner offers it. */
export function ScmComparisonViewSwitch(props: Readonly<{
    view: SessionScmReviewView;
    views: readonly SessionScmReviewView[];
    onSelect: (view: SessionScmReviewView) => void;
    /** How many commits the pending proposal holds ("Commits 3"); absent before one exists. */
    commitsCount?: number | null;
}>) {
    const tabs = React.useMemo(() => props.views.map((view) => ({
        id: view,
        label: view === 'files' ? t('scmComparison.view.files') : view === 'walkthrough' ? t('scmComparison.view.walkthrough')
            : props.commitsCount ? `${t('scmComparison.view.commits')} ${props.commitsCount}` : t('scmComparison.view.commits'),
    })), [props.commitsCount, props.views]);
    return (
        <View style={styles.switchRow}>
            <SegmentedTabBar
                testIDPrefix="scm-comparison-view"
                tabs={tabs}
                activeTabId={props.view}
                onSelectTab={props.onSelect}
                segmentSizing="content"
                accessibilityLabel={t('scmComparison.viewA11y')}
            />
            <View style={styles.divider} />
        </View>
    );
}

/** Files' Explain: the walkthrough's own notes beside the hunks they explain (lab WT8-F2; key E). */
export function ScmComparisonExplainToggle(props: Readonly<{ value: boolean; onChange: (next: boolean) => void }>) {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            testID="scm-comparison-explain"
            accessibilityRole="switch"
            checked={props.value}
            accessibilityLabel={t('scmComparison.explainA11y')}
            onPress={() => props.onChange(!props.value)}
            style={(state) => [
                styles.explain,
                props.value ? styles.explainOn : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            <Icon name="path" size={ICON_SIZE.sm} color={props.value ? theme.colors.accent.blue : theme.colors.text.secondary} />
            <Text style={styles.explainLabel}>{t('scmComparison.explain')}</Text>
            <View pointerEvents="none">
                <Switch value={props.value} onValueChange={props.onChange} accessibilityElementsHidden importantForAccessibility="no" />
            </View>
        </HappierPressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 8,
        rowGap: 4,
        minHeight: 48,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.border.default,
    },
    leading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, flexGrow: 1, flexShrink: 1, minWidth: 0 },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    reviewAction: { alignItems: 'flex-end', gap: 4, flexShrink: 1 },
    reviewReason: { fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    divider: { width: 1, height: 16, backgroundColor: theme.colors.border.default },
    explain: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: 36,
        paddingLeft: 10,
        paddingRight: 6,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    explainOn: { borderColor: theme.colors.accent.blue },
    explainLabel: { fontSize: 14, color: theme.colors.text.primary, ...Typography.default('semiBold') },
}));
