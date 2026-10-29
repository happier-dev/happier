import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import {
    shouldShowTranscriptRowActions,
    shouldShowTranscriptRowPinAction,
} from '@/components/sessions/transcript/transcriptRowActionVisibility';
import { ToolTimelineIconFrame } from './ToolTimelineIconFrame';
import { ICON_SIZE, Icon, type IconName } from '@/components/ui/icons/Icon';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import type { TranscriptFindRowSnapshot } from '@/components/sessions/transcript/find/transcriptFindRowStore';

export const TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID = 'tool-timeline-row-reveal-slot';
export const TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID = 'tool-timeline-row-pin-slot';
export const TOOL_TIMELINE_ROW_HOVER_HOST_TEST_ID = 'tool-timeline-row-hover-host';

const TOOL_TIMELINE_ROW_OPEN_SLOT_WIDTH = 26;
const TOOL_TIMELINE_ROW_REVEAL_ACTION_WIDTH = 28;

export type ToolTimelineRowDensity = 'comfortable' | 'compact';

type IoniconName = IconName;

export type ToolTimelineRowHeaderDisclosure =
    | { behavior: 'hover'; state: 'collapsed' | 'expanded' }
    | { behavior: 'persistent'; state: 'collapsed' | 'expanded' };

export const ToolTimelineRowHeader = React.memo(function ToolTimelineRowHeader(props: {
    testID?: string;
    openActionTestID?: string;
    density: ToolTimelineRowDensity;
    icon: React.ReactNode;
    title: string;
    findBlocks?: TranscriptFindRowSnapshot['blocks'];
    findRevealBlockId?: string;
    subtitle?: string | null;
    /**
     * The subtitle is a sentence to read whole (a Happier Action's own line): when it does not fit beside the
     * title it drops to its own line under it instead of ending in a one-word ellipsis.
     */
    subtitleWraps?: boolean;
    statusText?: string | null;
    /** Why a refused or failed call ended, in words: its own quiet line under the title, so a narrow row never clips it. */
    causeText?: string | null;
    onPress?: (() => void) | null;
    canOpen?: boolean;
    onOpen?: (() => void) | null;
    rightElement?: React.ReactNode | null;
    /**
     * How the call ended (failed, refused, blocked). It closes the row after the reveal slots, so every
     * row's outcome sits in one column that lines up with the group header's own status.
     */
    terminalStatus?: React.ReactNode | null;
    /**
     * Hover-revealed row action (the pin). It owns its own reveal slot so a
     * pinned row can keep the pin visible without dragging the open-details
     * icon into view; both slots still follow this header's single hover state.
     */
    revealAction?: React.ReactNode | null;
    /** Keeps `revealAction` visible without hover (a pinned row). */
    revealActionSticky?: boolean;
    disclosure?: ToolTimelineRowHeaderDisclosure | null;
}) {
    const { theme } = useUnistyles();
    const findRanges = (blockId: string) => props.findBlocks?.find((block) => block.id === blockId)?.sourceRanges;

    const showSubtitleInline = Boolean(props.subtitle && String(props.subtitle).trim().length > 0);
    const showStatusInline = Boolean(props.statusText && String(props.statusText).trim().length > 0);
    const canOpen = props.canOpen === true && typeof props.onOpen === 'function';
    const disclosure = props.disclosure ?? null;
    const hoverEnabled = Platform.OS === 'web' && disclosure?.behavior === 'hover' && Boolean(props.onPress);
    const revealAction = props.revealAction ?? null;
    const hasRevealSlot = canOpen || revealAction != null;
    const trackHoverState = hoverEnabled || (Platform.OS === 'web' && (Boolean(props.onPress) || hasRevealSlot));
    // The hover host is the whole header, not the row's pressable: the reveal slots sit beside the
    // pressable, so a pressable-only host hid the open action again as the pointer crossed toward it.
    const { isHovered, hoverProps } = useRowActionHoverHost();
    const handleHoverIn = hoverProps.onPointerEnter;
    const handleHoverOut = hoverProps.onPointerLeave;
    const handleOpenPress = React.useCallback((event?: { stopPropagation?: () => void }) => {
        event?.stopPropagation?.();
        props.onOpen?.();
    }, [props]);

    const rowActionVisibility = {
        platformOS: Platform.OS,
        isRowHovered: isHovered,
        isActionHovered: false,
        coarsePrimaryPointer: readCoarsePrimaryPointer(),
    } as const;
    // A pinned row keeps its pin visible; the open-details icon still waits for
    // hover, so pinning a row does not permanently add chrome to it.
    const pinRevealed = !props.onPress || shouldShowTranscriptRowPinAction({
        ...rowActionVisibility,
        pinned: props.revealActionSticky === true,
    });
    const openRevealed = !props.onPress || shouldShowTranscriptRowActions(rowActionVisibility);

    const chevronSize = props.density === 'compact' ? 16 : 18;
    const disclosureChevronName: IoniconName | null =
        disclosure?.state === 'expanded' ? 'caret-up' : disclosure?.state === 'collapsed' ? 'caret-down' : null;

    return (
        <>
        <View
            testID={TOOL_TIMELINE_ROW_HOVER_HOST_TEST_ID}
            style={styles.container}
            onPointerEnter={trackHoverState ? handleHoverIn : undefined}
            onPointerLeave={trackHoverState ? handleHoverOut : undefined}
        >
            <Pressable
                testID={props.testID}
                onPress={props.onPress ?? undefined}
                disabled={!props.onPress}
                style={({ pressed }) => [
                    styles.row,
                    props.density === 'compact' ? styles.rowCompact : null,
                    pressed && styles.rowPressed,
                ]}
            >
                <View style={styles.icon}>
                    {disclosure?.behavior === 'persistent' && disclosureChevronName ? (
                        <Icon name={disclosureChevronName} size={chevronSize} color={theme.colors.text.secondary} />
                    ) : hoverEnabled && disclosureChevronName ? (
                        <View style={styles.iconStack}>
                            <View
                                style={[
                                    styles.iconLayer,
                                    isHovered ? styles.iconLayerHidden : null,
                                ]}
                            >
                                <ToolTimelineIconFrame icon={props.icon} />
                            </View>
                            <View
                                style={[
                                    styles.iconLayer,
                                    styles.iconLayerOverlay,
                                    isHovered ? null : styles.iconLayerHidden,
                                ]}
                            >
                                <Icon
                                    name={disclosureChevronName}
                                    size={chevronSize}
                                    color={theme.colors.text.secondary}
                                />
                            </View>
                        </View>
                    ) : (
                        <ToolTimelineIconFrame icon={props.icon} />
                    )}
                </View>
                <View style={[styles.text, props.subtitleWraps ? styles.textWrapping : null]}>
                    <Text
                        style={[styles.title, props.density === 'compact' ? styles.titleCompact : null]}
                        numberOfLines={props.findRevealBlockId === 'tool-title' ? undefined : 1}
                    >
                        {findRanges('tool-title')?.length ? <FindHighlightedText text={props.title} ranges={findRanges('tool-title')} /> : props.title}
                    </Text>
                    {showSubtitleInline ? (
                        <Text style={styles.subtitleInline} numberOfLines={props.findRevealBlockId === 'tool-subtitle' ? undefined : props.subtitleWraps ? 3 : 1}>
                            {findRanges('tool-subtitle')?.length ? <FindHighlightedText text={props.subtitle!} ranges={findRanges('tool-subtitle')} /> : props.subtitle}
                        </Text>
                    ) : null}
                    {showStatusInline ? (
                        <Text style={styles.statusInline} numberOfLines={props.findRevealBlockId === 'tool-status' ? undefined : 1}>
                            {' · '}{findRanges('tool-status')?.length ? <FindHighlightedText text={props.statusText!} ranges={findRanges('tool-status')} /> : props.statusText}
                        </Text>
                    ) : null}
                </View>
                {props.rightElement ? <View style={styles.actions}>{props.rightElement}</View> : null}
            </Pressable>
            {hasRevealSlot ? (
                <View style={styles.revealSlotGroup}>
                    {revealAction != null ? (
                        <RowActionRevealSlot
                            revealed={pinRevealed}
                            reserveWidth={TOOL_TIMELINE_ROW_REVEAL_ACTION_WIDTH}
                            style={styles.revealSlot}
                            onFocus={trackHoverState ? handleHoverIn : undefined}
                            onBlur={trackHoverState ? handleHoverOut : undefined}
                            testID={TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID}
                        >
                            {revealAction}
                        </RowActionRevealSlot>
                    ) : null}
                    {canOpen ? (
                        <RowActionRevealSlot
                            revealed={openRevealed}
                            reserveWidth={TOOL_TIMELINE_ROW_OPEN_SLOT_WIDTH}
                            style={styles.revealSlot}
                            onFocus={trackHoverState ? handleHoverIn : undefined}
                            onBlur={trackHoverState ? handleHoverOut : undefined}
                            testID={TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID}
                        >
                            <Pressable
                                testID={props.openActionTestID}
                                onPress={handleOpenPress}
                                accessibilityRole="button"
                                accessibilityLabel={t('toolView.open')}
                                style={({ pressed }) => [styles.open, pressed && styles.openPressed]}
                            >
                                <Icon name="arrow-square-out" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                            </Pressable>
                        </RowActionRevealSlot>
                    ) : null}
                </View>
            ) : null}
            {props.terminalStatus ? (
                <Pressable
                    testID="tool-timeline-row-status-slot"
                    onPress={props.onPress ?? undefined}
                    disabled={!props.onPress}
                    style={styles.terminalStatusSlot}
                >
                    {props.terminalStatus}
                </Pressable>
            ) : null}
        </View>
        {props.causeText ? (
            <Text testID="tool-timeline-row-cause" style={styles.cause}>{props.causeText}</Text>
        ) : null}
        </>
    );
});

