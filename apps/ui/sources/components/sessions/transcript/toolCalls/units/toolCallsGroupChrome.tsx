import * as React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { TranscriptToolChromeCommon } from '@/components/sessions/transcript/transcriptSessionCommon';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/ui/layout/layout';
import { resolveInactiveSessionToolCallFailure } from '@/components/tools/shell/permissions/resolveInactiveSessionToolCallFailure';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';

import type { GroupedToolCallChromeMode } from './groupedToolCallRowContent';

export type ToolCallsGroupChromeVariant = 'cards' | 'feed' | 'feed_background';
export type ToolCallsGroupUnitPosition = 'header' | 'middle' | 'footer';
export type ToolCallsGroupStatus =
    | 'running'
    | 'completed'
    | 'error'
    | 'permission_denied'
    | 'permission_canceled';

export function resolveToolCallsGroupChromeVariant(
    toolChromeCommon: TranscriptToolChromeCommon,
): ToolCallsGroupChromeVariant {
    if (toolChromeCommon.toolViewTimelineChromeMode !== 'activity_feed') return 'cards';
    return toolChromeCommon.transcriptToolCallsGroupShowBackground === true ? 'feed_background' : 'feed';
}

export function toolCallsGroupChromeModeForVariant(
    variant: ToolCallsGroupChromeVariant,
): GroupedToolCallChromeMode {
    return variant === 'cards' ? 'cards' : 'activity_feed';
}

export function resolveToolCallMessageForSession(
    message: ToolCallMessage,
    permissionDisabledReason: TranscriptInteraction['permissionDisabledReason'],
): ToolCallMessage {
    const nextTool = resolveInactiveSessionToolCallFailure({
        tool: message.tool,
        permissionDisabledReason,
    });
    if (nextTool === message.tool) return message;
    return { ...message, tool: nextTool };
}

export function resolveToolCallsGroupStatus(params: Readonly<{
    toolMessages: readonly ToolCallMessage[];
    permissionDisabledReason?: TranscriptInteraction['permissionDisabledReason'];
}>): ToolCallsGroupStatus {
    let sawError = false;
    let sawPermissionDenied = false;
    let sawPermissionCanceled = false;
    for (const message of params.toolMessages) {
        const tool = resolveInactiveSessionToolCallFailure({
            tool: message.tool,
            permissionDisabledReason: params.permissionDisabledReason,
        });
        const kind = resolveToolStatusIndicatorKind(tool);
        if (kind === 'running' || kind === 'permission_pending') return 'running';
        if (kind === 'error') sawError = true;
        if (kind === 'permission_blocked') {
            if (tool.permission?.status === 'denied') {
                sawPermissionDenied = true;
            } else {
                sawPermissionCanceled = true;
            }
        }
    }
    if (sawError) return 'error';
    if (sawPermissionDenied) return 'permission_denied';
    if (sawPermissionCanceled) return 'permission_canceled';
    return 'completed';
}

export function resolveToolCallsGroupUnitContainerStyle(
    variant: ToolCallsGroupChromeVariant,
    position: ToolCallsGroupUnitPosition,
): StyleProp<ViewStyle> {
    const pieces: StyleProp<ViewStyle>[] = [unitStyles.container];
    if (position === 'footer') pieces.push(unitStyles.containerFooterMargin);
    if (variant === 'cards') {
        pieces.push(unitStyles.unitCards);
        if (position === 'header') pieces.push(unitStyles.unitCardsHeaderCap);
        if (position === 'footer') pieces.push(unitStyles.unitCardsFooterCap);
        return pieces;
    }
    if (variant === 'feed_background') {
        pieces.push(unitStyles.unitFeedBackground);
        if (position === 'header') pieces.push(unitStyles.unitFeedBackgroundHeaderCap);
        if (position === 'footer') pieces.push(unitStyles.unitFeedBackgroundFooterCap);
        return pieces;
    }
    pieces.push(unitStyles.unitFeed);
    return pieces;
}

/**
 * Per-unit row frame: every unit carries the grouped card's horizontal margin and
 * width constraint; the card's single container chrome is split into position caps
 * (header top cap / square middle / footer bottom cap) so streamed appends never
 * re-style an existing row.
 */
