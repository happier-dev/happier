import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPageSectionContext, HappierPressable, happierPageTextMetrics, type HappierPageSection } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { LeadSentence, type LeadSentenceContent } from '@/components/ui/text/LeadSentence';
import { Typography } from '@/constants/Typography';
import { useClaimSettingsBack } from '@/components/settings/shell/SettingsModalFloatingControls';
import { useNavigationChromeShowsBack } from '@/components/ui/layout/navigationTitleChrome';

/**
 * The head of every page a machine pushes, one anatomy (FA1 #9): the way back named for where it returns, the
 * page's name, an optional quiet aside on the name's line, then what the page says first (its sentence, its
 * freshness). A page opened inside a tab (Storage's Worktrees, Suggestions and kind pages; Guard's Activity) stands
 * under the machine's header and tabs and returns to its tab; a page This machine pushes (Agents, Alerts, Sharing…)
 * stands alone in the same column and returns to the machine. It is never a `PageHeader`: the crumb, the name and
 * the column edge are the same on every one.
 */
/** A page's leading statement in ink, and the quiet clause that finishes it. */
export type MachinePageLead = LeadSentenceContent;

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
    /**
     * What the page states first, from its own facts (lab `mc-acsay`: "shop-prod is open to the internet on 22, 80
     * and 443." then a quiet clause), in place of a purpose sentence once the facts can say it.
     */
    lead?: MachinePageLead | null;
    /** A freshness line under the name ("devbox is offline · Retry"), before the lead it qualifies. */
    notice?: React.ReactNode;
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
    // One Back per page: under a phone bar that already draws one (in-app history), the crumb steps aside, as a
    // PageHeader's does; a deep link without history keeps it.
    const chromeShowsBack = useNavigationChromeShowsBack();
    const back = props.underNativeChrome && chromeShowsBack ? null : props.back;
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
            {/* A page's own head names the page (level 1); under the machine's header and tabs it heads a section. */}
            {props.title === null ? null : (
                <View style={[styles.titleLine, back ? null : styles.titleLineAlone]}>
                    {props.mark ? <View style={styles.mark}>{props.mark}</View> : null}
                    <Text accessibilityRole="header" aria-level={props.placement === 'page' ? 1 : 2} style={styles.title}>{props.title}</Text>
                    {props.aside ? <Text style={styles.aside}>{props.aside}</Text> : null}
                </View>
            )}
            {/* The notice spans the column the sections' sheets stand in (lab scene 1 `offline`): it is the page's own
                line, not a row inside a list, so it takes the sheets' edge rather than a list's tool inset. */}
            {props.notice ? <HappierPageSectionContext.Provider value={NOTICE_ON_SHEET_EDGE}>{props.notice}</HappierPageSectionContext.Provider> : null}
            {props.description ? <Text style={styles.description}>{props.description}</Text> : null}
            {props.lead ? (
                <LeadSentence testID={props.testID ? `${props.testID}-lead` : undefined} style={styles.lead}
                    statement={props.lead.statement} detail={props.lead.detail} />
            ) : null}
            {props.children}
        </ItemGroup>
    );
}

/** A head's notice stands on the sheets' edge: no row inset of its own. */
const NOTICE_ON_SHEET_EDGE: HappierPageSection = { rowDividerColor: 'transparent', rowInsetPx: 0 };

const styles = StyleSheet.create((theme) => ({
    back: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        maxWidth: '100%',
        gap: theme.space.s2,
        minHeight: 28,
        marginLeft: -2,
    },
    backPressed: {
        opacity: 0.6,
    },
    backText: {
        // One line that ends in an ellipsis: a long Machine name shrinks inside the crumb instead of running off a phone.
        flexShrink: 1,
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
    lead: {
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
