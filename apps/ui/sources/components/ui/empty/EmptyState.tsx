import {
    HAPPIER_EMPTY_STATE_FRAME,
    HAPPIER_SCENE_ART_METRICS,
    HAPPIER_STATE_LINE_METRICS,
    HAPPIER_STATE_SIZE_METRICS,
    HappierInfoState,
    HappierStateLine,
    resolveHappierScene,
    resolveHappierSceneArtSize,
    type HappierSceneInput,
    type HappierStateSize,
    useHappierHitArea,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { useIsInsideItemSection } from '@/components/ui/lists/sectionLeadingColumn';
import { SceneArt } from '@/components/ui/surfaces/SceneArt';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';


/** The one thing to do about an empty page: create the first item, connect, sign in. */
export type EmptyStatePrimaryAction = Readonly<{
    /** Already-translated verb ("New Team", "Create token"). */
    label: string;
    onPress: () => void | Promise<unknown>;
    disabled?: boolean;
    testID?: string;
    /** The keyboard shortcut that does the same thing, drawn as a keycap inside the button. */
    shortcut?: string;
}>;

type EmptyStateProps = Readonly<{
    /**
     * The state's glyph, drawn at the empty-state size and colour. It stands alone: never in a tile or
     * a ring. The `line` layout draws it small and quiet in the row's leading column.
     */
    iconName?: IconName;
    /** A caller-drawn glyph (a spinner, a group of brand marks) when `iconName` cannot express it. */
    icon?: React.ReactNode;
    /**
     * The Daybreak scene drawn in the glyph's place on a `page` or `centered` state (plugin-ui scene
     * registry): a built-in scene id or a defined scene, constant across renders. `line` and `inline`
     * states keep their glyph.
     */
    scene?: HappierSceneInput;
    /** Whether the scene may play its one-shot rise (false for a surface the viewer is not looking at). */
    animationEnabled?: boolean;
    /** Already-translated title string. */
    title: string;
    /** A loading state's words: one quiet line rather than a title (`SurfaceStateCard kind="loading"`). */
    quietTitle?: boolean;
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
    /**
     * `centered` only: the container's size step (pane, details, page, phone), which sets the measure,
     * glyph and type. `SurfaceStateCard` passes its container's size here.
     */
    size?: HappierStateSize;
    /** `line` only: the row is waiting for its answer, so it leads with the quiet spinner a loading state line draws. */
    lineLoading?: boolean;
    /** `line` only: `menu` when the line sits among a menu's rows; it takes the menu row's height and glyph column. */
    lineDensity?: 'menu';
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    actionTestID?: string;
    paddingHorizontal?: number;
    /** A containing sheet may already own the inline state's inset. */
    paddingVertical?: number;
}>;

const LINE_LINK_HIT_REACH = { left: 4, right: 4 } as const;

const EmptyStateLineLink = React.memo(function EmptyStateLineLink(props: Readonly<{ link: EmptyStatePrimaryAction }>) {
    // The link draws as its text line; a finger reaches the touch target through the shared hit area
    // (sideways half the gap to the next link).
    const hitArea = useHappierHitArea({ restingStyle: () => null, hitReach: LINE_LINK_HIT_REACH, hitSlop: 6 });
    return (
        <Pressable
            testID={props.link.testID}
            accessibilityRole="button"
            accessibilityLabel={props.link.label}
            accessibilityState={{ disabled: props.link.disabled === true }}
            disabled={props.link.disabled}
            onPress={() => { void props.link.onPress(); }}
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            style={stylesheet.lineLink}
        >
            {hitArea.frame}
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
    // On a page the state is the page's content: it takes the column the header and sheets share,
    // unless a section (`ItemGroup`) around it already sits in that column.
    const inSection = useIsInsideItemSection();
    const inPageColumn = useListPresentation() === 'page' && !inSection;

    if (props.layout === 'line') {
        // In a list line the ways forward are quiet inline links, never buttons: the rows around it
        // stay the content. After a one-line statement ("Nothing in My work. Show all sessions") they
        // follow it on the line; under an explanatory sentence they sit below it on its edge, so a
        // wrapping sentence keeps the whole row width (lab ST "Nothing started yet").
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
        // small and quiet on the rows' edge. The shared line keeps the size given here.
        const lineGlyph = props.lineLoading ? (
            <ActivitySpinner
                testID={props.testID ? `${props.testID}-loading-spinner` : undefined}
                size={HAPPIER_STATE_LINE_METRICS.glyphPx - 2}
                color={theme.colors.text.tertiary}
            />
        ) : props.icon ?? (props.iconName
            ? <Icon name={props.iconName} size={HAPPIER_STATE_LINE_METRICS.glyphPx} color={theme.colors.text.tertiary} />
            : undefined);
        const sentence = typeof props.subtitle === 'string' ? props.subtitle : undefined;
        // The one in-list line (`HappierStateLine`), which the plugin line states draw too; core binds its
        // own Text (so the reader's type scale applies), glyphs and links.
        return (
            <HappierStateLine
                testID={props.testID}
                icon={lineGlyph}
                action={lineAction ?? undefined}
                density={props.lineDensity}
            >
                <Text style={stylesheet.lineText}>
                    {props.title}
                    {sentence ? ' · ' : null}
                    {sentence ? <Text testID={props.subtitleTestID} style={stylesheet.lineText}>{sentence}</Text> : null}
                </Text>
            </HappierStateLine>
        );
    }

    const sizeMetrics = props.size ? HAPPIER_STATE_SIZE_METRICS[props.size] : null;
    const sceneSize = props.scene ? resolveHappierSceneArtSize({ size: props.size, layout: props.layout ?? 'centered' }) : null;
    const glyph = sceneSize && props.scene ? (
        <EmptyStateScene
            scene={props.scene}
            size={sceneSize}
            still={props.animationEnabled === false}
            testID={props.testID ? `${props.testID}-scene` : undefined}
        />
    ) : props.icon ?? (props.iconName
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
            trailing={props.primaryAction.shortcut ? <KeyHint label={props.primaryAction.shortcut} tone="onFill" /> : undefined}
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
                quietTitle={props.quietTitle}
                icon={glyph}
                iconGap={sceneSize ? HAPPIER_SCENE_ART_METRICS[sceneSize].gapPx : undefined}
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
        const pageState = (
            <View testID={props.testID} style={[stylesheet.page, inSection ? stylesheet.pageInSection : null, frame ? stylesheet.pageAdd : null]}>
                {state}
            </View>
        );
        return inPageColumn ? <PageContentColumn>{pageState}</PageContentColumn> : pageState;
    }
    return frame ? <View testID={props.testID} style={[stylesheet.centeredFrame, frame]}>{state}</View> : state;
});

EmptyState.displayName = 'EmptyState';

/** The scene in the state's mark slot; resolved once per scene, drawn by the app's scene renderer. */
const EmptyStateScene = React.memo(function EmptyStateScene(props: Readonly<{
    scene: HappierSceneInput;
    size: HappierStateSize;
    still: boolean;
    testID?: string;
}>) {
    const scene = React.useMemo(() => resolveHappierScene(props.scene, props.size), [props.scene, props.size]);
    return <SceneArt scene={scene} size={props.size} still={props.still} testID={props.testID} />;
});

const stylesheet = StyleSheet.create((theme) => ({
    // The frames are the shared empty-state owner's (the plugin `EmptyState` draws the same).
    addFrame: {
        ...HAPPIER_EMPTY_STATE_FRAME.add,
        borderColor: theme.colors.border.default,
    },
    centeredFrame: { ...HAPPIER_EMPTY_STATE_FRAME.centeredAdd },
    page: { ...HAPPIER_EMPTY_STATE_FRAME.page },
    // A section around the state already puts it on the sheets' edges, one section gap down.
    pageInSection: { marginHorizontal: 0, marginTop: 0 },
    // Lab E1: the dashed "add something here" frame, only for an invitation to add.
    pageAdd: {
        ...HAPPIER_EMPTY_STATE_FRAME.pageAdd,
        borderColor: theme.colors.border.default,
    },
    actionStack: {
        alignItems: 'center',
        gap: theme.space.s4,
    },
    unavailableReason: {
        ...Typography.default(),
        ...HAPPIER_EMPTY_STATE_FRAME.unavailableReason,
        color: theme.colors.text.secondary,
    },
    // The line's sentence, at the shared line's type step, in core's typography.
    lineText: {
        ...Typography.default(),
        ...HAPPIER_STATE_LINE_METRICS.text,
        color: theme.colors.text.secondary,
    },
    lineLinks: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    lineLink: {
        justifyContent: 'center',
        paddingHorizontal: theme.space.s4,
    },
    // A quiet inline link: primary ink with an underline, not a button and not an accent colour.
    lineLinkLabel: {

        ...Typography.variant('body'),

        color: theme.colors.text.primary,
        textDecorationLine: 'underline',
    },
    inline: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s16,
        rowGap: theme.space.s12,
        paddingVertical: theme.space.s16,
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx + 2,
    },
    inlineMark: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    inlineCopy: {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 220,
        gap: theme.space.s2,
    },
    inlineTitle: {

        ...Typography.variant('label'),

        color: theme.colors.text.primary,
    },
    inlineSubtitle: {

        ...Typography.variant('body'),

        color: theme.colors.text.secondary,
    },
}));
