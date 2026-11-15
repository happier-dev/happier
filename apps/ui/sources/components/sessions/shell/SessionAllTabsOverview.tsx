import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { Icon } from '@/components/ui/icons/Icon';
import type { SessionSwitcherRow } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherRows';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { Text } from '@/components/ui/text/Text';
import { VirtualizedList, type VirtualizedListRenderItemInfo } from '@/components/ui/lists/virtualized';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * All tabs (lab round 2b, frame P): the session-title pull's destination. Open tabs (synced) and this
 * phone's recents as cards that show the thing itself — the last thing said — rather than a link to
 * it. Tap one to go there.
 *
 * The cards are a snapshot taken when the page opens, built by the same order owner the switcher
 * uses (`sessionSwitcherOrder`), so the two never disagree about what is open or recent. On a phone it
 * is a full page over the session (`/all-tabs`): a large title, Done, and Back return to the session.
 * A session card shows what was last said; any other tab is a compact card — its name and the one
 * line its owner gives (where it lives, its pane, or why it is unavailable).
 */

export type SessionAllTabsSection = Readonly<{
    key: 'openTabs' | 'recent';
    title: string;
    rows: readonly SessionSwitcherRow[];
}>;

/** Tall enough for a title and a few lines of the last message; a row of two shares one height. */
const CARD_MIN_HEIGHT = 108;
/** A tab that is not a session has no last message: its name and one line. */
const COMPACT_CARD_MIN_HEIGHT = 64;

const styles = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    pageHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s8,
    },
    pageTitle: {
        ...Typography.variant('display'),
        color: theme.colors.text.primary,
    },
    done: {
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    doneText: {
        ...Typography.variant('heading'),
        color: theme.colors.text.link,
    },
    scroll: {
        flex: 1,
    },
    body: {
        paddingHorizontal: theme.space.s12,
        paddingBottom: theme.space.s16,
    },
    sectionTitle: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s4,
        paddingTop: theme.space.s4,
    },
    gridRow: {
        flexDirection: 'row',
        gap: theme.space.s12,
    },
    cell: {
        flex: 1,
        minWidth: 0,
    },
    card: {
        flex: 1,
        minHeight: CARD_MIN_HEIGHT,
        borderRadius: 18,
        padding: theme.space.s12,
        gap: theme.space.s6,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    cardCompact: {
        minHeight: COMPACT_CARD_MIN_HEIGHT,
        gap: theme.space.s4,
    },
    cardCurrent: {
        borderWidth: 2,
        borderColor: theme.colors.accent.blue,
        padding: theme.space.s10,
    },
    cardPressed: {
        opacity: 0.85,
        transform: [{ scale: 0.98 }],
    },
    cardUnavailable: {
        opacity: 0.55,
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minWidth: 0,
    },
    cardTitle: {
        flexShrink: 1,
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    cardExcerpt: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    cardMeta: {
        marginTop: 'auto',
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        opacity: 0.8,
    },
    cardMetaAttention: {
        color: theme.colors.accent.orange,
        opacity: 1,
    },
    cardMetaFailed: {
        color: theme.colors.accent.red,
        opacity: 1,
    },
    empty: {
        paddingHorizontal: theme.space.s4,
        paddingVertical: theme.space.s24,
        gap: theme.space.s4,
    },
    emptyTitle: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
    },
    emptyDescription: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
}));

const MARK_SIZE = 16;

function CardMark(props: Readonly<{ row: SessionSwitcherRow }>) {
    const { theme } = useUnistyles();
    const { row } = props;
    if (row.unavailable) return <Icon name="cloud-slash" size={MARK_SIZE} color={theme.colors.text.secondary} />;
    if (row.target.kind === 'tab') return <Icon name={row.icon ?? 'file'} size={MARK_SIZE} color={theme.colors.text.secondary} />;
    return (
        <SessionAgentCatalogIdentityIcon
            // Unknown identity degrades to the catalog owner's neutral mark.
            agentId={row.agentId ?? ''}
            machineId={row.machineId}
            serverId={row.serverId}
            color={theme.colors.text.primary}
            size={MARK_SIZE}
        />
    );
}

function isCurrentRow(row: SessionSwitcherRow, currentKey: string | null): boolean {
    if (!currentKey || row.target.kind !== 'session') return false;
    return buildServerScopedSessionKey(row.target.sessionId, row.target.serverId) === currentKey;
}

const SessionAllTabsCardView = React.memo(function SessionAllTabsCardView(props: Readonly<{
    row: SessionSwitcherRow;
    current: boolean;
    onPress: (key: string) => void;
}>) {
    const { row, current } = props;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const compact = row.target.kind === 'tab';
    // The thing itself: the unsent draft first (it is the person's own), then the last thing said.
    const excerpt = compact ? null : row.draft ? t('phoneNav.switcher.draft', { text: row.draft }) : row.excerpt;
    const meta = row.status?.text ?? (row.timeLabel || null);
    return (
        <Pressable
            testID={`session-all-tabs-card:${row.key}`}
            accessibilityRole="button"
            accessibilityLabel={t('phoneNav.allTabs.openTab', { title: row.title })}
            accessibilityState={{ selected: current, disabled: row.unavailable }}
            onPress={() => props.onPress(row.key)}
            style={({ pressed }) => [
                styles.card,
                { backgroundColor: materialColor(theme.colors.surface.base) },
                compact ? styles.cardCompact : null,
                current ? styles.cardCurrent : null,
                row.unavailable ? styles.cardUnavailable : null,
                pressed ? styles.cardPressed : null,
            ]}
        >
            <View style={styles.cardHeader}>
                <CardMark row={row} />
                <Text numberOfLines={1} style={styles.cardTitle}>{row.title}</Text>
            </View>
            {excerpt ? <Text numberOfLines={4} style={styles.cardExcerpt}>{excerpt}</Text> : null}
            {meta ? (
                <Text numberOfLines={1} style={[styles.cardMeta, compact ? { marginTop: 0 } : null, row.status?.tone === 'attention' ? styles.cardMetaAttention : null,
                    row.status?.tone === 'failed' ? styles.cardMetaFailed : null]}>
                    {meta}
                </Text>
            ) : null}
        </Pressable>
    );
});