export function ToolCallsGroupUnitRowFrame(props: Readonly<{
    variant: ToolCallsGroupChromeVariant;
    position: ToolCallsGroupUnitPosition;
    unitTestID: string;
    children: React.ReactNode;
}>) {
    return (
        <View style={unitStyles.centered}>
            <View style={unitStyles.centeredContent}>
                <View
                    testID={props.unitTestID}
                    style={resolveToolCallsGroupUnitContainerStyle(props.variant, props.position)}
                >
                    {props.children}
                </View>
            </View>
        </View>
    );
}

/**
 * Gutter-line + body-indent scaffold for middle unit rows (tool / expand rows).
 * Each row renders its own full-height gutter-line segment; together the segments
 * recompose the grouped card's continuous line. The line now terminates at the
 * footer boundary instead of 7px above it (accepted sub-pixel-class deviation).
 */
export function ToolCallsGroupUnitRowScaffold(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <View style={unitStyles.scaffoldRow}>
            <View style={unitStyles.scaffoldGutter}>
                <View testID="transcript-tool-calls-unit-gutter-line" style={unitStyles.scaffoldGutterLine} />
            </View>
            <View style={unitStyles.scaffoldBody}>{props.children}</View>
        </View>
    );
}

/**
 * The grouped tool-calls header row: icon, title + count, status indicator, and the
 * collapse affordance (chevron + press) when expanded. Shared between the whole-card
 * ToolCallsGroupView and the per-unit header row.
 */
export const ToolCallsGroupHeaderChrome = React.memo(function ToolCallsGroupHeaderChrome(props: Readonly<{
    chromeMode: GroupedToolCallChromeMode;
    status: ToolCallsGroupStatus;
    count: number;
    expanded: boolean;
    onCollapse: () => void;
}>) {
    const { theme } = useUnistyles();
    const headerPressable = props.expanded;
    const terminalStatusLabel =
        props.status === 'error'
            ? t('common.error')
            : props.status === 'permission_denied'
                ? t('errors.permissionDenied')
                : props.status === 'permission_canceled'
                    ? t('errors.permissionCanceled')
                    : null;

    return (
        <Pressable
            testID="transcript-tool-calls-header"
            onPress={headerPressable ? props.onCollapse : undefined}
            disabled={!headerPressable}
            style={({ pressed }) => [
                chromeStyles.header,
                headerPressable && pressed && (props.chromeMode === 'activity_feed' ? chromeStyles.headerFeedPressed : chromeStyles.headerCardsPressed),
            ]}
        >
            <View style={chromeStyles.headerGutter}>
                <Ionicons name="layers-outline" size={16} color={theme.colors.text.secondary} />
            </View>
            <Text style={chromeStyles.title}>
                {t('session.toolCalls')}
                <Text style={chromeStyles.subtitle}> · {props.count}</Text>
            </Text>
            <View style={chromeStyles.headerRight}>
                <View
                    testID={`tool-calls-group-status:${props.status}`}
                    accessible={terminalStatusLabel !== null}
                    accessibilityLabel={terminalStatusLabel ?? undefined}
                    style={terminalStatusLabel ? chromeStyles.terminalStatus : chromeStyles.statusIconRight}
                >
                    {props.status === 'running' ? (
                        <ActivitySpinner size={iconMatchedSpinnerSize(GROUP_STATUS_ICON_SIZE_PX)} color={theme.colors.text.secondary} />
                    ) : props.status === 'error' ? (
                        <Ionicons name="alert-circle" size={GROUP_STATUS_ICON_SIZE_PX} color={theme.colors.state.danger.foreground} />
                    ) : props.status === 'permission_denied' || props.status === 'permission_canceled' ? (
                        <Ionicons name="remove-circle-outline" size={16} color={theme.colors.state.danger.foreground} />
                    ) : (
                        <Ionicons name="checkmark-circle" size={GROUP_STATUS_ICON_SIZE_PX} color={theme.colors.state.success.foreground} />
                    )}
                    {terminalStatusLabel ? (
                        <Text style={chromeStyles.terminalStatusText} numberOfLines={1}>
                            {terminalStatusLabel}
                        </Text>
                    ) : null}
                </View>
                {props.expanded ? (
                    <Ionicons
                        name="chevron-up-outline"
                        size={16}
                        color={theme.colors.text.secondary}
                    />
                ) : null}
            </View>
        </Pressable>
    );
});

