import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useClaimSettingsBack } from '@/components/settings/shell/SettingsModalFloatingControls';

/**
 * The head of every page a machine pushes, one anatomy (FA1 #9): the way back named for where it returns, the
 * page's name, an optional quiet aside on the name's line, then what the page says first (its sentence, its
 * freshness). A page opened inside a tab (Storage's Worktrees, Suggestions and kind pages; Guard's Activity) stands
 * under the machine's header and tabs and returns to its tab; a page This machine pushes (Agents, Alerts, Sharing…)
 * stands alone in the same column and returns to the machine. It is never a `PageHeader`: the crumb, the name and
 * the column edge are the same on every one.
 */
/** A page's leading statement in ink, and the quiet clause that finishes it. */
export type MachinePageLead = Readonly<{ statement: string; detail: string | null }>;

export function MachineTabSubHead(props: Readonly<{
    /** Null for a page that could not be read (no name to give): the way back stands alone. */
    title: string | null;
    /** What the page is about, drawn before its name (an owner's mark). */
    mark?: React.ReactNode;
    back: Readonly<{ label: string; onPress: () => void; testID: string }> | null;
    /** A quiet phrase after the name ("everything Happier did on nl2 by itself"); omitted on a phone. */
    aside?: string | null;
    /** The page's one sentence under its name, when it has one. */
    description?: string | null;
    testID?: string;
    /**
     * `tab` (default): under the machine's header and tabs. `page`: the page's own head (a This machine page), so it
     * keeps the page header's top inset; under native chrome (a phone) the shorter one.
     */
    placement?: 'tab' | 'page';
    underNativeChrome?: boolean;
    children?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const back = props.back;
    // Its crumb is the page's one Back: inside Settings the shell's floating back steps aside.
    useClaimSettingsBack(back !== null);
    return (
        <ItemGroup surface="none" header="none" testID={props.testID}
            style={props.placement === 'page' ? (props.underNativeChrome ? styles.pageUnderChrome : styles.page) : undefined}>
            {back ? (
                <HappierPressable testID={back.testID} accessibilityRole="link" accessibilityLabel={back.label}
                    onPress={back.onPress} style={(state) => [styles.back, state.pressed ? styles.backPressed : null]}>
                    {(state) => (
                        <>
                            <Icon name="caret-left" size={14} color={state.hovered ? theme.colors.text.primary : theme.colors.text.secondary} />
                            <Text numberOfLines={1} style={[styles.backText, state.hovered ? { color: theme.colors.text.primary } : null]}>{back.label}</Text>
                        </>
                    )}
                </HappierPressable>
            ) : null}
            {props.title === null ? null : (
                <View style={[styles.titleLine, back ? null : styles.titleLineAlone]}>
                    {props.mark ? <View style={styles.mark}>{props.mark}</View> : null}
                    <Text accessibilityRole="header" style={styles.title}>{props.title}</Text>
                    {props.aside ? <Text style={styles.aside}>{props.aside}</Text> : null}
                </View>
            )}
            {props.description ? <Text style={styles.description}>{props.description}</Text> : null}
            {props.children}
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    back: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s2,
        minHeight: 28,
        marginLeft: -2,
    },
    backPressed: {
        opacity: 0.6,
    },
    backText: {
        ...Typography.default('medium'),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.secondary,
    },
    titleLine: {
        flexDirection: 'row',
        alignItems: 'baseline',
        flexWrap: 'wrap',
        columnGap: theme.space.s12,
        rowGap: theme.space.s2,
        marginTop: theme.space.s4,
    },
    mark: {
        alignSelf: 'center',
        marginRight: -theme.space.s4,
    },
    page: {
        paddingTop: PAGE_LIST_METRICS.pageHeaderPaddingTopPx,
    },
    pageUnderChrome: {
        paddingTop: PAGE_LIST_METRICS.pageHeaderUnderChromePaddingTopPx,
    },
    titleLineAlone: {
        marginTop: 0,
    },
    description: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
        marginTop: theme.space.s4,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('pageTitle'),
        color: theme.colors.text.primary,
    },
    aside: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.secondary,
    },
}));
