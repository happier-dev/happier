import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { ScmLogEntry } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';

import {
    formatScmHistoryTimestampAccessibilityLabel,
    formatScmHistoryTimestamp,
    formatScmTimelineTime,
    formatScmTimelineWhen,
} from '@/scm/history/historyPresentation';
import { ScmTimelineGutter } from '@/components/workspaces/scm/history/ScmTimelineGutter';

type SourceControlOperationsHistoryTimelineRowProps = Readonly<{
    theme: any;
    entry: ScmLogEntry;
    isHead: boolean;
    /** Where the commit is (Git pane timeline): on this machine only, on origin, or on origin but not here yet. */
    relation?: 'local' | 'shared' | 'incoming';
    /** A short live tag beside the author: the commit that just landed, or one waiting to be pulled. */
    tag?: 'just-now' | 'to-pull' | null;
    showTrailingLine: boolean;
    /** The rail below this commit is still incoming (dashed). */
    dashedTrailingLine?: boolean;
    /**
     * Inside day groups the gutter shows the time of day only. `elapsed` is the finished summary's live
     * "how long ago" label (it ticks; the gutter variants are static).
     */
    whenFormat?: 'relative' | 'time' | 'elapsed';
    /** The same commit presentation inside a finished summary, without a timeline's time/rail gutter. */
    layout?: 'timeline' | 'summary';
    /** The point just became filled: its fill rises in after this delay (Git lab SX). */
    fillDelayMs?: number;
    /** The landed point's ring waits this long. */
    ringDelayMs?: number;
    onOpenCommit: (sha: string) => void;
    onCommitLayout?: (sha: string, y: number, height: number) => void;
}>;

/**
 * The summary's "how long ago" text. The clock lives here, in the only place that shows it, so each
 * tick re-renders this leaf and never the row (subject, author, tags, press handlers) around it.
 * Normal timeline rows never subscribe to a clock.
 */
function ScmHistoryWhenLabel(props: Readonly<{ timestamp: number; ticking: boolean }>) {
    useElapsedTime(props.ticking ? props.timestamp : null);
    return formatScmHistoryTimestamp(props.timestamp);
}

export const SourceControlOperationsHistoryTimelineRow = React.memo((props: SourceControlOperationsHistoryTimelineRowProps) => {
    const indicatorColor = props.isHead
        ? props.theme.colors.text.link
        : props.theme.colors.text.secondary;
    const pressedBackground = props.theme.colors.surface.inset ?? props.theme.colors.input.background;
    const metaAccessibilityLabel = formatScmHistoryTimestampAccessibilityLabel(props.entry.timestamp);
    const authorText = props.entry.authorName?.trim() || props.entry.authorEmail?.trim() || '';
    const mergedPullRequest = /^Merge pull request #(\d+)\b/i.exec(props.entry.subject)?.[1] ?? null;
    const accessibilityLabel = [
        props.entry.subject?.trim(),
        authorText,
        props.entry.shortSha?.trim(),
        metaAccessibilityLabel,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ');

    return (
        <Pressable
            key={props.entry.sha}
            testID={`scm-commit-entry-${props.entry.sha}`}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel || undefined}
            onPress={() => props.onOpenCommit(props.entry.sha)}
            onLayout={props.onCommitLayout ? (event) => {
                const { y, height } = event.nativeEvent.layout;
                props.onCommitLayout?.(props.entry.sha, y, height);
            } : undefined}
            style={(state) => ({
                flexDirection: 'row',
                minHeight: props.layout === 'summary' ? 36 : 46,
                paddingRight: 4,
                borderRadius: 14,
                backgroundColor: state.pressed ? pressedBackground : 'transparent',
            })}
        >
            {props.layout === 'summary' ? <View style={{ justifyContent: 'center', paddingRight: 8 }}><Icon name="git-commit" size={ICON_SIZE.sm} color={props.theme.colors.text.secondary} /></View> : <ScmTimelineGutter
                testID={`scm-commit-entry-${props.entry.sha}-when`}
                when={props.whenFormat === 'time' ? formatScmTimelineTime(props.entry.timestamp) : props.whenFormat === 'elapsed' ? formatScmHistoryTimestamp(props.entry.timestamp) : formatScmTimelineWhen(props.entry.timestamp)}
                pointTopPx={11}
                tone={props.tag === 'just-now'
                    ? 'landed'
                    : props.relation ?? (props.isHead ? 'head' : 'local')}
                showLeadingLine={!props.isHead}
                showTrailingLine={props.showTrailingLine}
                dashedTrailingLine={props.dashedTrailingLine}
                fillDelayMs={props.fillDelayMs}
                ringDelayMs={props.ringDelayMs}
            />}

            <View style={{ flex: 1, paddingTop: props.layout === 'summary' ? 2 : 6, paddingBottom: props.layout === 'summary' ? 2 : 8, justifyContent: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    {mergedPullRequest ? <View testID={`scm-commit-entry-${props.entry.sha}-pr-${mergedPullRequest}`} style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: props.theme.colors.state?.success?.background }}><Text style={{ ...Typography.variant('micro', 'medium'), color: props.theme.colors.state?.success?.foreground ?? props.theme.colors.text.secondary,  }}>#{mergedPullRequest}</Text></View> : null}
                    <Text
                        style={{ flex: 1, color: props.theme.colors.text.primary, ...Typography.variant('body', 'semiBold'),  }}
                        numberOfLines={1}
                    >
                        {props.entry.subject}
                    </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {authorText.length > 0 ? <Avatar id={props.entry.authorEmail?.trim() || authorText} size={14} /> : null}
                    {authorText.length > 0 ? (
                        <Text
                            style={{ flexShrink: 1, color: props.theme.colors.text.secondary, ...Typography.variant('meta'),  }}
                            numberOfLines={1}
                        >
                            {authorText}
                        </Text>
                    ) : null}
                    {authorText.length > 0 ? (
                        <Text style={{ color: props.theme.colors.text.tertiary ?? props.theme.colors.text.secondary, fontSize: 12 }}>·</Text>
                    ) : null}
                    <Text style={{ color: props.theme.colors.text.tertiary ?? props.theme.colors.text.secondary, fontSize: 11, ...Typography.mono() }}>
                        {props.entry.shortSha}
                    </Text>
                    {props.layout === 'summary' ? <Text testID={`scm-commit-entry-${props.entry.sha}-when`} style={{ color: props.theme.colors.text.tertiary ?? props.theme.colors.text.secondary, ...Typography.variant('micro'),  }}>· <ScmHistoryWhenLabel timestamp={props.entry.timestamp} ticking={props.whenFormat === 'elapsed'} /></Text> : null}
                    {props.tag ? (
                        <View
                            testID={`scm-commit-entry-${props.entry.sha}-tag-${props.tag}`}
                            style={{
                                paddingHorizontal: 6,
                                paddingVertical: 1,
                                borderRadius: 6,
                                backgroundColor: props.tag === 'just-now'
                                    ? props.theme.colors.state?.success?.background
                                    : props.theme.colors.state?.info?.background,
                            }}
                        >
                            <Text style={{
                                ...Typography.variant('micro', 'semiBold'),
                                color: props.tag === 'just-now'
                                    ? props.theme.colors.state?.success?.foreground
                                    : props.theme.colors.text.link,
                            }}>
                                {props.tag === 'just-now' ? t('sessionGitPane.flow.timeline.justNow') : t('sessionGitPane.flow.timeline.toPull')}
                            </Text>
                        </View>
                    ) : null}
                </View>
            </View>

        </Pressable>
    );
});
