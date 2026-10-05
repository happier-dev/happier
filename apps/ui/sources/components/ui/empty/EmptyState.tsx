import { HAPPIER_EMPTY_STATE_FRAME, HAPPIER_STATE_LINE_METRICS, HAPPIER_STATE_SIZE_METRICS, HappierInfoState, type HappierStateSize } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Item } from '@/components/ui/lists/Item';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const LINE_LINK_MIN_TARGET_PX = resolveMinimumInteractiveTargetSize(Platform.OS);

/** The one thing to do about an empty page: create the first item, connect, sign in. */
export type EmptyStatePrimaryAction = Readonly<{
    /** Already-translated verb ("New Team", "Create token"). */
    label: string;
    onPress: () => void | Promise<unknown>;
    disabled?: boolean;
    testID?: string;
}>;

type EmptyStateProps = Readonly<{
    /**
     * The state's glyph, drawn at the empty-state size and colour. It stands alone: never in a tile or
     * a ring. The `line` layout draws it small and quiet in the row's leading column.
     */
    iconName?: IconName;
    /** A caller-drawn glyph (a spinner, a group of brand marks) when `iconName` cannot express it. */
    icon?: React.ReactNode;
    /** Already-translated title string. */
    title: string;
    /** Optional glyph decoration; the original title remains available as semantic copy. */
    titleContent?: React.ReactNode;
    /** Already-translated supporting copy: one line saying what would be here and why. */
    subtitle?: React.ReactNode;
    /**
     * The page's one primary action, rendered as the primary button. In the `line` layout it is a quiet
     * inline link after the sentence instead.
     */
    primaryAction?: EmptyStatePrimaryAction;
    /**
     * A quiet second way forward under the primary action, as a text button (for example, opening the
     * setting that would let everyone do this). Only rendered with a `primaryAction`, except in the
     * `line` layout, where it is a second inline link.
     */
    secondaryAction?: EmptyStatePrimaryAction;
    /**
     * Why this viewer cannot take the page's main action, and who can ("Only administrators of Studio
     * can create Teams…"). Shown in the action's place instead of leaving a dead end.
     */
    actionUnavailableReason?: string;
    /** A custom call-to-action below the copy, for states whose action is not one button. */
    action?: React.ReactNode;
    /**
     * `add` frames the state with a dashed outline: an invitation to add something to a collection.
     * Use it only for adding; a plain empty or unavailable state stays `default`.
     */
    variant?: 'default' | 'add';
    /**
     * - `page`: a whole page or pane with nothing in it — glyph, title, purpose and one primary action,
     *   in the content column with the page's spacing.
     * - `line`: one quiet line inside a list, rail or sheet, on the rows' edge.
     * - `inline`: mark, copy and action on one line among other sheets (wraps when narrow).
     * - `centered`: the compact centred column for panes and cards (`SurfaceStateCard`).
     */
    layout?: 'page' | 'line' | 'inline' | 'centered';
    /** `line` only: the row's pressable style when the line sits among styled rows (a rail's rows). */
    lineRowStyle?: React.ComponentProps<typeof Item>['pressableStyle'];
    /**
     * `centered` only: the container's size step (pane, details, page, phone), which sets the measure,
     * glyph and type. `SurfaceStateCard` passes its container's size here.
     */
    size?: HappierStateSize;
    /** `line` only: the density of the rows it sits among. */
    lineDensity?: React.ComponentProps<typeof Item>['density'];
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    actionTestID?: string;
    paddingHorizontal?: number;
    /** A containing sheet may already own the inline state's inset. */
    paddingVertical?: number;
}>;

const EmptyStateLineLink = React.memo(function EmptyStateLineLink(props: Readonly<{ link: EmptyStatePrimaryAction }>) {
    return (
        <Pressable
            testID={props.link.testID}
            accessibilityRole="button"
            accessibilityLabel={props.link.label}
            accessibilityState={{ disabled: props.link.disabled === true }}
            disabled={props.link.disabled}
            onPress={() => { void props.link.onPress(); }}
            hitSlop={6}
            style={stylesheet.lineLink}
        >
            <Text style={stylesheet.lineLinkLabel}>{props.link.label}</Text>
        </Pressable>
    );
});

/**
 * The app's one empty state: a calm glyph (no tile), a title, one line of purpose and one primary
 * action — or, when the viewer cannot act, why and who can. i18n is the caller's responsibility: pass
 * already-translated strings.
 *
 * The centred column and the action slot's offset are the shared presentation owner (UI-T27), which
 * the plugin loading/empty/error states render too; {@link CenteredInfoTile} supplies core's
 * Unistyles typography.
 */
