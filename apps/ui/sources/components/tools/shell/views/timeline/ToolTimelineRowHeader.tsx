import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { RowActionRevealSlot } from '@/components/sessions/transcript/messageActions/RowActionRevealSlot';
import { readCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import {
    shouldShowTranscriptRowActions,
    shouldShowTranscriptRowPinAction,
} from '@/components/sessions/transcript/transcriptRowActionVisibility';
import { ToolTimelineIconFrame } from './ToolTimelineIconFrame';

export const TOOL_TIMELINE_ROW_REVEAL_SLOT_TEST_ID = 'tool-timeline-row-reveal-slot';
export const TOOL_TIMELINE_ROW_PIN_SLOT_TEST_ID = 'tool-timeline-row-pin-slot';

const TOOL_TIMELINE_ROW_OPEN_SLOT_WIDTH = 26;
const TOOL_TIMELINE_ROW_REVEAL_ACTION_WIDTH = 28;

export type ToolTimelineRowDensity = 'comfortable' | 'compact';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

export type ToolTimelineRowHeaderDisclosure =
    | { behavior: 'hover'; state: 'collapsed' | 'expanded' }
    | { behavior: 'persistent'; state: 'collapsed' | 'expanded' };

export const ToolTimelineRowHeader = React.memo(function ToolTimelineRowHeader(props: {
    testID?: string;
    openActionTestID?: string;
    density: ToolTimelineRowDensity;
    icon: React.ReactNode;
    title: string;
    subtitle?: string | null;
    statusText?: string | null;
    onPress?: (() => void) | null;
    canOpen?: boolean;
    onOpen?: (() => void) | null;
    rightElement?: React.ReactNode | null;
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

    const showSubtitleInline = Boolean(props.subtitle && String(props.subtitle).trim().length > 0);
    const showStatusInline = Boolean(props.statusText && String(props.statusText).trim().length > 0);
    const canOpen = props.canOpen === true && typeof props.onOpen === 'function';
    const disclosure = props.disclosure ?? null;
    const hoverEnabled = Platform.OS === 'web' && disclosure?.behavior === 'hover' && Boolean(props.onPress);
    const revealAction = props.revealAction ?? null;
    const hasRevealSlot = canOpen || revealAction != null;
    const trackHoverState = hoverEnabled || (Platform.OS === 'web' && (Boolean(props.onPress) || hasRevealSlot));
    const [isHovered, setIsHovered] = React.useState(false);

    const handleHoverIn = React.useCallback(() => setIsHovered(true), []);
    const handleHoverOut = React.useCallback(() => setIsHovered(false), []);
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
        disclosure?.state === 'expanded' ? 'chevron-up' : disclosure?.state === 'collapsed' ? 'chevron-down' : null;

    return (
        <View style={styles.container}>
            <Pressable
                testID={props.testID}
                onPress={props.onPress ?? undefined}
                disabled={!props.onPress}
                onHoverIn={trackHoverState ? handleHoverIn : undefined}
                onHoverOut={trackHoverState ? handleHoverOut : undefined}
                style={({ pressed }) => [
                    styles.row,
                    props.density === 'compact' ? styles.rowCompact : null,
                    pressed && styles.rowPressed,
                ]}
            >
                <View style={styles.icon}>
                    {disclosure?.behavior === 'persistent' && disclosureChevronName ? (
                        <Ionicons name={disclosureChevronName} size={chevronSize} color={theme.colors.text.secondary} />
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
                                <Ionicons
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
                <View style={styles.text}>
                    <Text
                        style={[styles.title, props.density === 'compact' ? styles.titleCompact : null]}
                        numberOfLines={1}
                    >
                        {props.title}
                    </Text>
                    {showSubtitleInline ? (
                        <Text style={styles.subtitleInline} numberOfLines={1}>
                            {`${props.subtitle}`}
                        </Text>
                    ) : null}
                    {showStatusInline ? (
                        <Text style={styles.statusInline} numberOfLines={1}>
                            {` · ${props.statusText}`}
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
                                onHoverIn={trackHoverState ? handleHoverIn : undefined}
                                onHoverOut={trackHoverState ? handleHoverOut : undefined}
                                accessibilityRole="button"
                                accessibilityLabel={t('toolView.open')}
                                style={({ pressed }) => [styles.open, pressed && styles.openPressed]}
                            >
                                <Ionicons name="open-outline" size={18} color={theme.colors.text.secondary} />
                            </Pressable>
                        </RowActionRevealSlot>
                    ) : null}
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme, _runtime) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    row: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 0,
        paddingVertical: 0,
        gap: 6,
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
        gap: 8,
        fontSize: 13,
    },
    title: {
        fontSize: 13,
        lineHeight: 20,
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 0,
    },
    titleCompact: {
        fontSize: 13,
        lineHeight: 18,
    },
    subtitleInline: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default('regular'),
        minWidth: 0,
        flexShrink: 1,
    },
    statusInline: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default('regular'),
        minWidth: 0,
        flexShrink: 1,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
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
        padding: 4,
        borderRadius: 10,
    },
    openPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
}));
