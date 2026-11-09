import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import type { HappierHitReach } from '@happier-dev/plugin-ui/environment';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { glassContentFill } from '@/components/ui/glass/glassSurfacePaint';

import type { ToolCallMessage } from "@happier-dev/session-core/messages";
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import type { TranscriptToolChromeCommon } from '@/components/sessions/transcript/transcriptSessionCommon';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { resolveInactiveSessionToolCallFailure } from '@/components/tools/shell/permissions/resolveInactiveSessionToolCallFailure';

import type { GroupedToolCallChromeMode } from './groupedToolCallRowRenderDecision';
import { Icon } from '@/components/ui/icons/Icon';
import { ToolOutcomeStatus } from '@/components/tools/shell/presentation/ToolOutcomeStatus';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { shouldShowToolCallsGroupStatusIndicator } from '../resolveToolCallsGroupPresentation';

export type ToolCallsGroupChromeVariant = 'cards' | 'feed' | 'feed_background';
export type ToolCallsGroupUnitPosition = 'header' | 'middle' | 'footer';
import type { ToolCallsGroupStatus, ToolCallsGroupSummary } from '../resolveToolCallsGroupPresentation';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
export { resolveToolCallsGroupSummary, type ToolCallsGroupStatus, type ToolCallsGroupSummary } from '../resolveToolCallsGroupPresentation';

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

