import type { IconName } from '@/components/ui/icons/Icon';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useDestinationRouteNavigation as useNavigation } from '@/components/appShell/workspace/destinationInstanceContext';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { readHappierPageOperation } from '@happier-dev/plugin-ui/presentation';

// Context controls can contain an entity's existing overflow (directly, in a View, or
// in a setting anchor). Lift its operations into the navigation overflow instead of
// nesting a second popover whose selection is lost when the outer one dismisses.
function foldContextActions(actions: React.ReactNode) {
    const operations: PageHeaderMenuAction[] = [];
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
    return { operations: ordered, content: hasContent ? content : undefined, openRequested };
}

export type NavigationHeaderAction = Readonly<{
    title: string;
    /** A leading glyph for the in-page button ("+" on a "New …" primary). */
    icon?: IconName;
    onPress: () => void | Promise<unknown>;
    disabled?: boolean;
    loading?: boolean;
    testID?: string;
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
    const primary = input.enabled ? input.primary ?? null : null;
    const cancel = input.enabled ? input.cancel ?? null : null;
    const actions = input.enabled ? input.actions : null;
    const trailing = input.enabled ? input.trailing ?? null : null;
    const foldedActions = React.useMemo(() => foldContextActions(actions), [actions]);
    const primaryKey = primary ? [primary.title, primary.disabled === true, primary.loading === true, primary.testID ?? ''] : null;
    const cancelKey = cancel ? [cancel.title, cancel.disabled === true, cancel.testID ?? ''] : null;
    const key = JSON.stringify([primaryKey, cancelKey]);
    React.useEffect(() => {
        // Outside a navigator (a harness, a detached preview) there is no native header to fill.
        const screen = navigation;
        if ((!primary && !cancel && !actions && !trailing) || !screen || typeof screen.setOptions !== 'function') return undefined;
        const options: Record<string, unknown> = {};
        if (primary || actions || trailing) {
            options.headerRight = () => (
                <RoundButtonSizeScope size="normal"><View style={stylesheet.actions}>
                    {routeContextActions?.actions}
                    {actions ? <PageHeaderMenu actions={foldedActions.operations} content={foldedActions.content}
                        openRequested={foldedActions.openRequested} testID="page-header-actions" /> : null}
                    {primary ? (
                        <RoundButton
                            testID={primary.testID}
                            title={primary.title}
                            accessibilityLabel={primary.title}
                            disabled={primary.disabled}
                            loading={primary.loading}
                            action={() => Promise.resolve(primaryRef.current?.onPress())}
                        />
                    ) : null}
                    {trailing}
                </View></RoundButtonSizeScope>
            );
        }
        if (cancel) {
            options.headerLeft = () => (
                <Pressable
                    testID={cancel.testID}
                    accessibilityRole="button"
                    accessibilityLabel={cancel.title}
                    disabled={cancel.disabled}
                    hitSlop={8}
                    onPress={() => { void cancelRef.current?.onPress(); }}
                    style={stylesheet.cancel}
                >
                    <Text style={stylesheet.cancelText}>{cancel.title}</Text>
                </Pressable>
            );
        }
        const parent = screen.getParent?.();
        const targets: HeaderOptionsTarget[] = parent?.setOptions ? [screen, parent] : [screen];
        for (const target of targets) target.setOptions(options);
        return () => {
            const cleared: Record<string, unknown> = {};
            if (primary || actions || trailing) {
                const retainedActions = routeContextActions?.readCurrentActions();
                cleared.headerRight = retainedActions ? () => retainedActions : undefined;
            }
            if (cancel) cleared.headerLeft = undefined;
            for (const target of targets) target.setOptions(cleared);
        };
        // `key` carries the structured actions' rendered fields; context nodes keep their own props.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navigation, key, actions, foldedActions, routeContextActions, trailing]);
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
}>) {
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    // Navigation is read only while there is something to hand over, so a page (or a harness) with
    // nothing for the native header never touches the navigator.
    return chromeShowsTitle && (props.primary || props.cancel || props.actions || props.trailing)
        ? <NavigationHeaderActionsPublisher primary={props.primary} cancel={props.cancel ?? null} actions={props.actions} trailing={props.trailing} />
        : null;
});

const NavigationHeaderActionsPublisher = React.memo(function NavigationHeaderActionsPublisher(props: Readonly<{
    primary: NavigationHeaderAction | null;
    cancel: NavigationHeaderAction | null;
    actions?: React.ReactNode;
    trailing?: React.ReactNode;
}>) {
    useNavigationHeaderActions({ enabled: true, primary: props.primary, cancel: props.cancel, actions: props.actions, trailing: props.trailing });
    return null;
});

const stylesheet = StyleSheet.create((theme) => ({
    foldedControls: { flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' },
    actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minWidth: 0, maxWidth: '100%' },
    cancel: {
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s6,
    },
    cancelText: {
        ...Typography.variant('label', 'regular'),
        color: theme.colors.text.primary,
    },
}));