export const EmptyState = React.memo((props: EmptyStateProps) => {
    const { theme } = useUnistyles();
    const frame = props.variant === 'add' ? stylesheet.addFrame : null;

    if (props.layout === 'line') {
        // In a list line the ways forward are quiet inline links after the sentence ("Nothing in My
        // work. Show all sessions"), never buttons: the rows around it stay the content.
        const lineLinks = [props.primaryAction, props.secondaryAction].filter(
            (entry): entry is EmptyStatePrimaryAction => entry !== undefined,
        );
        const lineAction = lineLinks.length > 0 ? (
            <View style={stylesheet.lineLinks}>
                {lineLinks.map((link) => (
                    <EmptyStateLineLink key={link.label} link={link} />
                ))}
            </View>
        ) : props.action;
        // Lab 0 "N": a line may lead with its kind's glyph (a ring while loading, a warning while failed),
        // small and quiet on the rows' edge.
        const lineGlyph = props.icon ?? (props.iconName
            ? <Icon name={props.iconName} size={HAPPIER_STATE_LINE_METRICS.glyphPx} color={theme.colors.text.tertiary} />
            : undefined);
        return (
            <Item
                testID={props.testID}
                icon={lineGlyph}
                title={props.title}
                titleStyle={stylesheet.lineTitle}
                subtitle={typeof props.subtitle === 'string' ? props.subtitle : undefined}
                // The line's sentence is why the list is empty and what to do; it wraps, never cut.
                subtitleLines={0}
                mode="info"
                showChevron={false}
                density={props.lineDensity}
                pressableStyle={props.lineRowStyle}
                rightElement={lineAction ?? undefined}
            />
        );
    }

    const sizeMetrics = props.size ? HAPPIER_STATE_SIZE_METRICS[props.size] : null;
    const glyph = props.icon ?? (props.iconName
        ? <Icon name={props.iconName} size={sizeMetrics?.glyphPx ?? ICON_SIZE.xl} color={theme.colors.text.secondary} />
        : null);
    const primaryButton = props.primaryAction ? (
        <RoundButton
            testID={props.primaryAction.testID}
            size="normal"
            title={props.primaryAction.label}
            accessibilityLabel={props.primaryAction.label}
            disabled={props.primaryAction.disabled}
            action={() => Promise.resolve(props.primaryAction!.onPress())}
        />
    ) : null;
    const actionContent = primaryButton && props.secondaryAction ? (
        <View style={stylesheet.actionStack}>
            {primaryButton}
            <RoundButton
                testID={props.secondaryAction.testID}
                size="small"
                display="inverted"
                title={props.secondaryAction.label}
                accessibilityLabel={props.secondaryAction.label}
                disabled={props.secondaryAction.disabled}
                action={() => Promise.resolve(props.secondaryAction!.onPress())}
            />
        </View>
    ) : primaryButton ? primaryButton : props.actionUnavailableReason ? (
        <Text style={stylesheet.unavailableReason}>{props.actionUnavailableReason}</Text>
    ) : props.action;

    if (props.layout === 'inline') {
        return (
            <View testID={props.testID} style={[stylesheet.inline, frame, !actionContent ? { flexWrap: 'nowrap' } : null, props.paddingHorizontal != null ? { paddingHorizontal: props.paddingHorizontal } : null, props.paddingVertical != null ? { paddingVertical: props.paddingVertical } : null]}>
                {glyph ? <View style={stylesheet.inlineMark}>{glyph}</View> : null}
                <View style={stylesheet.inlineCopy}>
                    <Text testID={props.titleTestID} style={stylesheet.inlineTitle}>{props.titleContent ?? props.title}</Text>
                    {props.subtitle ? (
                        <Text testID={props.subtitleTestID} style={stylesheet.inlineSubtitle}>{props.subtitle}</Text>
                    ) : null}
                </View>
                {actionContent !== null && actionContent !== undefined ? (
                    <View testID={props.actionTestID}>{actionContent}</View>
                ) : null}
            </View>
        );
    }

    const page = props.layout === 'page';
    const state = (
        <HappierInfoState
            testID={frame || page ? undefined : props.testID}
            actionTestID={props.actionTestID}
            action={actionContent}
            size={page ? undefined : props.size}
        >
            <CenteredInfoTile
                size={page ? undefined : props.size}
                icon={glyph}
                title={props.title}
                titleContent={props.titleContent}
                description={props.subtitle ?? null}
                titleTestID={props.titleTestID}
                descriptionTestID={props.subtitleTestID}
                paddingHorizontal={props.paddingHorizontal}
                paddingVertical={page ? HAPPIER_EMPTY_STATE_FRAME.pageTilePaddingVertical : undefined}
            />
        </HappierInfoState>
    );
    if (page) {
        return (
            <View testID={props.testID} style={[stylesheet.page, frame ? stylesheet.pageAdd : null]}>
                {state}
            </View>
        );
    }
    return frame ? <View testID={props.testID} style={[stylesheet.centeredFrame, frame]}>{state}</View> : state;
});

EmptyState.displayName = 'EmptyState';

const stylesheet = StyleSheet.create((theme) => ({
    // The frames are the shared empty-state owner's (the plugin `EmptyState` draws the same).
    addFrame: {
        ...HAPPIER_EMPTY_STATE_FRAME.add,
        borderColor: theme.colors.border.default,
    },
    centeredFrame: { ...HAPPIER_EMPTY_STATE_FRAME.centeredAdd },
    page: { ...HAPPIER_EMPTY_STATE_FRAME.page },
    // Lab E1: the dashed "add something here" frame, only for an invitation to add.
    pageAdd: {
        ...HAPPIER_EMPTY_STATE_FRAME.pageAdd,
        borderColor: theme.colors.border.default,
    },
    actionStack: {
        alignItems: 'center',
        gap: 4,
    },
    unavailableReason: {
        ...Typography.default(),
        ...HAPPIER_EMPTY_STATE_FRAME.unavailableReason,
        color: theme.colors.text.secondary,
    },
    lineTitle: {
        color: theme.colors.text.secondary,
    },
    lineLinks: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    lineLink: {
        minHeight: LINE_LINK_MIN_TARGET_PX,
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    // A quiet inline link: primary ink with an underline, not a button and not an accent colour.
    lineLinkLabel: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
    inline: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 16,
        rowGap: 12,
        paddingVertical: 16,
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx + 2,
    },
    inlineMark: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    inlineCopy: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 220,
        gap: 2,
    },
    inlineTitle: {
        ...Typography.default('medium'),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.primary,
    },
    inlineSubtitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));
