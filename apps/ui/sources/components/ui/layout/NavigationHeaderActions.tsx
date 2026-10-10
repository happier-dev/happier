import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useNavigation } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';

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
    return { operations, content: hasContent ? content : undefined, openRequested };
}

export type NavigationHeaderAction = Readonly<{
    title: string;
    onPress: () => void | Promise<unknown>;
    disabled?: boolean;
    loading?: boolean;
    testID?: string;
}>;

type HeaderOptionsTarget = Readonly<{ setOptions: (options: Record<string, unknown>) => void }>;

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
}>) {
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
    const foldedActions = React.useMemo(() => foldContextActions(actions), [actions]);
    const primaryKey = primary ? [primary.title, primary.disabled === true, primary.loading === true, primary.testID ?? ''] : null;
    const cancelKey = cancel ? [cancel.title, cancel.disabled === true, cancel.testID ?? ''] : null;
    const key = JSON.stringify([primaryKey, cancelKey]);
    React.useEffect(() => {
        // Outside a navigator (a harness, a detached preview) there is no native header to fill.
        const screen = navigation;
        if ((!primary && !cancel && !actions) || !screen || typeof screen.setOptions !== 'function') return undefined;
        const options: Record<string, unknown> = {};
        if (primary || actions) {
            options.headerRight = () => (
                <View style={stylesheet.actions}>
                    {actions ? <PageHeaderMenu actions={foldedActions.operations} content={foldedActions.content}
                        openRequested={foldedActions.openRequested} testID="page-header-actions" /> : null}
                    {primary ? (
                        <RoundButton
                            testID={primary.testID}
                            size="small"
                            title={primary.title}
                            accessibilityLabel={primary.title}
                            disabled={primary.disabled}
                            loading={primary.loading}
                            action={() => Promise.resolve(primaryRef.current?.onPress())}
                        />
                    ) : null}
                </View>
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
            if (primary || actions) cleared.headerRight = undefined;
            if (cancel) cleared.headerLeft = undefined;
            for (const target of targets) target.setOptions(cleared);
        };
        // `key` carries the structured actions' rendered fields; context nodes keep their own props.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navigation, key, actions, foldedActions]);
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
}>) {
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    // Navigation is read only while there is something to hand over, so a page (or a harness) with
    // nothing for the native header never touches the navigator.
    return chromeShowsTitle && (props.primary || props.cancel || props.actions)
        ? <NavigationHeaderActionsPublisher primary={props.primary} cancel={props.cancel ?? null} actions={props.actions} />
        : null;
});

const NavigationHeaderActionsPublisher = React.memo(function NavigationHeaderActionsPublisher(props: Readonly<{
    primary: NavigationHeaderAction | null;
    cancel: NavigationHeaderAction | null;
    actions?: React.ReactNode;
}>) {
    useNavigationHeaderActions({ enabled: true, primary: props.primary, cancel: props.cancel, actions: props.actions });
    return null;
});

const stylesheet = StyleSheet.create((theme) => ({
    foldedControls: { flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' },
    actions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cancel: {
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    cancelText: {
        ...Typography.default(),
        fontSize: 17,
        color: theme.colors.text.primary,
    },
}));
