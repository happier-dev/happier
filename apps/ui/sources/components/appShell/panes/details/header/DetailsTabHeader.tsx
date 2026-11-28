import * as React from 'react';
import { useContainingGlassSurfaceGroup } from '@/components/ui/glass/GlassSurface';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_ICON_BUTTON_SIZE, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { PaneHeader, PaneHeaderLineView, type PaneHeaderLineSegment } from '@/components/appShell/panes/PaneHeader';
import { useClaimedStackHeaderActions, useLentHeaderMenuRows } from '@/components/navigation/stackHeaderActions';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { DETAILS_TAB_HEADER_METRICS } from './detailsTabHeaderMetrics';
import { PhoneDetailsStartContext } from '../PhoneDetailsStartSheet';
import { PaneHeaderShade } from '@/components/appShell/panes/paneHeaderScroll';
import { resolvePaneHeaderColumnMaxWidthPx } from '@/components/appShell/panes/paneHeaderColumn';

/**
 * True while an entity header's actions (`actionsFit="compact"`) would leave its title less room than
 * they take: actions with a compact form take it (the "need you" pill becomes its count, rare entries
 * fold into ⋯), so the name stays readable. The header's one fit decision; consumers only read it.
 */
export const DetailsTabHeaderActionsCompactContext = React.createContext(false);

export function useDetailsTabHeaderActionsCompact(): boolean {
    return React.useContext(DetailsTabHeaderActionsCompactContext);
}

/**
 * One fact on the header's live line, in reading order. `strong` is the one noun the line is about
 * (a branch, an author); a `diffStat` reads as one fact (`+4 −2`).
 */
export type DetailsTabHeaderMetaFact =
    | Readonly<{ key: string; kind?: 'text'; text: string; tone?: 'default' | 'muted' | 'strong' | 'mono' | 'failure'; shrink?: boolean; testID?: string;
        /** A glyph leading the fact (the task a conversation hangs off, a lock before who can read it). */
        icon?: IconName;
        /** A glyph-led fact that leads back to its thing (the Session, Doc or task a conversation hangs off). */
        onPress?: () => void;
        accessibilityLabel?: string }>
    | Readonly<{ key: string; kind: 'diffStat'; added: number; removed: number; testID?: string }>;

export type DetailsTabHeaderAction = Readonly<{
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
    /** `primary` is the surface's one filled action (Save, Restore); `default` a quiet bordered one (Stage). */
    tone?: 'primary' | 'default' | 'danger';
    /** A leading glyph in the button's own colour (the File page's bordered "Edit" carries its pencil). */
    iconName?: IconName;
    accessibilityLabel?: string;
    testID?: string;
}>;

export type DetailsTabHeaderProps = Readonly<{
    /** The thing this tab shows, in its own words: the file name, the commit subject, the stash as a place. */
    title: string;
    leading?: React.ReactNode;
    titleControl?: React.ComponentProps<typeof PaneHeader>['titleControl'];
    titleTextStyle?: React.ComponentProps<typeof PaneHeader>['titleTextStyle'];
    meta?: readonly DetailsTabHeaderMetaFact[];
    /** A live status or presence leaf; its own subscription keeps ticking out of the header owner. */
    metaLeading?: React.ReactNode;
    /**
     * `mark`: the leading leaf is a mark (a stack of faces) that the facts follow directly, as a glyph
     * does; `text` (default) is words, joined to the facts by the line's " · ".
     */
    metaLeadingKind?: 'text' | 'mark';
    metaTrailing?: React.ReactNode;
    /** A short paragraph under the header (a commit body, what Restore will do). */
    body?: React.ReactNode;
    /** Quiet controls in the header band (icon toggles), before the buttons. */
    actions?: React.ReactNode;
    /** The surface's actions, in order; at most one is `primary`. */
    buttons?: readonly DetailsTabHeaderAction[];
    /** Rare operations behind `⋯`. */
    menuActions?: readonly PageHeaderMenuAction[];
    /** A domain menu with richer facts (Run details), still placed by this header's phone policy. */
    menu?: React.ReactNode;
    /** Controls that shape the view (Diff | File, Unstaged ▾, a stash switcher), on one thin row under the band. */
    controls?: React.ReactNode;
    /** One line under the header (freshness, the file changed under an edit). */
    notice?: React.ReactNode;
    /** A real fact above the title (a reporting Session's leads). */
    overline?: React.ReactNode;
    /**
     * A phone screen's own navigation band (an entity page pushed on a phone): Back leads a compact band
     * instead of the large in-content title, and `includeTopInset` clears the status bar.
     */
    navigation?: Readonly<{ onBack: () => void; includeTopInset?: boolean; backTestID?: string }>;
    /**
     * `wrap` (default): actions that do not fit beside the title move to a row beneath. `compact`: an entity
     * header's actions stay in the band and take their compact form instead (`DetailsTabHeaderActionsCompactContext`).
     */
    actionsFit?: 'wrap' | 'compact';
    /** The content column under the header (a Session's conversation): the band's contents stand on its edges. */
    columnMaxWidthPx?: number;
    testID?: string;
}>;

