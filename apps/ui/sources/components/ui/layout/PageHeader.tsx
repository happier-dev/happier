import { PaneMainHideButton, usePaneMainHideAvailable } from '@/components/appShell/panes/mainColumn/PaneMainColumnControls';
import * as React from 'react';
import { Dimensions, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierPageHeader,
    HappierPageHeaderInlineTitleContext,
    HappierPageHeaderPlaceholder,
    HappierPageHeaderMetaId,
    happierPageTextMetrics,
    type HappierPageHeaderMetaIdHost,
    type HappierPageHeaderProps,
    type HappierPageHeaderTextRender,
} from '@happier-dev/plugin-ui/presentation';

import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { SkeletonTitle } from '@/components/ui/lists/SkeletonRows';
import { Typography } from '@/constants/Typography';
import { pageTitleTypography, usePageTitleMaxLines } from '@/components/ui/layout/pageTitleTypography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { BACK_INK_ON_EDGE_STYLE } from '@/components/navigation/Header';
import { Text } from '@/components/ui/text/Text';
import { MiddleEllipsisText } from '@/components/ui/text/MiddleEllipsisText';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { t } from '@/text';
import { InlineTextField, type InlineTextEditor } from '@/components/ui/text/InlineTextField';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { PageFrameWidthsContext } from '@/components/ui/lists/listPresentation';
import { NavigationHeaderActions, type NavigationHeaderAction } from '@/components/ui/layout/NavigationHeaderActions';
import { useNavigationChromeShowsBack, useNavigationLeavesLargeTitle, useNavigationTitleChromePublisher, useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { useClaimedStackHeaderActions } from '@/components/navigation/stackHeaderActions';

export { NavigationTitleChromeProvider, useNavigationTitleChromeShowsTitle } from './navigationTitleChrome';

/** Web only: body copy avoids a lone last word without balancing (which narrows every two-line paragraph). */
const PRETTY_TEXT_WRAP = Platform.OS === 'web' ? ({ textWrap: 'pretty' } as const) : null;

/** One fact on a page header's meta line: "@handle", "Personal Home", "🔒 End-to-end encrypted". */
export type PageHeaderMetaFact = Readonly<{
    key: string;
    text: string;
    /** A small glyph before the text (a lock for encryption). */
    icon?: IconName;
    /** The fact is an address, path or id: drawn in the mono face. */
    mono?: boolean;
    /** Still being read: a quiet bar as wide as `text` (a representative value) holds its place (`HappierPageHeader`). */
    pending?: boolean;
    testID?: string;
    /** The fact is the link to what it names; `accessibilityLabel` says where it goes. */
    onPress?: () => void;
    accessibilityLabel?: string;
}>;

/**
 * An entity page whose identity is edited in place (a workflow's name and description): the title and
 * description render as the page's own text, editable with the caret as the only focus cue.
 */
export type PageHeaderTextEditor = InlineTextEditor;

/** The page's one primary action (Create, Save): in the page on wide layouts, in the native header on phones. */
export type PageHeaderPrimaryAction = NavigationHeaderAction & Readonly<{
    /**
     * `secondary`: a page whose lab keeps its main action quiet beside its content (a preset's "Create one",
     * Home's "Invite people", a running Review's "Stop reviewing") draws it as a secondary button. It is the page's
     * primary all the same, so a phone puts it in the navigation header, still secondary, rather than folding it into
     * "More actions".
     */
    presentation?: 'secondary';
}>;

export type PageHeaderProps = Readonly<{
    title: string;
    /** Where the thing sits among its siblings, on one quiet line over the title ("High · 3 of 6"). */
    kicker?: string;
    /**
     * The title as a control (a main screen's "Artifacts ⌄", which opens its filters), drawn in the title's place.
     * `title` still names the page for the navigation chrome and assistive technology.
     */
    titleControl?: React.ReactNode;
    /** An inline mark after the title, such as a release-channel badge. */
    titleAccessory?: React.ReactNode;
    /** One sentence saying what the page is for (a node only when the sentence itself animates). */
    description?: React.ReactNode;
    /** A description set by data (a skill's own frontmatter) of any length stops at this many lines; static copy omits it. */
    descriptionLines?: number;
    /**
     * The editable title's resting lines (two by default). A page that shares its width with a companion
     * pane keeps its title to one line so the header holds its height (the workflow editor, F5).
     */
    titleLines?: 1 | 2;
    /**
     * The title is still being read (a Machine whose name has not opened yet): the quiet loading bar stands on the
     * title's own line box, as wide as `title` drawn there, so nothing moves when the name lands and the word is never
     * shown. `title` still names the page for the navigation chrome.
     */
    titlePending?: boolean;
    /** Identity details under the description (an identifier to copy, a version and machine). */
    details?: React.ReactNode;
    /** Defaults to identity; column places the summary below title and actions at full content width. */
    detailsPlacement?: 'identity' | 'column';
    /** Center an entity's identity above its controls in a compact measured pane. */
    compactPresentation?: 'centered';
    /**
     * The distinguishing facts of the thing the page is about, on one quiet line (wrapping when
     * narrow), after `details`. An empty list keeps the line's place while the facts load.
     */
    meta?: readonly PageHeaderMetaFact[];
    /** A leading identity mark (entity logo, avatar). */
    leading?: React.ReactNode;
    /** `title`: only the mark and title form the icon row; the purpose and facts start on the content edge. */
    markSpan?: HappierPageHeaderProps['markSpan'];
    /** Keeps this many fact lines in a narrow column while values open. */
    reserveNarrowMetaLines?: HappierPageHeaderProps['reserveNarrowMetaLines'];
    /**
     * An identity mark on the title's own line, before the title, where the purpose line runs flush left under both
     * (a docked New bot's face). Like `leading`, an entity mark keeps the page title's size.
     */
    titleLeading?: React.ReactNode;
    /**
     * Context controls and quiet actions (a machine chip, Discard). They fold into the navigation header's
     * overflow on phones and stay in the page elsewhere; use `primaryAction` for the action that remains
     * directly visible, and `menu` for the page's `⋯`.
     */
    actions?: React.ReactNode;
    /**
     * The page's `⋯` (a `PageHeaderMenu`). The header alone places it: last, after the page's controls and
     * the primary, so it keeps its place whether a primary is offered, arrives later or goes away. On phones
     * its rows join the bar's one menu.
     */
    menu?: React.ReactNode;
    /** Keep an entity's frequent operations in its page instead of the phone navigation overflow. */
    actionsPlacement?: 'navigation' | 'page';
    /**
     * A list's own frequent controls (its "+" add menu, a privacy eye): kept as they are at the phone
     * navigation bar's trailing edge, after the folded menu, and closing the page's actions elsewhere.
     */
    navigationTrailing?: React.ReactNode;
    /**
     * Prefer the title row, wrapping controls beneath when the title needs its readable width
     * (`wrap`); keep them on it (`inline`); or hang the mark and controls from the title's line with
     * the description and facts beneath at full width (`hang`).
     */
    actionsLayout?: 'wrap' | 'inline' | 'hang' | 'shrink';
    /**
     * A status line under the actions (a save state and validity readout). It is the actions' own
     * row, as wide as they are, so its changing words never reflow the title.
     */
    status?: React.ReactNode;
    /**
     * The page's one primary action. Where navigation chrome shows the title (phones), it moves into
     * the native header instead of stacking under the purpose line; elsewhere it closes `actions`.
     */
    primaryAction?: PageHeaderPrimaryAction;
    /**
     * Leaving without saving (a new item's Cancel). On wide layouts it sits before the primary; on
     * phones it replaces the native header's back.
     */
    cancelAction?: PageHeaderPrimaryAction;
    /** Always show the title even when navigation chrome shows it (entity pages whose title is the entity). */
    alwaysShowTitle?: boolean;
    /**
     * With `alwaysShowTitle`: what the navigation bar names above the page instead of its generic destination
     * title, the thing Back returns to (a phone's pushed finding reads "‹ Review").
     */
    navigationTitle?: string;
    /**
     * Keep Back in the phone navigation bar even on a deep link with no history, without drawing the
     * title in the body (a page whose entity cannot be shown, such as a Run that no longer exists).
     * Where chrome does not show the title, the header draws the title and Back itself as usual.
     */
    alwaysShowBack?: boolean;
    /**
     * `column` (default): aligned with the page's content column. `pane`: spans the whole pane, for a
     * page whose body is full-bleed (a board's canvas), so the header lines up with it.
     */
    columnWidth?: 'column' | 'pane';
    /** Extra leading inset onto the edge of content hung beside a mark column (`HappierPageHeader` `contentInsetPx`). */
    contentInsetPx?: number;
    /**
     * Edit the title in place. Enter commits, Escape restores the value held when editing began, and
     * a long title wraps. The page heading stays the title; `title` remains its plain-text form.
     */
    titleEditor?: PageHeaderTextEditor;
    /** Edit the description in place as a multiline field under the title. */
    descriptionEditor?: PageHeaderTextEditor;
    /** An entrance that moves the identity and fades what supports it, in place (`HappierPageHeader`). */
    wrapPart?: HappierPageHeaderProps['wrapPart'];
    testID?: string;
}>;

/**
 * The header of a full configuration or detail page: title, one-line purpose, optional leading mark
 * and actions. It aligns with the section headings of page-presented groups below it.
 *
 * Its layout — the title row, the gutter-or-title-row back placement, the meta line and the phone
 * recomposition — is the shared presentation owner `HappierPageHeader`, which the public plugin
 * `PageHeader` renders too; this adapter supplies Happier's navigation chrome (title suppression and
 * the back control), the content column width and its own text owner.
 */
/** The header's meta facts as its presentation draws them: one icon size and ink for every header. */
function usePageHeaderMeta(facts: readonly PageHeaderMetaFact[] | undefined) {
    const { theme } = useUnistyles();
    return React.useMemo(() => facts?.map((fact) => ({
        key: fact.key,
        text: fact.text,
        ...(fact.mono ? { mono: true } : {}),
        ...(fact.pending ? { pending: true } : {}),
        ...(fact.testID === undefined ? {} : { testID: fact.testID }),
        ...(fact.onPress === undefined ? {} : { onPress: fact.onPress }),
        ...(fact.accessibilityLabel === undefined ? {} : { accessibilityLabel: fact.accessibilityLabel }),
        ...(fact.icon
            ? { icon: <Icon name={fact.icon} size={ICON_SIZE.xs} color={theme.colors.text.secondary} /> }
            : {}),
    })), [facts, theme.colors.text.secondary]);
}

/**
 * Where the page's Back goes: into retained phone title chrome, or onto the header's own title line (the gutter or
 * the line above the title, placed by the shared header). The header and its placeholder both take it from here,
 * so a header that arrives stands where its placeholder stood, back line included.
 */
function usePageHeaderBack(options: Readonly<{ alwaysShowTitle?: boolean; alwaysShowBack?: boolean }>) {
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    const chromeShowsBack = useNavigationChromeShowsBack();
    const setChromeBack = useNavigationTitleChromePublisher()?.setBack;
    const BackControl = useNavigationBackControl();
    // An entity page under retained title chrome puts its Back in that bar even on a deep link with no
    // history, so the identity starts on the same edge however the page was opened (DESIGN-9 P12).
    const publishesBack = Boolean(setChromeBack && chromeShowsTitle && BackControl && (chromeShowsBack || options.alwaysShowTitle === true || options.alwaysShowBack === true));
    const renderBack = React.useMemo(
        () => (BackControl && !chromeShowsBack && !publishesBack ? (style: StyleProp<ViewStyle>) => <BackControl style={[BACK_INK_ON_EDGE_STYLE, style]} /> : null),
        [BackControl, chromeShowsBack, publishesBack],
    );
    React.useEffect(() => {
        if (!publishesBack || !setChromeBack || !BackControl) return;
        // A retained phone header must use the same departure owner as its
        // inline Back, not the Expo stack that only mirrors its URL.
        setChromeBack(<BackControl style={{}} />);
        return () => setChromeBack(null);
    }, [BackControl, publishesBack, setChromeBack]);
    return renderBack;
}

export const PageHeader = React.memo(function PageHeader(props: PageHeaderProps) {
    const maxWidth = useLayoutMaxWidth();
    const initialFrameWidthPx = React.useContext(PageFrameWidthsContext)?.outer;
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    const largeTitle = useNavigationLeavesLargeTitle();
    const publisher = useNavigationTitleChromePublisher();
    const setChromeTitle = publisher?.setTitle;
    const setPageTitle = publisher?.setPageTitle;
    React.useEffect(() => {
        setPageTitle?.(props.title);
    }, [props.title, setPageTitle]);
    React.useEffect(() => () => setPageTitle?.(undefined), [setPageTitle]);
    React.useEffect(() => {
        if (!setChromeTitle) return;
        // Entity identity stays in the body. Leave its generic destination
        // title (for example "Workflow") with the navigation owner. A large title is the page's own
        // name: the bar above it left the name to the page, so it never goes into the bar.
        // A page that keeps its title may name what its Back returns to instead.
        setChromeTitle(props.alwaysShowTitle || largeTitle ? props.navigationTitle : props.title);
        return () => setChromeTitle(undefined);
    }, [largeTitle, props.alwaysShowTitle, props.navigationTitle, props.title, setChromeTitle]);
    const showTitle = props.alwaysShowTitle === true || largeTitle || !chromeShowsTitle;
    const renderBack = usePageHeaderBack({ alwaysShowTitle: props.alwaysShowTitle, alwaysShowBack: props.alwaysShowBack });
    // Navigation owns ordinary page actions; an entity can retain its frequent operations by its identity.

    // A phone bar too narrow to draw the primary whole (large text) hands it back: it sits under the title,
    // as on a wide layout, until the window grows past the width where it did not fit.
    // Only a handed-back primary listens to the window, so ordinary pages never re-render on a resize.
    const [primaryDidNotFitAt, setPrimaryDidNotFitAt] = React.useState<number | null>(null);
    const primaryInPage = chromeShowsTitle && primaryDidNotFitAt !== null && props.primaryAction != null;
    const onPrimaryDoesNotFit = React.useCallback(() => setPrimaryDidNotFitAt(Dimensions.get('window').width), []);
    React.useEffect(() => {
        if (primaryDidNotFitAt === null) return undefined;
        const subscription = Dimensions.addEventListener('change', ({ window }) => {
            if (window.width > primaryDidNotFitAt) setPrimaryDidNotFitAt(null);
        });
        return () => subscription.remove();
    }, [primaryDidNotFitAt]);
    // A page that keeps its actions beside its identity (`actionsPlacement="page"`) keeps its primary there too.
    const primaryInPageAlways = props.actionsPlacement === 'page';
    const pageButtons = (!chromeShowsTitle || primaryInPage || primaryInPageAlways) && (props.primaryAction || props.cancelAction) ? (
        <>
            {props.cancelAction && !chromeShowsTitle ? <PageHeaderActionButton action={props.cancelAction} quiet /> : null}
            {props.primaryAction ? <PageHeaderActionButton action={props.primaryAction} /> : null}
        </>
    ) : null;
    // Inside the desktop app shell the stack header is not drawn; the actions its route put there
    // (an "Add friend") come here instead (`stackHeaderActions`). Elsewhere there are none.
    const routeActions = useClaimedStackHeaderActions();
    // A page that is a pane host's main column offers "Hide <page>" as its header's last control.
    const hideMain = usePaneMainHideAvailable() ? <PaneMainHideButton /> : null;
    const inPage = !chromeShowsTitle || props.actionsPlacement === 'page';
    const pageActions = inPage ? props.actions : null;
    // One order for every header: the page's controls, the route's, the primary, then "⋯" (only a pane's Hide follows).
    const menu = inPage ? props.menu ?? null : null;
    const trailingActions = !chromeShowsTitle && props.navigationTrailing != null
        ? <>{menu}{props.navigationTrailing}</>
        : menu;
    const actions = pageButtons || routeActions
        ? <View style={stylesheet.actions}>{pageActions}{routeActions}{pageButtons}{trailingActions}{hideMain}</View>
        : hideMain ? <>{pageActions}{trailingActions}{hideMain}</>
        : trailingActions === null ? pageActions : <>{pageActions}{trailingActions}</>;
    // On phones the page's controls and its menu rows fold into the bar's one `⋯`, which the bar draws after the primary.
    const barActions = React.useMemo(() => props.actionsPlacement === 'page' ? undefined
        : props.menu == null ? props.actions : <>{props.actions}{props.menu}</>, [props.actions, props.actionsPlacement, props.menu]);
    const meta = usePageHeaderMeta(props.meta);

    const titleMaxLines = usePageTitleMaxLines();
    const { descriptionLines } = props;
    const renderText = React.useMemo<HappierPageHeaderTextRender>(
        () => descriptionLines === undefined
            ? renderPageHeaderText
            : (input) => input.role === 'pageDescription'
                ? <Text numberOfLines={descriptionLines} style={stylesheet.description}>{input.text}</Text>
                : renderPageHeaderText(input),
        [descriptionLines],
    );
    const ownTitleNode = props.titleControl != null ? props.titleControl : props.titleEditor
        // The editable title stops where the read-only one does, until the person edits it.
        ? <InlineTextField editor={props.titleEditor} style={stylesheet.titleInput}
            restingLines={props.titleLines ?? titleMaxLines} />
        : props.titlePending ? <PendingPageTitle title={props.title} />
        // A drawn title keeps each " · " separator with the word before it: a wrapped line never starts with "·".
        : props.title.replaceAll(' · ', '\u00A0· ');
    const titleNode = props.titleLeading != null
        ? <View style={stylesheet.titleLeadingLine}>{props.titleLeading}<View style={stylesheet.titleLeadingTitle}>{ownTitleNode}</View></View>
        : ownTitleNode;
    const descriptionNode = props.descriptionEditor
        ? <InlineTextField editor={props.descriptionEditor} multiline style={stylesheet.descriptionInput} />
        : props.description;

    return (
        <HappierPageHeaderInlineTitleContext.Provider value={renderPageTitle}>
        {props.primaryAction || props.cancelAction || props.actions || props.menu || props.navigationTrailing ? (
            <NavigationHeaderActions primary={primaryInPage || primaryInPageAlways ? null : props.primaryAction ?? null} cancel={props.cancelAction ?? null}
                actions={barActions} trailing={props.navigationTrailing}
                onPrimaryDoesNotFit={onPrimaryDoesNotFit} />
        ) : null}
        <HappierPageHeader
            title={titleNode}
            kicker={props.kicker}
            largeTitle={largeTitle && props.titleLeading == null}
            showTitle={showTitle}
            titleAccessory={props.titleAccessory}
            description={descriptionNode}
            details={props.details}
            detailsPlacement={props.detailsPlacement}
            compactPresentation={props.compactPresentation}
            meta={meta}
            {...(props.reserveNarrowMetaLines === undefined ? {} : { reserveNarrowMetaLines: props.reserveNarrowMetaLines })}
            leading={props.leading}
            markSpan={props.markSpan}
            actions={actions ? <RoundButtonSizeScope size="normal">{actions}</RoundButtonSizeScope> : actions}
            // The editor takes the title's column. The shared hanging layout moves controls below
            // once the remaining width cannot hold the title column.
            actionsLayout={props.actionsLayout ?? (props.titleControl == null && props.titleEditor ? 'hang' : undefined)}
            status={props.status}
            renderBack={renderBack}
            initialFrameWidthPx={initialFrameWidthPx}
            columnMaxWidthPx={props.columnWidth === 'pane' ? undefined : maxWidth}
            {...(props.contentInsetPx === undefined ? {} : { contentInsetPx: props.contentInsetPx })}
            renderText={renderText}
            wrapPart={props.wrapPart}
            testID={props.testID}
        />
        </HappierPageHeaderInlineTitleContext.Provider>
    );
});


/**
 * A page header whose page is not known yet: the header owner's own geometry with a quiet bar on the title's
 * line, so a real header lands where this one stood. Navigation chrome that draws the title keeps it there.
 * An entity page passes what it already knows of its header (the mark, the meta facts) so those stand still too;
 * it then shows its own title, as the arriving header does.
 */
export const PageHeaderPlaceholder = React.memo(function PageHeaderPlaceholder(props: Readonly<{
    testID?: string;
    leading?: React.ReactNode;
    meta?: readonly PageHeaderMetaFact[];
    alwaysShowTitle?: boolean;
}>) {
    const { theme } = useUnistyles();
    const meta = usePageHeaderMeta(props.meta);
    const maxWidth = useLayoutMaxWidth();
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    const largeTitle = useNavigationLeavesLargeTitle();
    const reducedMotion = useReducedMotionPreference();
    const renderBack = usePageHeaderBack({ alwaysShowTitle: props.alwaysShowTitle });
    const initialFrameWidthPx = React.useContext(PageFrameWidthsContext)?.outer;
    return (
        <HappierPageHeaderPlaceholder
            renderBack={renderBack}
            initialFrameWidthPx={initialFrameWidthPx}
            color={theme.colors.surface.skeleton}
            reducedMotion={reducedMotion}
            // The same rule as the header that replaces it, so it stands at the same top.
            largeTitle={largeTitle}
            showTitle={props.alwaysShowTitle === true || !chromeShowsTitle}
            columnMaxWidthPx={maxWidth}
            renderText={renderPageHeaderText}
            leading={props.leading}
            meta={meta}
            testID={props.testID}
        />
    );
});

/** A page's primary (or cancel) action as a button; an Add dialog's footer draws a hosted editor's Save with it. */
export function PageHeaderActionButton(props: Readonly<{ action: PageHeaderPrimaryAction; quiet?: boolean }>) {
    const { action } = props;
    const { theme } = useUnistyles();
    const display = props.quiet ? 'inverted' : action.presentation === 'secondary' ? 'secondary' : undefined;
    return (
        <RoundButton
            testID={action.testID}
            display={display}
            leading={action.icon ? (
                <Icon name={action.icon} size={ICON_SIZE.xs} color={display ? theme.colors.text.primary : theme.colors.button.primary.tint} />
            ) : undefined}
            title={action.title}
            accessibilityLabel={action.title}
            disabled={action.disabled}
            {...(action.disabledReason ? { disabledReason: action.disabledReason } : {})}
            {...(action.accessibilityHint ? { accessibilityHint: action.accessibilityHint } : {})}
            loading={action.loading}
            preserveFocusOnPress={action.preserveFocusOnPress}
            action={() => Promise.resolve(action.onPress())}
        />
    );
}

/**
 * A title still being read: the title's own text, unseen, sets the line box, and the loading rows' quiet bar stands on it
 * (the meta line's pending fact, for the title).
 */
function PendingPageTitle(props: Readonly<{ title: string }>) {
    return (
        <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={stylesheet.pendingTitle}>
            <View style={stylesheet.pendingTitleText}>
                <PageTitleText header={false} style={stylesheet.title}>{props.title}</PageTitleText>
            </View>
            <View style={stylesheet.pendingTitleBar}>
                <SkeletonTitle line="whole" lineHeight={PAGE_TITLE_LINE_HEIGHT} testID="page-header-title-pending" />
            </View>
        </View>
    );
}

const PAGE_TITLE_LINE_HEIGHT = happierPageTextMetrics('pageTitle').lineHeight;

/** A page title wraps before it ends in an ellipsis, by the one title line rule (`usePageTitleMaxLines`). */
function PageTitleText(props: Readonly<{
    header: boolean;
    style: React.ComponentProps<typeof Text>['style'];
    children: string;
    inlineEnd?: React.ReactNode;
}>) {
    const maxLines = usePageTitleMaxLines();
    return (
        // The page's own title is its level-one heading; react-native-web's bare `heading` role reads as level 2.
        <Text accessibilityRole={props.header ? 'header' : undefined} aria-level={props.header ? 1 : undefined}
            accessibilityLabel={props.inlineEnd ? props.children : undefined}
            // Keep an attached action visible and reachable when a long name spans several lines.
            numberOfLines={props.inlineEnd ? undefined : maxLines}
            style={[props.style, props.inlineEnd ? { textAlign: 'center' } : null]}>
            {props.children}{props.inlineEnd}
        </Text>
    );
}

function renderPageTitle(input: Parameters<HappierPageHeaderTextRender>[0], inlineEnd?: React.ReactNode) {
    return (
        <PageTitleText header={input.header} inlineEnd={inlineEnd}
            style={input.role === 'heroTitle' ? stylesheet.heroTitle : stylesheet.title}>
            {input.text}
        </PageTitleText>
    );
}

/** Core's text owner for the shared header (font families and text scaling), for hosts drawing it directly. */
export const renderPageHeaderText: HappierPageHeaderTextRender = (input) => input.role === 'meta' && input.mono ? (
    <MetaIdFact value={input.text} />
) : input.role === 'pageTitle' || input.role === 'heroTitle' ? (
    // An entity named by data (a Session titled by its first prompt) can be any length: the title stops
    // (PageTitleText), and the DOM text and screen readers still carry all of it.
    renderPageTitle(input)
) : (
    <Text
        accessibilityRole={input.header ? 'header' : undefined}
        style={input.role === 'meta' ? stylesheet.metaText : stylesheet.description}
    >
        {input.text}
    </Text>
);

/** Plugin-ui's meta id fact, in core's text owner and its hover tooltip. */
function MetaIdFact(props: Readonly<{ value: string }>) {
    const writeClipboard = useClipboardWrite();
    return <HappierPageHeaderMetaId value={props.value} write={writeClipboard} copiedLabel={t('common.copied')} host={META_ID_HOST} />;
}

const META_ID_HOST: HappierPageHeaderMetaIdHost = {
    renderValue: (value) => <MiddleEllipsisText value={value} style={[stylesheet.metaText, stylesheet.metaMono]} />,
    renderCopied: (label) => <Text style={stylesheet.metaText}>{label}</Text>,
    renderAnchor: ({ value, onPress, children }) => <Tooltip label={value} style={stylesheet.metaId} onPress={onPress}>{children}</Tooltip>,
};

const stylesheet = StyleSheet.create((theme) => ({
    titleLeadingLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minWidth: 0,
    },
    titleLeadingTitle: {
        flexShrink: 1,
        minWidth: 0,
    },
    pendingTitle: {
        position: 'relative',
        alignSelf: 'flex-start',
        maxWidth: '100%',
    },
    pendingTitleText: {
        opacity: 0,
    },
    pendingTitleBar: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
    },
    title: {
        ...pageTitleTypography(),
        color: theme.colors.text.primary,
    },
    heroTitle: {
        ...Typography.default('bold'),
        ...happierPageTextMetrics('heroTitle'),
        color: theme.colors.text.primary,
    },
    // The editable forms keep the text steps exactly, so editing never moves the page.
    titleInput: {
        ...pageTitleTypography(),
        color: theme.colors.text.primary,
        padding: 0,
        margin: 0,
        minWidth: 0,
    },
    descriptionInput: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
        padding: 0,
        margin: 0,
        minWidth: 0,
    },
    description: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
        // A purpose fills the page's measure; a second line never leaves one word alone on it. Balanced wrapping
        // halved the line (a two-line purpose wrapped at about 420 px under a full-width page), so body copy wraps pretty.
        ...PRETTY_TEXT_WRAP,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    metaText: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
    // An address or path on the meta line: the mono face at the meta step.
    metaMono: {
        ...Typography.mono(),
        ...happierPageTextMetrics('meta'),
    },
    // Its hover anchor shrinks with the line, so the id gives up its middle rather than the line's width.
    metaId: {
        flexShrink: 1,
        minWidth: 0,
    },
}));