/**
 * The "+N more" pressable shown while a group is collapsed with hidden tools.
 * Shared between the whole-card ToolCallsGroupView and the per-unit expand row.
 */
export const ToolCallsGroupExpandMoreChrome = React.memo(function ToolCallsGroupExpandMoreChrome(props: Readonly<{
    hiddenCount: number;
    onExpand: () => void;
}>) {
    return (
        <Pressable
            testID="transcript-tool-calls-preview-more"
            onPress={props.onExpand}
            style={({ pressed }) => [chromeStyles.previewMore, pressed && chromeStyles.previewMorePressed]}
        >
            <Text style={chromeStyles.previewMoreText}>
                {t('session.toolCallsCollapsedPreviewMore', { count: props.hiddenCount })}
            </Text>
        </Pressable>
    );
});

const GROUP_STATUS_ICON_SIZE_PX = 16;

const chromeStyles = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 4,
        paddingBottom: 6,
        gap: 8,
    },
    headerCardsPressed: {
        opacity: 0.92,
    },
    headerFeedPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    headerGutter: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        flexGrow: 1,
        color: theme.colors.text.secondary,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        color: theme.colors.message.event.foreground,
        fontSize: 13,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    statusIconRight: {
        width: GROUP_STATUS_ICON_SIZE_PX,
        alignItems: 'center',
        justifyContent: 'center',
    },
    terminalStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 5,
        minWidth: 0,
    },
    terminalStatusText: {
        color: theme.colors.state.danger.foreground,
        fontSize: 12,
        ...Typography.default('semiBold'),
        maxWidth: 160,
    },
    previewMore: {
        paddingHorizontal: 0,
        paddingTop: 6,
        paddingBottom: 6,
        alignSelf: 'flex-start',
    },
    previewMorePressed: {
        opacity: 0.9,
    },
    previewMoreText: {
        color: theme.colors.text.secondary,
        ...Typography.default('regular'),
        fontSize: 13,
    },
}));

const unitStyles = StyleSheet.create((theme) => ({
    centered: {
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'center',
    },
    centeredContent: {
        flexGrow: 1,
        flexBasis: 0,
        maxWidth: layout.maxWidth,
    },
    container: {
        marginHorizontal: 16,
    },
    containerFooterMargin: {
        marginBottom: 22,
    },
    unitCards: {
        backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
    },
    unitCardsHeaderCap: {
        borderTopLeftRadius: theme.borderRadius.xl,
        borderTopRightRadius: theme.borderRadius.xl,
        overflow: 'hidden',
    },
    unitCardsFooterCap: {
        borderBottomLeftRadius: theme.borderRadius.xl,
        borderBottomRightRadius: theme.borderRadius.xl,
        overflow: 'hidden',
    },
    unitFeed: {
        backgroundColor: 'transparent',
    },
    unitFeedBackground: {
        backgroundColor: theme.colors.feed?.card?.background ?? theme.colors.surface.elevated,
        paddingHorizontal: 10,
    },
    unitFeedBackgroundHeaderCap: {
        borderTopLeftRadius: theme.borderRadius.xl,
        borderTopRightRadius: theme.borderRadius.xl,
        overflow: 'hidden',
        paddingTop: 6,
    },
    unitFeedBackgroundFooterCap: {
        borderBottomLeftRadius: theme.borderRadius.xl,
        borderBottomRightRadius: theme.borderRadius.xl,
        overflow: 'hidden',
        paddingBottom: 6,
    },
    scaffoldRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    scaffoldGutter: {
        width: 18,
        alignItems: 'center',
    },
    scaffoldGutterLine: {
        flex: 1,
        width: 2,
        borderRadius: 2,
        backgroundColor: theme.colors.message.event.foreground,
        opacity: 0.1,
    },
    scaffoldBody: {
        flex: 1,
        minWidth: 0,
        paddingLeft: 6,
    },
}));