function toLineSegments(meta: readonly DetailsTabHeaderMetaFact[] | undefined): PaneHeaderLineSegment[] {
    const segments: PaneHeaderLineSegment[] = [];
    for (const fact of meta ?? []) {
        if (fact.kind === 'diffStat') {
            if (fact.added > 0 || fact.removed === 0) segments.push({ text: `+${fact.added}`, tone: 'added' });
            if (fact.removed > 0) segments.push({ text: `−${fact.removed}`, tone: 'removed' });
            continue;
        }
        const shrink = fact.shrink ? { shrink: true as const } : {};
        segments.push(fact.icon ? { text: fact.text, icon: fact.icon, ...shrink,
            ...(fact.onPress ? { onPress: fact.onPress, testID: fact.testID, ...(fact.accessibilityLabel ? { accessibilityLabel: fact.accessibilityLabel } : {}) } : {}) }
            : fact.tone === 'failure' ? { text: fact.text, failure: true,
                ...(fact.onPress ? { onPress: fact.onPress, testID: fact.testID, ...(fact.accessibilityLabel ? { accessibilityLabel: fact.accessibilityLabel } : {}) } : {}) }
            : fact.tone === 'strong' ? { text: fact.text, emphasis: true, ...shrink }
            : fact.shrink ? { text: fact.text, shrink: true } : fact.text);
    }
    return segments;
}

/**
 * The header of a Details tab: a Details adapter over the one pane header (`PaneHeader`). The band
 * names the thing (title), places it (the live line: path, who, when, how much) and carries what it
 * is for (quiet toggles, the buttons, `⋯`). Only what is Details' own sits beneath it — one thin row of
 * view controls, an optional body, one notice line — so a header never eats the code's height.
 *
 * On a phone the band takes the pane header's large step and the controls stay on their own row; quiet
 * toggles join `⋯` in the band when the header has no controls or buttons for that row.
 */