const styles = StyleSheet.create((theme, _runtime) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    terminalStatusSlot: {
        // The title and its subtitle keep priority on a narrow row: the status shrinks (and ellipsizes) after
        // taking at most half of it, instead of leaving the title a few characters.
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '50%',
        // The outcome fills the slot (its own content right-aligned) so a narrow slot ellipsizes its word rather than
        // letting it spill over the row's actions.
        alignItems: 'stretch',
        justifyContent: 'center',
    },
    cause: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        // Under the title: the icon column and its gap, so the cause reads as part of the row.
        paddingLeft: 18 + theme.space.s6,
        paddingBottom: theme.space.s4,
    },
    row: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 0,
        paddingVertical: 0,
        gap: theme.space.s6,
        borderRadius: 10,
        minHeight: 30,
    },
    rowCompact: {
        minHeight: 28,
    },
    rowPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    icon: {
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconStack: {
        position: 'relative',
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconLayer: {
        opacity: 1,
    },
    iconLayerOverlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconLayerHidden: {
        opacity: 0,
    },
    text: {
        flex: 1,
        flexDirection: 'row',
        minWidth: 0,
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: theme.space.s8,
        fontSize: 13,
    },
    textWrapping: {
        flexWrap: 'wrap',
        rowGap: 0,
    },
    title: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
        // The title keeps its width and the subtitle gives way first, but a long title still ends in an
        // ellipsis on a narrow row instead of pushing the row past its edge (lab `.l12-tl .tt`).
        flexShrink: 0,
        maxWidth: '70%',
    },
    titleCompact: {
        fontSize: 13,
        lineHeight: 18,
    },
    subtitleInline: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        minWidth: 0,
        flexShrink: 1,
    },
    statusInline: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        minWidth: 0,
        flexShrink: 1,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
        flexShrink: 1,
        justifyContent: 'flex-end',
    },
    revealSlotGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    revealSlot: {
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    open: {
        padding: theme.space.s4,
        borderRadius: 10,
    },
    openPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
}));