function pairs<T>(items: readonly T[]): Array<readonly [T, T | null]> {
    const result: Array<readonly [T, T | null]> = [];
    for (let index = 0; index < items.length; index += 2) result.push([items[index], items[index + 1] ?? null]);
    return result;
}

/** One list row: a section's title, or a row of two cards (session cards first, then compact tab cards). */
type AllTabsListItem =
    | Readonly<{ kind: 'title'; key: string; title: string; first: boolean }>
    | Readonly<{ kind: 'cards'; key: string; left: SessionSwitcherRow; right: SessionSwitcherRow | null; leadsGroup: boolean }>;

/** A row of two cards is about one card tall plus the grid gap. */
const ESTIMATED_LIST_ROW_HEIGHT = CARD_MIN_HEIGHT + 12;

function buildAllTabsListItems(sections: readonly SessionAllTabsSection[]): readonly AllTabsListItem[] {
    const items: AllTabsListItem[] = [];
    for (const section of sections) {
        if (section.rows.length === 0) continue;
        items.push({ kind: 'title', key: `title:${section.key}`, title: section.title, first: items.length === 0 });
        for (const group of [section.rows.filter((row) => row.target.kind !== 'tab'), section.rows.filter((row) => row.target.kind === 'tab')]) {
            pairs(group).forEach(([left, right], index) => items.push({ kind: 'cards', key: left.key, left, right, leadsGroup: index === 0 }));
        }
    }
    return items;
}

/**
 * The cards scroll in the canonical virtualized list: a person can keep hundreds of tabs open, and only the
 * rows near the viewport are built. The spacing is the page's own: a section's title sits a grid gap below
 * the section before it, the first row of each group sits closer under its title.
 */
export function SessionAllTabsOverviewBody(props: Readonly<{
    sections: readonly SessionAllTabsSection[];
    currentKey: string | null;
    onOpen: (key: string) => void;
}>) {
    const { theme } = useUnistyles();
    const items = React.useMemo(() => buildAllTabsListItems(props.sections), [props.sections]);
    const { currentKey, onOpen } = props;
    const renderItem = React.useCallback(({ item }: VirtualizedListRenderItemInfo<AllTabsListItem>) => item.kind === 'title' ? (
        <Text style={[styles.sectionTitle, item.first ? null : { marginTop: theme.space.s12 }]} accessibilityRole="header">{item.title}</Text>
    ) : (
        <View style={[styles.gridRow, { paddingTop: item.leadsGroup ? theme.space.s8 : theme.space.s12 }]}>
            <View style={styles.cell}>
                <SessionAllTabsCardView row={item.left} current={isCurrentRow(item.left, currentKey)} onPress={onOpen} />
            </View>
            {/* An odd last card keeps its column instead of stretching across both. */}
            <View style={styles.cell}>
                {item.right ? <SessionAllTabsCardView row={item.right} current={isCurrentRow(item.right, currentKey)} onPress={onOpen} /> : null}
            </View>
        </View>
    ), [currentKey, onOpen, theme.space.s12, theme.space.s8]);
    return (
        <VirtualizedList
            testID="session-all-tabs-overview"
            style={styles.scroll}
            contentContainerStyle={styles.body}
            data={items}
            keyExtractor={allTabsListItemKey}
            renderItem={renderItem}
            extraData={currentKey}
            estimatedItemSize={ESTIMATED_LIST_ROW_HEIGHT}
            ListEmptyComponent={(
                <View style={styles.empty}>
                    <Text style={styles.emptyTitle}>{t('phoneNav.allTabs.emptyTitle')}</Text>
                    <Text style={styles.emptyDescription}>{t('phoneNav.allTabs.emptyDescription')}</Text>
                </View>
            )}
        />
    );
}

function allTabsListItemKey(item: AllTabsListItem): string { return item.key; }

/** The All tabs page: a large title with Done, then the cards. Rendered by the `/all-tabs` route. */
export function SessionAllTabsPageView(props: Readonly<{
    sections: readonly SessionAllTabsSection[];
    currentKey: string | null;
    onOpen: (key: string) => void;
    onDone: () => void;
}>) {
    const insets = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    return (
        <View style={[styles.page, { paddingTop: insets.top, backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]} testID="session-all-tabs-page">
            <View style={styles.pageHeader}>
                <Text style={styles.pageTitle} accessibilityRole="header">{t('phoneNav.allTabs.title')}</Text>
                <HappierPressable style={styles.done} onPress={props.onDone} accessibilityRole="button" testID="session-all-tabs-done">
                    <Text style={styles.doneText}>{t('common.done')}</Text>
                </HappierPressable>
            </View>
            <SessionAllTabsOverviewBody sections={props.sections} currentKey={props.currentKey} onOpen={props.onOpen} />
        </View>
    );
}