export function resolveToolCallsGroupUnitContainerStyle(
    variant: ToolCallsGroupChromeVariant,
    position: ToolCallsGroupUnitPosition,
    hasVisibleTools = false,
): StyleProp<ViewStyle> {
    const pieces: StyleProp<ViewStyle>[] = [unitStyles.container];
    if (position === 'footer') {
        pieces.push(variant === 'feed'
            ? (hasVisibleTools ? unitStyles.containerFeedBodyFooterMargin : unitStyles.containerPlainFeedFooterMargin)
            : unitStyles.containerFooterMargin);
    }
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
    hasVisibleTools?: boolean;
    unitTestID: string;
    children: React.ReactNode;
}>) {
    const centeredContentMaxWidthStyle = useLayoutMaxWidthStyle();

    return (
        <View style={unitStyles.centered}>
            <View style={[unitStyles.centeredContent, centeredContentMaxWidthStyle]}>
                <View
                    testID={props.unitTestID}
                    style={resolveToolCallsGroupUnitContainerStyle(props.variant, props.position, props.hasVisibleTools)}
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
 * disclosure affordance in both states. Shared between the whole-card
 * ToolCallsGroupView and the per-unit header row.
 */
/** One word per outcome: the header says what the failed row says, and both outcomes when the group has both. */
function resolveGroupFailureLabel(outcomes: ToolCallsGroupSummary | undefined): string {
    if (outcomes && outcomes.failed > 0 && outcomes.refused > 0) {
        if (outcomes.refusalLabel) return `${t('toolView.actionOutcome.failed')}: ${outcomes.failed} · ${outcomes.refusalLabel}: ${outcomes.refused}`;
        return t('toolView.actionOutcome.mixed', { failed: outcomes.failed, refused: outcomes.refused });
    }
    return outcomes?.failuresAreActionOutcomes ? t('toolView.actionOutcome.failed') : t('common.error');
}

export const ToolCallsGroupHeaderChrome = React.memo(function ToolCallsGroupHeaderChrome(props: Readonly<{
    chromeMode: GroupedToolCallChromeMode;
    status: ToolCallsGroupStatus;
    /** How many calls failed or were refused, so the header names the outcomes the rows show. */
    outcomes?: ToolCallsGroupSummary;
    count: number;
    expanded: boolean;
    onToggleExpanded: () => void;
    showToolCalls?: boolean;
    /** How far the header's hit area may reach past its drawn box, where a neighbour contends for the room. */
    hitReach?: HappierHitReach;
}>) {
    const { theme } = useUnistyles();
    const terminalStatusLabel =
        props.status === 'error'
            ? resolveGroupFailureLabel(props.outcomes)
            : props.status === 'refused'
                ? props.outcomes?.refusalLabel ?? t('toolView.actionOutcome.refused')
                : props.status === 'permission_denied'
                ? t('errors.permissionDenied')
                : null;

    return (
        <HappierPressable
            testID="transcript-tool-calls-header"
            onPress={props.onToggleExpanded}
            accessibilityRole="button"
            accessibilityLabel={`${t('session.toolCalls')}: ${props.count}`}
            expanded={props.expanded}
            {...(props.hitReach === undefined ? {} : { hitReach: props.hitReach })}
            style={({ pressed }) => [
                chromeStyles.header,
                pressed && (props.chromeMode === 'activity_feed' ? chromeStyles.headerFeedPressed : chromeStyles.headerCardsPressed),
            ]}
        >
            <View style={chromeStyles.headerGutter}>
                <Icon name="stack-simple" size={16} color={theme.colors.text.secondary} />
            </View>
            <Text style={chromeStyles.title}>
                {t('session.toolCalls')}
                <Text style={chromeStyles.subtitle}> · {props.count}</Text>
            </Text>
            <View style={chromeStyles.headerRight}>
                {shouldShowToolCallsGroupStatusIndicator(props) ? (
                    terminalStatusLabel ? (
                        <ToolOutcomeStatus
                            testID={`tool-calls-group-status:${props.status}`}
                            label={terminalStatusLabel}
                            glyph={props.status === 'error' ? 'warning-circle' : 'minus-circle'}
                            tone={props.status === 'refused' ? 'quiet' : 'danger'}
                        />
                    ) : (
                        <View testID={`tool-calls-group-status:${props.status}`} style={chromeStyles.statusIconRight}>
                            {props.status === 'running' ? (
                                <ActivitySpinner size={iconMatchedSpinnerSize(GROUP_STATUS_ICON_SIZE_PX)} color={workStatusGlyphColor(theme.colors, 'neutral')} />
                            ) : (
                                // Done is quiet: the group's check stays in the ink.
                                <Icon name="check-circle" size={GROUP_STATUS_ICON_SIZE_PX} color={workStatusGlyphColor(theme.colors, 'neutral')} />
                            )}
                        </View>
                    )
                ) : null}
                {/* The header is the group's disclosure in both states: the one disclosure caret, turned by its state. */}
                <DisclosureCaret
                    testID="transcript-tool-calls-header-caret"
                    expanded={props.expanded}
                    size={GROUP_CARET_SIZE_PX}
                />
            </View>
        </HappierPressable>
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
    const coarsePrimaryPointer = useCoarsePrimaryPointer();
    return (
        <HappierPressable
            testID="transcript-tool-calls-preview-more"
            onPress={props.onExpand}
            style={({ pressed }) => [
                chromeStyles.previewMore,
                Platform.OS === 'web' && !coarsePrimaryPointer ? chromeStyles.previewMoreDesktop : null,
                pressed && chromeStyles.previewMorePressed,
            ]}
        >
            <Text style={chromeStyles.previewMoreText}>
                {t('session.toolCallsCollapsedPreviewMore', { count: props.hiddenCount })}
            </Text>
        </HappierPressable>
    );
});

const GROUP_STATUS_ICON_SIZE_PX = 16;
const GROUP_CARET_SIZE_PX = 14;

/**
 * The header ends in its caret, so its status stops this far from the group's edge. The rows under it
 * end here too, which puts every outcome (header and rows) in one column.
 */
export function groupTrailingColumnPx(space: Readonly<{ s8: number }>): number {
    return GROUP_CARET_SIZE_PX + space.s8;
}

const chromeStyles = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s6,
        gap: theme.space.s8,
    },
    headerCardsPressed: {
        opacity: motionTokens.press.opacitySubtle,
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
        ...Typography.variant('body', 'semiBold'),
    },
    // The count is a quiet fact after the title: the title's size, not its weight, in the quietest ink (lab `.tt .n`).
    subtitle: {
        color: theme.colors.text.tertiary,
        ...Typography.variant('body'),
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    statusIconRight: {
        width: GROUP_STATUS_ICON_SIZE_PX,
        alignItems: 'center',
        justifyContent: 'center',
    },
    previewMore: {
        paddingHorizontal: 0,
        paddingTop: theme.space.s6,
        paddingBottom: theme.space.s6,
        alignSelf: 'flex-start',
    },
    previewMoreDesktop: {
        paddingTop: theme.space.s2,
    },
    previewMorePressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
    previewMoreText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
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
    },
    container: {
        marginHorizontal: theme.space.s16,
    },
    containerPlainFeedFooterMargin: {
        marginBottom: theme.space.s8,
    },
    containerFeedBodyFooterMargin: {
        marginBottom: theme.space.s16,
    },
    containerFooterMargin: {
        marginBottom: 22,
    },
    unitCards: {
        backgroundColor: glassContentFill(theme.colors.surface.inset, theme.colors),
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
        backgroundColor: glassContentFill(theme.colors.feed?.card?.background ?? theme.colors.surface.elevated, theme.colors),
        paddingHorizontal: theme.space.s10,
    },
    unitFeedBackgroundHeaderCap: {
        borderTopLeftRadius: theme.borderRadius.xl,
        borderTopRightRadius: theme.borderRadius.xl,
        overflow: 'hidden',
        paddingTop: theme.space.s6,
    },
    unitFeedBackgroundFooterCap: {
        borderBottomLeftRadius: theme.borderRadius.xl,
        borderBottomRightRadius: theme.borderRadius.xl,
        overflow: 'hidden',
        paddingBottom: theme.space.s6,
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
        paddingLeft: theme.space.s6,
        paddingRight: groupTrailingColumnPx(theme.space),
    },
}));
