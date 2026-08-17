import * as React from 'react';
import { Pressable, View } from 'react-native';

import type { ScmLogEntry } from '@happier-dev/protocol';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon } from '@/components/ui/icons/Icon';

import {
    formatScmHistoryTimestamp,
    formatScmHistoryTimestampAccessibilityLabel,
} from '@/scm/history/historyPresentation';

type SourceControlOperationsHistoryTimelineRowProps = Readonly<{
    theme: any;
    entry: ScmLogEntry;
    isHead: boolean;
    showTrailingLine: boolean;
    onOpenCommit: (sha: string) => void;
}>;

export const SourceControlOperationsHistoryTimelineRow = React.memo((props: SourceControlOperationsHistoryTimelineRowProps) => {
    const indicatorColor = props.isHead
        ? props.theme.colors.text.link
        : props.theme.colors.text.secondary;
    const pressedBackground = props.theme.colors.surface.inset ?? props.theme.colors.input.background;
    const surfaceColor = props.theme.colors.surface.base ?? props.theme.colors.input.background;
    const timelineLineColor = props.theme.colors.border.default;
    const metaText = formatScmHistoryTimestamp(props.entry.timestamp);
    const metaAccessibilityLabel = formatScmHistoryTimestampAccessibilityLabel(props.entry.timestamp);
    const authorText = props.entry.authorName?.trim() || props.entry.authorEmail?.trim() || '';
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
            style={(state) => ({
                flexDirection: 'row',
                minHeight: 56,
                paddingRight: 4,
                borderRadius: 14,
                backgroundColor: state.pressed ? pressedBackground : 'transparent',
            })}
        >
            <View style={{ width: 40, alignItems: 'center', position: 'relative' }}>
                <View
                    style={{
                        position: 'absolute',
                        top: 0,
                        height: 22,
                        width: 2,
                        backgroundColor: timelineLineColor,
                        opacity: 0.5,
                        display: props.isHead ? 'none' : 'flex',
                    }}
                />
                <View
                    style={{
                        width: 14,
                        height: 14,
                        borderRadius: 7,
                        marginTop: 18,
                        backgroundColor: props.isHead ? indicatorColor : surfaceColor,
                        borderWidth: 2,
                        borderColor: indicatorColor,
                        zIndex: 1,
                    }}
                />
                {props.isHead ? (
                    <View
                        testID="scm-commit-entry-head-badge"
                        style={{
                            position: 'absolute',
                            top: 13,
                            width: 22,
                            height: 22,
                            borderRadius: 11,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: surfaceColor,
                            borderWidth: 1,
                            borderColor: indicatorColor,
                        }}
                    >
                        <Icon name="git-commit" size={10} color={indicatorColor} />
                    </View>
                ) : null}
                {props.showTrailingLine ? (
                    <View
                        style={{
                            position: 'absolute',
                            top: 32,
                            bottom: 0,
                            width: 2,
                            backgroundColor: timelineLineColor,
                            opacity: 0.5,
                        }}
                    />
                ) : null}
            </View>

            <View style={{ flex: 1, paddingTop: 10, paddingBottom: 10, justifyContent: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Text
                        style={{ flex: 1, color: props.theme.colors.text.primary, fontSize: 13, ...Typography.default('semiBold') }}
                        numberOfLines={1}
                    >
                        {props.entry.subject}
                    </Text>
                    {metaText ? (
                        <Text
                            style={{ color: props.theme.colors.text.secondary, fontSize: 11, ...Typography.default() }}
                            numberOfLines={1}
                        >
                            {metaText}
                        </Text>
                    ) : null}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View
                        style={{
                            paddingHorizontal: 6,
                            paddingVertical: 3,
                            // The canonical badge shape, not a capsule. The border stays only for
                            // HEAD, where it carries state rather than decoration.
                            borderRadius: 8,
                            backgroundColor: pressedBackground,
                            borderWidth: props.isHead ? 1 : 0,
                            borderColor: indicatorColor,
                        }}
                    >
                        <Text style={{ color: props.isHead ? indicatorColor : props.theme.colors.text.secondary, fontSize: 11, ...Typography.mono('semiBold') }}>
                            {props.entry.shortSha}
                        </Text>
                    </View>
                    {authorText.length > 0 ? (
                        <Text
                            style={{ flex: 1, color: props.theme.colors.text.secondary, fontSize: 11, ...Typography.default() }}
                            numberOfLines={1}
                        >
                            {authorText}
                        </Text>
                    ) : null}
                </View>
            </View>

            <View style={{ justifyContent: 'center', paddingHorizontal: 6 }}>
                <Icon name="caret-right" size={14} color={props.theme.colors.text.secondary} />
            </View>
        </Pressable>
    );
});