export const DetailsTabHeader = React.memo(function DetailsTabHeader(props: DetailsTabHeaderProps) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const phone = useSurfaceStateSize() === 'phone';
    const metrics = DETAILS_TAB_HEADER_METRICS[phone ? 'phone' : 'pane'];
    const styles = stylesheet;
    const testID = props.testID ?? 'details-tab-header';
    const columnRootPx = props.columnMaxWidthPx === undefined ? null
        : resolvePaneHeaderColumnMaxWidthPx(props.columnMaxWidthPx) + metrics.paddingStartPx + metrics.paddingEndPx;
    // Everything beneath the band stands on the band's column too.
    const belowColumn = columnRootPx === null || !Number.isFinite(columnRootPx) ? null
        : { alignSelf: 'center' as const, width: '100%' as const, maxWidth: columnRootPx };
    const segments = React.useMemo(() => toLineSegments(props.meta), [props.meta]);

    // The pane's own controls (⤢, close), when the pane showing this tab has no bar of its own.
    // The rows the pane lends with them (a phone group's other pages, pin, close) go in this header's own `⋯`, or in the
    // page's own `menu` when it brings one (that page draws them, `useLentHeaderMenuRows`): never a second `⋯`.
    const paneControls = useClaimedStackHeaderActions({ scopeOnly: true, drawsMenuRows: true });
    // The phone Start sheet is a floating layer: its close sits beside the title (lab flows `askP`),
    // not on a row of its own beneath the band.
    const inStartSheet = React.useContext(PhoneDetailsStartContext) !== null;
    const sheetBand = phone && inStartSheet;
    const stripMenu = useLentHeaderMenuRows();
    // On the navigation plane (a side panel standing on the canvas) the header takes the plane's paint.
    const onNavigationPlane = useContainingGlassSurfaceGroup() === 'sidebar';
    // An entity page's navigation band on a phone stays a band; elsewhere a phone takes the large title.
    const largeTitle = phone && !props.navigation;
    // Entity headers keep their actions beside the title and compact them when room runs short. Their
    // full width is measured only in the full form, so taking the compact form never flips the decision back.
    const [entityFit, setEntityFit] = React.useState({ root: 0, actions: 0 });
    const actionsCompact = props.actionsFit === 'compact' && entityFit.root > 0 && entityFit.actions > 0
        && entityFit.root - metrics.paddingStartPx - metrics.paddingEndPx - entityFit.actions < entityFit.actions;
    // The view controls sit on the facts line while they leave the facts at least as much room as they
    // take; a narrower band would push them over its actions, so they take their own row beneath it.
    const [band, setBand] = React.useState({ root: 0, actions: 0, controls: 0, trailing: 0, trailingMenu: false });
    const measure = (key: 'root' | 'actions' | 'controls') => (event: LayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        setBand((current) => current[key] === width ? current : { ...current, [key]: width });
    };
    // Each button's natural width, kept while it sits in `⋯`, so folding never feeds back into the fit.
    const [buttonWidths, setButtonWidths] = React.useState<Readonly<Record<string, number>>>({});
    const measureButton = (key: string) => (event: LayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        setButtonWidths((current) => current[key] === width ? current : { ...current, [key]: width });
    };
    const buttonList = props.buttons ?? [];
    const keyOf = (button: DetailsTabHeaderAction) => button.testID ?? button.label;
    const buttonsMeasured = buttonList.every((button) => (buttonWidths[keyOf(button)] ?? 0) > 0);
    const sum = (widths: readonly number[], gap: number) => widths.length === 0 ? 0
        : widths.reduce((total, width) => total + width, 0) + gap * (widths.length - 1);
    // The actions at their natural one-row width: the quiet toggles, then every button.
    const actionsWidth = (visible: readonly DetailsTabHeaderAction[], withIcons = true) => sum([
        ...(props.actions && withIcons ? [band.actions] : []),
        ...visible.map((button) => buttonWidths[keyOf(button)] ?? 0),
    ], theme.space.s4);
    const naturalActions = buttonsMeasured ? actionsWidth(buttonList) : 0;
    const rowRoom = band.root - metrics.paddingStartPx - metrics.paddingEndPx;
    // `⋯` and the pane's own controls stay in the band beside the title, so the title never has their room.
    // The trailing group is measured with or without a `⋯`; the fit below counts it explicitly either way.
    const menuSlot = HAPPIER_ICON_BUTTON_SIZE + theme.space.s4;
    const menuForced = props.menu !== undefined || (props.menuActions?.length ?? 0) > 0 || (stripMenu?.length ?? 0) > 0;
    const roomBesideTitle = rowRoom - (band.trailing - (band.trailingMenu ? menuSlot : 0));
    const bandRoom = roomBesideTitle - (menuForced ? menuSlot : 0);
    // The actions keep their place beside the title while they leave it at least as much room as they
    // take, or the whole name when it is shorter; otherwise they would cut the name to a few letters, so they
    // move to the row beneath.
    // A short name needs only its own width (lab ED1: "retry.ts · Editing · Find · Done" on one row).
    const [titleNeed, setTitleNeed] = React.useState(0);
    // The facts line's own width (lab FV1c: "src · Modified · +9 −3"), measured out of flow like the title.
    const [factsNeed, setLineNeed] = React.useState(0);
    // The leading part of the line (the folder crumb, live status) as laid out; it shrinks by its own rule.
    const [leadingWidth, setLeadingWidth] = React.useState(0);
    const measureLeading = (event: LayoutChangeEvent) => {
        const width = Math.ceil(event.nativeEvent.layout.width);
        setLeadingWidth((current) => current === width ? current : width);
    };
    // Words before the facts are joined to them by the line's own " · " (a mark is followed directly).
    const leadingWords = props.metaLeading !== undefined && props.metaLeading !== null && props.metaLeadingKind !== 'mark';
    // The measured line carries the words' join (an empty leading), so only the live leading's own width is added.
    const lineNeed = factsNeed > 0 ? factsNeed + (props.metaLeading ? leadingWidth + (leadingWords ? 0 : theme.space.s4) : 0) : 0;
    // The measured copy carries no ids or presses of its own (the visible line owns them).
    const measureSegments = React.useMemo(() => segments.map((segment) => {
        if (typeof segment === 'string') return segment;
        const { testID: _id, onPress: _press, ...rest } = segment as typeof segment & { testID?: string; onPress?: () => void };
        return rest as PaneHeaderLineSegment;
    }), [segments]);
    const besideFits = (width: number, room: number) => width > 0 && room - width >= (titleNeed > 0 ? Math.min(width, titleNeed) : width);
    // The quieter buttons (first to last; never the last, never a primary) move into `⋯` until the rest `fits`.
    const foldQuietButtons = (fits: (visible: readonly DetailsTabHeaderAction[]) => boolean): ReadonlySet<string> => {
        const folded = new Set<string>();
        const visible = () => buttonList.filter((button) => !folded.has(keyOf(button)));
        for (const button of buttonList.slice(0, -1)) {
            if (fits(visible())) break;
            if (button.tone !== 'primary') folded.add(keyOf(button));
        }
        return folded;
    };
    // Beneath the band the view controls and the actions share one row, and the quieter buttons fold into `⋯`
    // until it fits. When even the buttons that stay (the last, and a primary) would still break that row in two,
    // a button alone on a row of its own reads as an afterthought: the staying buttons keep their place beside
    // the title instead, and the quiet toggles and the other buttons wait in `⋯`.
    const foldedRoom = roomBesideTitle - menuSlot;
    const controlsWidth = props.controls ? band.controls + theme.space.s6 : 0;
    const foldedAll = foldQuietButtons(() => false);
    const rowBelowHoldsStaying = controlsWidth + actionsWidth(buttonList.filter((button) => !foldedAll.has(keyOf(button))), false) <= rowRoom;
    const besideFolded = !phone && band.root > 0 && props.menu === undefined && Boolean(props.actions) && band.actions > 0
        && buttonsMeasured && !besideFits(naturalActions, bandRoom) && !rowBelowHoldsStaying
        ? foldQuietButtons((visible) => besideFits(actionsWidth(visible, false), foldedRoom)) : null;
    const besideWidth = besideFolded ? actionsWidth(buttonList.filter((button) => !besideFolded.has(keyOf(button))), false) : 0;
    const togglesFoldBesideTitle = besideFolded !== null && besideFits(besideWidth, foldedRoom);
    const lineRoom = togglesFoldBesideTitle ? foldedRoom - besideWidth : bandRoom - naturalActions;
    // The buttons that never fold (the last, a primary) and the toggles, beside the name, against the facts line: when
    // even they would cut it (Edit: View | Changes, Editing, Find, Done in a ~600 px drawer, "· 9 problems" dropped),
    // the actions take the row beneath whole and the line keeps the band (H-T3).
    const stayingButtons = buttonList.filter((button, index) => index === buttonList.length - 1 || button.tone === 'primary');
    const lineCutBeside = !phone && lineNeed > 0 && buttonsMeasured && band.root > 0 && props.menu === undefined
        && roomBesideTitle - menuSlot - actionsWidth(stayingButtons) - theme.space.s4 - controlsWidth < lineNeed;
    const actionsBelow = !phone && band.root > 0 && naturalActions > 0
        && ((!besideFits(naturalActions, bandRoom) && !togglesFoldBesideTitle) || lineCutBeside);
    const controlsBelow = !phone && Boolean(props.controls) && band.root > 0 && (actionsBelow || lineRoom < band.controls * 2);
    // Beneath the band the one row folds the same way, and when it still runs out the quiet toggles follow into `⋯`,
    // so the row never breaks in two.
    const actionsInRow = phone || actionsBelow;
    let folded: ReadonlySet<string> = togglesFoldBesideTitle ? besideFolded! : new Set<string>();
    let iconsFolded = togglesFoldBesideTitle;
    if (actionsInRow && buttonsMeasured && band.root > 0 && props.menu === undefined) {
        const rowFits = (visible: readonly DetailsTabHeaderAction[]) => controlsWidth + actionsWidth(visible) <= rowRoom;
        folded = foldQuietButtons(rowFits);
        iconsFolded = Boolean(props.actions) && band.actions > 0
            && !rowFits(buttonList.filter((button) => !folded.has(keyOf(button))));
    }
    // Beside the title the facts line shares the room the actions leave: a fact that does not fit drops
    // whole ("+9 −3" lost in a 600 px pane). Before cutting the line, the quieter buttons wait in `⋯`.
    const controlsOnLine = Boolean(props.controls) && !controlsBelow;
    if (!phone && !actionsBelow && lineNeed > 0 && buttonsMeasured && band.root > 0 && props.menu === undefined) {
        const lineFits = (visible: readonly DetailsTabHeaderAction[]) => {
            const withMenu = menuForced || visible.length < buttonList.length || iconsFolded;
            const room = roomBesideTitle - (withMenu ? menuSlot : 0) - actionsWidth(visible, !iconsFolded) - theme.space.s4;
            return room - (controlsOnLine ? controlsWidth : 0) >= lineNeed;
        };
        const already = folded;
        const visible = () => buttonList.filter((button) => !already.has(keyOf(button)));
        if (!lineFits(visible())) {
            const lineFolded = new Set(already);
            for (const button of buttonList.slice(0, -1)) {
                if (lineFits(buttonList.filter((entry) => !lineFolded.has(keyOf(entry))))) break;
                if (button.tone !== 'primary') lineFolded.add(keyOf(button));
            }
            folded = lineFolded;
        }
    }
    // A phone row beneath the band holding only quiet buttons reads as an afterthought and costs the content
    // a band of height: they wait in `⋯` instead (lab FV1p). A primary, view controls or toggles keep the row.
    const phoneQuietButtonsAlone = phone && props.menu === undefined && !props.controls && !props.actions && !paneControls
        && buttonList.length > 0 && buttonList.every((button) => button.tone !== 'primary');
    if (phoneQuietButtonsAlone) folded = new Set(buttonList.map(keyOf));
    // An entity header's few buttons (an inline rename's Cancel and Save) never fold.
    if (props.actionsFit === 'compact') folded = new Set<string>();
    const visibleButtons = buttonList.filter((button) => !folded.has(keyOf(button)));
    const buttons = visibleButtons.length > 0 ? visibleButtons.map((button) => {
        const key = keyOf(button);
        return (
            <View key={key} style={styles.measured} onLayout={measureButton(key)}>
                <ToolbarButton
                    testID={button.testID}
                    label={button.label}
                    accessibilityLabel={button.accessibilityLabel}
                    onPress={button.disabled || button.busy ? undefined : button.onPress}
                    disabled={button.disabled || button.busy}
                    busy={button.busy}
                    tone={button.tone ?? 'default'}
                    size={phone ? 'md' : 'sm'}
                    icon={button.iconName ? <Icon name={button.iconName} size={ICON_SIZE.sm}
                        color={button.tone === 'primary' ? theme.colors.button.primary.tint : theme.colors.text.primary} /> : undefined}
                />
            </View>
        );
    }) : null;
    const foldedActions: PageHeaderMenuAction[] = buttonList.filter((button) => folded.has(keyOf(button))).map((button) => ({
        id: `button:${keyOf(button)}`,
        title: button.label,
        ...(button.testID ? { testID: button.testID } : {}),
        ...(button.disabled ? { disabled: true } : {}),
        ...(button.busy ? { loading: true } : {}),
        onSelect: button.onPress,
    }));
    // The tab's own rows (pin, close) come last, after what the page does: the strip gave them to this header.
    const menuActions = [...foldedActions, ...(props.menuActions ?? []), ...(stripMenu ?? [])];
    const menu = props.menu ?? (menuActions.length > 0 || iconsFolded ? (
        <PageHeaderMenu testID={`${testID}.menu`} actions={menuActions}
            content={iconsFolded ? <View testID={`${testID}.foldedIcons`} style={styles.foldedIcons}>{props.actions}</View> : undefined} />
    ) : null);
    // Whether the measured group held a `⋯` is read from the render that drew it, so the fit never double counts it.
    const measureTrailing = (event: LayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        const trailingMenu = menu !== null && menu !== undefined;
        setBand((current) => current.trailing === width && current.trailingMenu === trailingMenu ? current : { ...current, trailing: width, trailingMenu });
    };
    const controls = props.controls ? (
        <View testID={`${testID}.controls`} style={styles.controlsMeasure} onLayout={measure('controls')}>{props.controls}</View>
    ) : null;
    // The quiet toggles, measured at their natural width wherever they sit.
    const iconActions = props.actions && !iconsFolded ? (
        <View testID={`${testID}.icons`} style={styles.measured} onLayout={measure('actions')}>{props.actions}</View>
    ) : null;
    // A phone recomposes: only `⋯` stays beside the title; the toggles and buttons move beneath it.
    const wideActions = iconActions || buttons ? (
        <View testID={`${testID}.actions`} style={actionsBelow ? [styles.bandActions, styles.actionsWrap] : styles.bandActions}>
            {iconActions}
            {buttons}
        </View>
    ) : null;
    // A phone keeps quiet toggles beside `⋯` when they are all the header carries: a row beneath the
    // band holding only a toggle or two reads as an afterthought and costs the content a band of height.
    // Only while they leave the name at least as much room as they take (the band's own fit rule): wider band
    // controls (a view segment, a status pill, Find) take the row beneath instead of squeezing the name.
    const phoneIconsFit = band.actions === 0 || rowRoom - menuSlot - band.actions >= band.actions;
    const phoneIconsInBand = phone && Boolean(iconActions) && !props.controls && buttonList.length === 0 && phoneIconsFit;
    const bandActions = phone
        ? (sheetBand && paneControls ? <View style={styles.bandActions}>{phoneIconsInBand ? iconActions : null}{menu}{paneControls}</View>
            : phoneIconsInBand ? <View style={styles.bandActions}>{iconActions}{menu}</View> : (menu ?? undefined))
        : wideActions || menu || paneControls ? (
            <View style={styles.bandActions}>
                {actionsBelow ? null : wideActions}
                {menu || paneControls ? (
                    <View testID={`${testID}.trailing`} style={styles.bandActions} onLayout={measureTrailing}>
                        {menu}
                        {paneControls}
                    </View>
                ) : null}
            </View>
        ) : undefined;
    // An entity header (`actionsFit="compact"`): its actions, then ⋯ and the pane's own controls, stay in the band.
    const entityActions = props.actionsFit === 'compact' && (props.actions || buttons || menu || paneControls) ? (
        <View style={styles.bandActions}>
            {props.actions ? (
                <View testID={`${testID}.actions`} style={styles.measured} onLayout={actionsCompact ? undefined : (event) => {
                    const width = Math.round(event.nativeEvent.layout.width);
                    setEntityFit((current) => current.actions === width ? current : { ...current, actions: width });
                }}>
                    <DetailsTabHeaderActionsCompactContext.Provider value={actionsCompact}>{props.actions}</DetailsTabHeaderActionsCompactContext.Provider>
                </View>
            ) : null}
            {buttons}
            {menu}
            {paneControls}
        </View>
    ) : null;
    const phoneToolbar = props.actionsFit === 'compact' ? (props.controls ? (
        <View style={styles.controls}>{controls}</View>
    ) : null) : phone && (props.controls || (props.actions && !phoneIconsInBand) || buttons || (paneControls && !sheetBand)) ? (
        <View style={styles.controls}>
            {controls}
            <View style={styles.grow} />
            {phoneIconsInBand ? null : iconActions}
            {buttons}
            {sheetBand ? null : paneControls}
        </View>
    ) : controlsBelow || actionsBelow ? (
        <View style={styles.controls}>
            {controlsBelow ? controls : null}
            <View style={styles.grow} />
            {actionsBelow ? wideActions : null}
        </View>
    ) : null;

    // The line at its natural width, out of flow and unseen (the beside-title fit protects it).
    const lineMeasure = !phone && segments.length > 0 ? (
        <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={styles.lineMeasure}
            onLayout={(event) => { const width = Math.ceil(event.nativeEvent.layout.width); setLineNeed((current) => current === width ? current : width); }}
            testID={`${testID}.lineMeasure`}>
            <PaneHeaderLineView line={{ segments: measureSegments, ...(leadingWords ? { leading: <View />, leadingSeparated: true } : {}) }} testID={`${testID}.lineMeasureLine`} />
        </View>
    ) : null;

    return (
        <View testID={`${testID}.root`} onLayout={(event) => {
            // Over a content column the fit is judged in the column's room, not the whole pane's.
            const width = Math.round(columnRootPx === null ? event.nativeEvent.layout.width : Math.min(event.nativeEvent.layout.width, columnRootPx));
            setBand((current) => current.root === width ? current : { ...current, root: width });
            if (props.actionsFit === 'compact') {
                setEntityFit((current) => current.root === width ? current : { ...current, root: width });
            }
        }} style={[styles.root, { backgroundColor: onNavigationPlane ? 'transparent' : materialColor(theme.colors.surface.base, 'transparent') }]}>
            <PaneHeader
                testID={testID}
                title={props.title}
                leading={props.leading}
                titleControl={props.titleControl}
                titleTextStyle={props.titleTextStyle}
                overline={props.overline}
                navigation={props.navigation}
                shade={false}
                titleNumberOfLines={largeTitle ? undefined : 1}
                onTitleNaturalWidth={largeTitle ? undefined : setTitleNeed}
                lineTrailing={props.actionsFit !== 'compact' && !phone && !controlsBelow ? controls : undefined}
                lineEnd={props.metaTrailing}
                line={segments.length > 0 || props.metaLeading ? {
                    segments,
                    leading: props.metaLeading ? <View style={styles.liveFacts} onLayout={phone ? undefined : measureLeading}>
                        {props.metaLeading}
                    </View> : undefined,
                    leadingSeparated: leadingWords,
                } : null}
                actions={props.actionsFit === 'compact' ? entityActions ?? undefined : bandActions}
                size={largeTitle ? 'large' : 'band'}
                columnMaxWidthPx={props.columnMaxWidthPx}
            />
            {props.body || phoneToolbar ? (
                <View style={[styles.below, { paddingLeft: metrics.paddingStartPx, paddingRight: metrics.paddingEndPx }, belowColumn]}>
                    {phoneToolbar}
                    {props.body ? (
                        typeof props.body === 'string'
                            ? <Text testID={`${testID}.body`} style={[styles.body, metrics.body]}>{props.body}</Text>
                            : props.body
                    ) : null}
                </View>
            ) : null}
            {belowColumn && props.notice ? <View style={belowColumn}>{props.notice}</View> : props.notice ?? null}
            {lineMeasure}
            {/* One shade under the whole header stack: band, controls row, body and notice. */}
            <PaneHeaderShade />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    // No hairline under the header: the scroll-linked shade separates it from content beneath (`cshead.H1`).
    // It stands above its body so that shade overlays what scrolls under it.
    root: {
        position: 'relative',
        zIndex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    bandActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    liveFacts: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        gap: theme.space.s4,
    },
    below: {
        gap: theme.space.s4,
        paddingBottom: theme.space.s6,
    },
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    grow: {
        flex: 1,
    },
    actionsWrap: {
        flexWrap: 'wrap',
        flexShrink: 1,
        justifyContent: 'flex-end',
    },
    controlsMeasure: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
    },
    lineMeasure: { position: 'absolute', left: 0, top: 0, opacity: 0, flexDirection: 'row' },
    measured: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        gap: theme.space.s4,
    },
    foldedIcons: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    body: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        maxWidth: 560,
    },
}));
