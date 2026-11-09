import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, formatHappierAsOfTime } from '@happier-dev/plugin-ui/presentation';

import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { DETAILS_TAB_HEADER_METRICS } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { getPreferredLanguage, t } from '@/text';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';

const JUST_NOW_MS = 60_000;

export function resolveFilePageAttributionText(input: Readonly<{
    agentName: string | null;
    requesterName: string | null;
    updatedAt: number | null;
    nowMs: number;
}>): Readonly<{ key: 'justNow' | 'age'; text: string }> | null {
    if (input.updatedAt === null || !Number.isFinite(input.updatedAt)) return null;
    const { agentName: agent, requesterName: person } = input;
    if (input.nowMs - input.updatedAt < JUST_NOW_MS) {
        return { key: 'justNow', text: agent === null ? t('files.pane.page.updatedJustNow')
            : person ? t('files.pane.page.updatedByForJustNow', { agent, person }) : t('files.pane.page.updatedByJustNow', { agent }) };
    }
    if (agent === null) return null;
    const age = formatRelativeTimeShort(input.updatedAt, input.nowMs);
    return { key: 'age', text: person ? t('files.pane.page.byAgentForAge', { agent, person, age }) : t('files.pane.page.byAgentAge', { agent, age }) };
}

/**
 * The last fact of the File page's facts line: who last changed the file and when (lab FV1/FV1m).
 * "Updated by Claude just now" when an agent's write lands while you read; it settles to "by Claude
 * 2m ago" with one word cross-fade. A leaf with its own minute clock, so the age never re-renders the page.
 */
export const FilePageAttributionFact = React.memo(function FilePageAttributionFact(props: Readonly<{
    agentName: string | null;
    requesterName: string | null;
    updatedAt: number | null;
    writing?: Readonly<{ agentName: string; line: number | null }> | null;
    /** The fact follows others on the line: it brings its own " · ". */
    separated?: boolean;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const phone = useSurfaceStateSize() === 'phone';
    const updatedAt = props.updatedAt;
    const readNextRefresh = React.useCallback((nowMs: number) => (
        updatedAt === null ? null : readRelativeTimeShortRefreshAtMs(updatedAt, nowMs)
    ), [updatedAt]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, updatedAt !== null && !props.writing);
    const resolved = props.writing ? { key: 'writing', text: [t('files.agentWritingThisFile', { agent: props.writing.agentName }),
        props.writing.line === null ? null : t('files.blame.line', { line: props.writing.line })].filter(Boolean).join(' · ') }
        : resolveFilePageAttributionText({ agentName: props.agentName, requesterName: props.requesterName, updatedAt, nowMs });
    if (!resolved) return null;
    const textStyle = DETAILS_TAB_HEADER_METRICS[phone ? 'phone' : 'pane'].meta;
    const fresh = resolved.key === 'justNow';
    return (
        <View style={styles.row}>
            {/* Joins the facts before it the way the facts line joins its own: one dot, never inside the fade. */}
            {props.separated ? (
                <Text style={[textStyle, styles.separator, { color: theme.colors.text.secondary }]}
                    accessibilityElementsHidden importantForAccessibility="no">{' · '}</Text>
            ) : null}
            <WordCrossFade wordKey={resolved.key}>
                <Text testID={props.testID ?? (props.writing ? 'file-page-writing' : 'file-page-attribution')} numberOfLines={1}
                    style={[textStyle, styles.text, { color: fresh ? theme.colors.text.primary : theme.colors.text.secondary }]}>
                    {resolved.text}
                </Text>
            </WordCrossFade>
        </View>
    );
});

/**
 * A file deleted on disk (lab FV2d): who deleted it and when, then its one recovery. Not an error:
 * nothing failed, so the line stays ink and Restore is a link, not a button.
 */
export const FilePageDeletionFact = React.memo(function FilePageDeletionFact(props: Readonly<{
    agentName: string | null;
    at: number | null;
    onRestore?: () => void | Promise<void>;
    separated?: boolean;
}>) {
    const { theme } = useUnistyles();
    const phone = useSurfaceStateSize() === 'phone';
    const textStyle = DETAILS_TAB_HEADER_METRICS[phone ? 'phone' : 'pane'].meta;
    const time = props.at === null ? null : formatHappierAsOfTime(props.at, Date.now(), getPreferredLanguage());
    const text = props.agentName ? (time ? t('files.pane.page.deletedByAt', { agent: props.agentName, time }) : t('files.pane.page.deletedBy', { agent: props.agentName }))
        : time ? t('files.pane.page.deletedAt', { time }) : null;
    const separator = (
        <Text style={[textStyle, styles.separator, { color: theme.colors.text.secondary }]}
            accessibilityElementsHidden importantForAccessibility="no">{'\u00A0·\u00A0'}</Text>
    );
    if (!text && !props.onRestore) return null;
    return (
        <View style={styles.row}>
            {props.separated ? separator : null}
            {text ? <Text testID="file-page-deletion" numberOfLines={1} style={[textStyle, { color: theme.colors.text.secondary }]}>{text}</Text> : null}
            {text && props.onRestore ? separator : null}
            {props.onRestore ? (
                <HappierPressable testID="file-page-restore" accessibilityRole="button" accessibilityLabel={t('common.restore')}
                    onPress={() => { void props.onRestore?.(); }}
                    style={({ focused }) => [styles.link, focusRingStyle({ focused, color: theme.colors.border.focus })]}>
                    <Text style={[textStyle, { color: theme.colors.text.link }]}>{t('common.restore')}</Text>
                </HappierPressable>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    separator: {
        flexShrink: 0,
    },
    text: {
        fontVariant: ['tabular-nums'],
    },
    link: {
        borderRadius: 4,
    },
}));
