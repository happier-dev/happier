import type { IconName } from '@/components/ui/icons/Icon';
import * as React from 'react';
import { Dimensions, View } from 'react-native';
import { useDestinationRouteNavigation as useNavigation } from '@/components/appShell/workspace/destinationInstanceContext';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { HEADER_ACTIONS_GAP_PX, PageHeaderMenu, PageHeaderStateSwitch, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { readHappierPageOperation } from '@happier-dev/plugin-ui/presentation';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { CLEARED_HEADER_RIGHT, ownChromeHeaderRight } from '@/components/navigation/ownChromeHeaderItems';

/**
 * How a chooser (a header's Machine chip) reads once a phone bar folds it into "⋯": one ordinary row (its glyph and
 * words) and the props that open its own list under the bar's control. The bar keeps that same chooser mounted out of
 * sight, so the row opens the chooser's existing list (a phone sheet) and its own selection applies.
 */
export type HeaderFoldedChooser<Props> = Readonly<{
    id: string;
    title: string;
    icon: IconName;
    testID?: string;
    disabled?: boolean;
    controlledOpen: (open: boolean, onOpenChange: (open: boolean) => void) => Partial<Props>;
}>;

/** A component that folds as a chooser declares `happierHeaderFold(props)`; read only from its element. */
function readHeaderFoldedChooser(node: React.ReactElement): HeaderFoldedChooser<Record<string, unknown>> | null {
    const component = node.type as { happierHeaderFold?: unknown };
    if ((typeof component !== 'function' && typeof component !== 'object') || component === null
        || typeof component.happierHeaderFold !== 'function') return null;
    return (component.happierHeaderFold as (props: unknown) => HeaderFoldedChooser<Record<string, unknown>> | null)(node.props);
}

type FoldedChooser = Readonly<{ element: React.ReactElement; declaration: HeaderFoldedChooser<Record<string, unknown>> }>;

// Context controls can contain an entity's existing overflow (directly, in a View, or
// in a setting anchor). Lift its operations into the navigation overflow instead of
// nesting a second popover whose selection is lost when the outer one dismisses.
function foldContextActions(actions: React.ReactNode, openChooser: (id: string) => void) {
    const operations: PageHeaderMenuAction[] = [];
    // A chooser folds into one ordinary row; the chooser itself stays mounted by the bar to open its own list.
    const choosers: FoldedChooser[] = [];
    // An entity's one state switch ("Enabled") is its state, not an operation: it stays visible on the
    // bar beside the menu instead of hiding in a strip above the menu's rows.
    const barControls: React.ReactElement[] = [];
    let openRequested = false;
    let hasContent = false;
    function retainControls(nodes: React.ReactNode): React.ReactNode {
        return React.Children.map(nodes, node => {
            if (!React.isValidElement(node)) {
                hasContent ||= node !== null && node !== undefined && typeof node !== 'boolean';
                return node;
            }
            if (node.type === PageHeaderMenu) {
                const menu = node as React.ReactElement<React.ComponentProps<typeof PageHeaderMenu>>;
                operations.push(...menu.props.actions);
                openRequested ||= menu.props.openRequested === true;
                return retainControls(menu.props.content);
            }
            const chooser = readHeaderFoldedChooser(node);
            if (chooser) {
                choosers.push({ element: node, declaration: chooser });
                operations.push({
                    id: chooser.id, title: chooser.title, icon: chooser.icon, opensChooser: true,
                    ...(chooser.testID ? { testID: chooser.testID } : {}),
                    ...(chooser.disabled ? { disabled: true } : {}),
                    onSelect: () => openChooser(chooser.id),
                });
                return null;
            }
            if (node.type === PageHeaderStateSwitch) {
                barControls.push(node);
                return null;
            }
            if (node.type === RoundButton) {
                const button = node as React.ReactElement<React.ComponentProps<typeof RoundButton>>;
                const run = button.props.onPress ?? button.props.action;
                if (typeof button.props.title === 'string' && button.props.title.trim() && run) {
                    operations.push({
                        id: button.props.testID ?? button.props.title,
                        title: button.props.title,
                        ...(button.props.testID ? { testID: button.props.testID } : {}),
                        ...(button.props.disabled ? { disabled: true } : {}),
                        ...(button.props.loading ? { loading: true } : {}),
                        ...(button.props.display === 'destructive' ? { destructive: true } : {}),
                        onSelect: async () => { await run(); },
                    });
                    return null;
                }
            }
            const operation = readHappierPageOperation(node);
            if (operation) {
                operations.push({
                    id: operation.id,
                    title: operation.title,
                    ...(operation.testID === undefined ? {} : { testID: operation.testID }),
                    ...(operation.disabled ? { disabled: true } : {}),
                    ...(operation.pending ? { loading: true } : {}),
                    ...(operation.destructive ? { destructive: true } : {}),
                    onSelect: async () => { await operation.onPress(); },
                });
                return null;
            }
            // A page's operations become rows of the one menu (DESIGN-15 R4), never a strip of
            // buttons with a second `⋯` inside it: a toolbar button, a quiet section action, and an
            // entity row's own overflow, flattened in the order the page shows them.
            if (node.type === ToolbarButton) {
                const button = node as React.ReactElement<React.ComponentProps<typeof ToolbarButton>>;
                const onPress = button.props.onPress;
                if (!onPress) {
                    hasContent = true;
                    return button;
                }
                operations.push({
                    id: button.props.testID ?? button.props.label,
                    title: button.props.label,
                    ...(button.props.testID ? { testID: button.props.testID } : {}),
                    ...(button.props.disabled ? { disabled: true } : {}),
                    ...(button.props.busy ? { loading: true } : {}),
                    ...(button.props.tone === 'danger' || button.props.destructive === true ? { destructive: true } : {}),
                    ...(button.props.active === undefined ? {} : { checked: button.props.active }),
                    onSelect: () => onPress(),
                });
                return null;
            }
            if (node.type === SectionActionButton) {
                const button = node as React.ReactElement<React.ComponentProps<typeof SectionActionButton>>;
                operations.push({
                    id: button.props.testID ?? button.props.title,
                    // The row says what the button says; an accessible name describes the mechanism
                    // for assistive technology and is not visible copy (DESIGN-16 D7).
                    title: button.props.title,
                    ...(button.props.testID ? { testID: button.props.testID } : {}),
                    ...(button.props.disabled ? { disabled: true } : {}),
                    ...(button.props.loading ? { loading: true } : {}),
                    onSelect: () => button.props.onPress(),
                });
                return null;
            }
            if (node.type === ItemRowActions) {
                const menu = node as React.ReactElement<React.ComponentProps<typeof ItemRowActions>>;
                for (const action of menu.props.actions) {
                    const onPress = action.onPress;
                    if (!onPress) continue;
                    operations.push({
                        id: action.id,
                        title: action.title,
                        testID: action.inlineTestID ?? action.id,
                        ...(action.disabled ? { disabled: true } : {}),
                        ...(action.destructive ? { destructive: true } : {}),
                        ...(action.selected === undefined ? {} : { checked: action.selected }),
                        onSelect: () => onPress(),
                    });
                }
                return null;
            }
            const element = node as React.ReactElement<{ children?: React.ReactNode; style?: React.ComponentProps<typeof View>['style'] }>;
            if (element.props.children === undefined) {
                hasContent = true;
                return node;
            }
            // Page actions arrive in desktop rows. Recompose those layout groups within
            // the popup's available width while retaining the controls and their state.
            return React.cloneElement(element, element.type === View
                ? { style: [element.props.style, stylesheet.foldedControls] }
                : undefined, retainControls(element.props.children));
        });
    }
    const content = retainControls(actions);
    // Destructive operations close the menu, whatever order the page drew them in.
    const ordered = [...operations.filter(operation => !operation.destructive), ...operations.filter(operation => operation.destructive)];
    return { operations: ordered, content: hasContent ? content : undefined, openRequested, barControls, choosers };
}

export type NavigationHeaderAction = Readonly<{
    title: string;
    /** A leading glyph for the in-page button ("+" on a "New …" primary). */
    icon?: IconName;
    onPress: () => void | Promise<unknown>;
    disabled?: boolean;
    /** Why a disabled action can't run now: the button's own reason, announced with it and shown on hover, focus or press. */
    disabledReason?: string;
    /** What the action does, for assistive technology (passed to the button as is). */
    accessibilityHint?: string;
    loading?: boolean;
    testID?: string;
    preserveFocusOnPress?: boolean;
    /** A quiet main action (`PageHeaderPrimaryAction.presentation`): the header draws it as secondary too. */
    presentation?: 'secondary';
}>;

type HeaderOptionsTarget = Readonly<{ setOptions: (options: Record<string, unknown>) => void }>;

type PageNavigationContextActionsValue = Readonly<{ actions: React.ReactNode; readCurrentActions: () => React.ReactNode }>;
const PageNavigationContextActions = React.createContext<PageNavigationContextActionsValue | null>(null);

/** Route context stays visible beside a page's phone actions, rather than being overwritten by them. */
export function PageNavigationContextActionsProvider(props: Readonly<{ actions: React.ReactNode; children: React.ReactNode }>) {
    const actionsRef = React.useRef(props.actions);
    actionsRef.current = props.actions;
    const mountedRef = React.useRef(true);
    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    const readCurrentActions = React.useCallback(() => mountedRef.current ? actionsRef.current : null, []);
    const value = React.useMemo(() => ({ actions: props.actions, readCurrentActions }), [props.actions, readCurrentActions]);
    return <PageNavigationContextActions.Provider value={value}>{props.children}</PageNavigationContextActions.Provider>;
}

/**
 * The one publisher of a page's actions into its navigation header. While `enabled`, context actions
 * fold into overflow, the primary stays on its trailing side and Cancel replaces its back; all leave
 * when the page leaves or stops handing them over.
 *
 * A settings collection's detail stack hides its own header and shows its parent's (the collection
 * layout drives that header), so the options go to this screen and to its parent; a hidden header
 * ignores them. The latest `onPress` is read through a ref, so a new callback identity does not
 * re-publish the header on every render.
 */
export function useNavigationHeaderActions(input: Readonly<{
    enabled: boolean;
    primary: NavigationHeaderAction | null | undefined;
    cancel?: NavigationHeaderAction | null;
    actions?: React.ReactNode;
    /**
     * A page's own menu trigger (a list's "+" that opens its add menu), kept as it is at the bar's
     * trailing edge after the folded menu. Pass a stable element: a new one re-publishes the bar.
     */
    trailing?: React.ReactNode;
    /**
     * The bar is too narrow to draw the primary whole (a phone at large text): it is not clipped there,
     * and the page that owns it takes it back (`PageHeader` draws it under its title instead).
     */
    onPrimaryDoesNotFit?: () => void;
}>) {
    const routeContextActions = React.useContext(PageNavigationContextActions);
    const navigation = useNavigation() as unknown as
        | (HeaderOptionsTarget & { getParent?: () => HeaderOptionsTarget | undefined })
        | null
        | undefined;
    const primaryRef = React.useRef(input.primary);
    primaryRef.current = input.primary;
    const cancelRef = React.useRef(input.cancel);
    cancelRef.current = input.cancel;
    const primaryDoesNotFitRef = React.useRef(input.onPrimaryDoesNotFit);
    primaryDoesNotFitRef.current = input.onPrimaryDoesNotFit;
    const primary = input.enabled ? input.primary ?? null : null;
    const cancel = input.enabled ? input.cancel ?? null : null;
    const actions = input.enabled ? input.actions : null;
    const trailing = input.enabled ? input.trailing ?? null : null;
    // The folded chooser whose own list is open (its row was chosen in "⋯"), if any.
    const [openChooserId, setOpenChooserId] = React.useState<string | null>(null);
    const foldedActions = React.useMemo(() => foldContextActions(actions, setOpenChooserId), [actions]);
    // A bar too narrow for everything gives up its own controls (a state switch) to "⋯" first, and its primary only
    // after that; "⋯" itself is never cut. Folded controls return when the window grows past where they did not fit.
    const [barControlsFoldedAt, setBarControlsFoldedAt] = React.useState<number | null>(null);
    React.useEffect(() => {
        if (barControlsFoldedAt === null) return undefined;
        const subscription = Dimensions.addEventListener('change', ({ window }) => {
            if (window.width > barControlsFoldedAt) setBarControlsFoldedAt(null);
        });
        return () => subscription.remove();
    }, [barControlsFoldedAt]);
    const barControlsFolded = barControlsFoldedAt !== null;
    const overflowRef = React.useRef<() => void>(undefined);
    overflowRef.current = () => {
        if (foldedActions.barControls.length > 0 && !barControlsFolded) setBarControlsFoldedAt(Dimensions.get('window').width);
        else primaryDoesNotFitRef.current?.();
    };
    const primaryKey = primary ? [primary.title, primary.disabled === true, primary.loading === true, primary.testID ?? '',
        primary.presentation ?? '', primary.preserveFocusOnPress === true] : null;
    const cancelKey = cancel ? [cancel.title, cancel.disabled === true, cancel.testID ?? ''] : null;
    const key = JSON.stringify([primaryKey, cancelKey]);
    React.useEffect(() => {
        // Outside a navigator (a harness, a detached preview) there is no native header to fill.
        const screen = navigation;
        if ((!primary && !cancel && !actions && !trailing) || !screen || typeof screen.setOptions !== 'function') return undefined;
        const options: Record<string, unknown> = {};
        const menuContent = barControlsFolded && foldedActions.barControls.length > 0
            ? <>{foldedActions.barControls}{foldedActions.content}</> : foldedActions.content;
        const menuShown = Boolean(actions) && (foldedActions.operations.length > 0 || menuContent !== undefined);
        if (primary || actions || trailing) {
            // The bar's controls carry their own chrome, so iOS's shared item glass stays off (one chrome).
            Object.assign(options, ownChromeHeaderRight(() => (
                <RoundButtonSizeScope size="normal"><HeaderActionsRow key={barControlsFolded ? 'folded' : 'bar'} onOverflow={overflowRef}>
                    {routeContextActions?.actions}
                    {barControlsFolded ? null : foldedActions.barControls}
                    {/* One order for every header: the bar's controls, the primary, then "⋯" (and a page's own trailing trigger). */}
                    {primary ? (
                        <HeaderFitSlot>
                            <RoundButton
                                testID={primary.testID}
                                title={primary.title}
                                accessibilityLabel={primary.title}
                                disabled={primary.disabled}
                                {...(primary.disabledReason ? { disabledReason: primary.disabledReason } : {})}
                                {...(primary.accessibilityHint ? { accessibilityHint: primary.accessibilityHint } : {})}
                                loading={primary.loading}
                                preserveFocusOnPress={primary.preserveFocusOnPress}
                                {...(primary.presentation === 'secondary' ? { display: 'secondary' as const } : {})}
                                action={() => Promise.resolve(primaryRef.current?.onPress())}
                            />
                        </HeaderFitSlot>
                    ) : null}
                    {foldedActions.choosers.map(({ element, declaration }) => (
                        <View key={declaration.id} style={stylesheet.foldedChooser}>
                            {React.cloneElement(element, declaration.controlledOpen(openChooserId === declaration.id,
                                (open) => { if (!open) setOpenChooserId(current => current === declaration.id ? null : current); }))}
                        </View>
                    ))}
                    {menuShown || trailing ? (
                        <HeaderFitSlot end>
                            {menuShown ? <PageHeaderMenu actions={foldedActions.operations} content={menuContent}
                                openRequested={foldedActions.openRequested} testID="page-header-actions"
                                interactiveTargetGapPx={HEADER_ACTIONS_GAP_PX} /> : null}
                            {trailing}
                        </HeaderFitSlot>
                    ) : null}
                </HeaderActionsRow></RoundButtonSizeScope>
            )));
        }
        if (cancel) {
            options.headerLeft = () => (
                <HappierPressable
                    testID={cancel.testID}
                    accessibilityRole="button"
                    accessibilityLabel={cancel.title}
                    disabled={cancel.disabled}
                    onPress={() => { void cancelRef.current?.onPress(); }}
                    style={stylesheet.cancel}
                >
                    <Text style={stylesheet.cancelText}>{cancel.title}</Text>
                </HappierPressable>
            );
        }
        const parent = screen.getParent?.();
        const targets: HeaderOptionsTarget[] = parent?.setOptions ? [screen, parent] : [screen];
        for (const target of targets) target.setOptions(options);
        return () => {
            const cleared: Record<string, unknown> = {};
            if (primary || actions || trailing) {
                const retainedActions = routeContextActions?.readCurrentActions();
                Object.assign(cleared, retainedActions ? ownChromeHeaderRight(() => retainedActions) : CLEARED_HEADER_RIGHT);
            }
            if (cancel) cleared.headerLeft = undefined;
            for (const target of targets) target.setOptions(cleared);
        };
        // `key` carries the structured actions' rendered fields; context nodes keep their own props.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navigation, key, actions, foldedActions, routeContextActions, trailing, barControlsFolded, openChooserId]);
}

/**
 * Where a page's actions live on a phone. When navigation shows the page title
 * (`useNavigationTitleChromeShowsTitle`), context actions fold into overflow, the primary stays on
 * the header's trailing side and Cancel replaces its back control, instead of stacking large
 * buttons under the purpose line. Prefer `PageHeader`'s `primaryAction`/`cancelAction`, which render
 * this themselves and keep the buttons in the page on wide layouts.
 */
export const NavigationHeaderActions = React.memo(function NavigationHeaderActions(props: Readonly<{
    primary: NavigationHeaderAction | null;
    cancel?: NavigationHeaderAction | null;
    actions?: React.ReactNode;
    /** A menu trigger kept at the bar's trailing edge (see `useNavigationHeaderActions`). */
    trailing?: React.ReactNode;
    /** The bar cannot draw the primary whole (see `useNavigationHeaderActions`). */
    onPrimaryDoesNotFit?: () => void;
}>) {
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    // Navigation is read only while there is something to hand over, so a page (or a harness) with
    // nothing for the native header never touches the navigator.
    return chromeShowsTitle && (props.primary || props.cancel || props.actions || props.trailing)
        ? <NavigationHeaderActionsPublisher primary={props.primary} cancel={props.cancel ?? null} actions={props.actions} trailing={props.trailing}
            onPrimaryDoesNotFit={props.onPrimaryDoesNotFit} />
        : null;
});

const NavigationHeaderActionsPublisher = React.memo(function NavigationHeaderActionsPublisher(props: Readonly<{
    primary: NavigationHeaderAction | null;
    cancel: NavigationHeaderAction | null;
    actions?: React.ReactNode;
    trailing?: React.ReactNode;
    onPrimaryDoesNotFit?: () => void;
}>) {
    useNavigationHeaderActions({ enabled: true, primary: props.primary, cancel: props.cancel, actions: props.actions, trailing: props.trailing,
        onPrimaryDoesNotFit: props.onPrimaryDoesNotFit });
    return null;
});

type FitReport = (slot: 'primary' | 'end', edge: Readonly<{ right: number }>) => void;
const HeaderFitContext = React.createContext<FitReport | null>(null);

/**
 * The bar's action row. It reads where its last control is drawn against its own width: a row that runs past
 * it (the bar holds Back and a title before it) reports the overflow once, and the bar gives up its own
 * controls to "⋯", then its primary to the page that owns it, rather than drawing anything cut off.
 */
function HeaderActionsRow(props: Readonly<{
    onOverflow: React.RefObject<(() => void) | undefined>;
    children: React.ReactNode;
}>) {
    const rowWidthRef = React.useRef<number | null>(null);
    const edgesRef = React.useRef<Partial<Record<'primary' | 'end', number>>>({});
    const reportedRef = React.useRef(false);
    const { onOverflow } = props;
    const check = React.useCallback(() => {
        const rowWidth = rowWidthRef.current;
        const edges = Object.values(edgesRef.current);
        if (reportedRef.current || rowWidth === null || edges.length === 0) return;
        // Sub-pixel rounding is not a cut; a whole pixel is.
        if (Math.max(...edges) - rowWidth < 1) return;
        reportedRef.current = true;
        onOverflow.current?.();
    }, [onOverflow]);
    const report = React.useCallback<FitReport>((slot, edge) => {
        edgesRef.current = { ...edgesRef.current, [slot]: edge.right };
        check();
    }, [check]);
    return (
        <HeaderFitContext.Provider value={report}>
            <View style={stylesheet.actions} onLayout={(event) => {
                rowWidthRef.current = event.nativeEvent.layout.width;
                check();
            }}>
                {props.children}
            </View>
        </HeaderFitContext.Provider>
    );
}

/** Holds the primary (or "⋯" with the bar's trailing trigger, `end`) at its own width and reports its trailing edge. */
function HeaderFitSlot(props: Readonly<{ end?: boolean; children: React.ReactNode }>) {
    const report = React.useContext(HeaderFitContext);
    return (
        <View style={props.end ? stylesheet.end : stylesheet.primary} onLayout={(event) => {
            const { x, width } = event.nativeEvent.layout;
            report?.(props.end ? 'end' : 'primary', { right: x + width });
        }}>
            {props.children}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    foldedControls: { flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' },
    actions: { flexDirection: 'row', alignItems: 'center', gap: HEADER_ACTIONS_GAP_PX, minWidth: 0, maxWidth: '100%' },
    primary: { flexShrink: 0 },
    end: { flexDirection: 'row', alignItems: 'center', gap: HEADER_ACTIONS_GAP_PX, flexShrink: 0 },
    // A folded chooser stays mounted only to open its own list from its row; it takes no room and draws nothing.
    foldedChooser: { position: 'absolute', width: 0, height: 0, overflow: 'hidden', opacity: 0 },
    cancel: {
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s6,
    },
    cancelText: {
        ...Typography.variant('label', 'regular'),
        color: theme.colors.text.primary,
    },
}));
