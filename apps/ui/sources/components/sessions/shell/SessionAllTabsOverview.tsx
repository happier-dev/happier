import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { Icon } from '@/components/ui/icons/Icon';
import type { SessionSwitcherRow } from '@/components/navigation/mobile/chrome/lateralSwipe/sessionSwitcherRows';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { Text } from '@/components/ui/text/Text';
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
        backgroundColor: theme.colors.background.canvas,
    },
    pageHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 8,
    },
    pageTitle: {
        ...Typography.default('semiBold'),
        fontSize: 28,
        lineHeight: 34,
        color: theme.colors.text.primary,
    },
    done: {
        minHeight: 44,
        minWidth: 44,
        alignItems: 'flex-end',
        justifyContent: 'center',
    },
    doneText: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        color: theme.colors.text.link,
    },
    scroll: {
        flexGrow: 0,
    },
    body: {
        paddingHorizontal: 12,
        paddingBottom: 16,
        gap: 12,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        paddingHorizontal: 4,
        paddingTop: 4,
    },
    grid: {
        gap: 12,
    },
    gridRow: {
        flexDirection: 'row',
        gap: 12,
    },
    cell: {
        flex: 1,
        minWidth: 0,
    },
    card: {
        flex: 1,
        minHeight: CARD_MIN_HEIGHT,
        borderRadius: 18,
        padding: 12,
        gap: 6,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    cardCompact: {
        minHeight: COMPACT_CARD_MIN_HEIGHT,
        gap: 4,
    },
    cardCurrent: {
        borderWidth: 2,
        borderColor: theme.colors.accent.blue,
        padding: 11,
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
        gap: 8,
        minWidth: 0,
    },
    cardTitle: {
        ...Typography.default('semiBold'),
        flexShrink: 1,
        fontSize: 13.5,
        lineHeight: 18,
        color: theme.colors.text.primary,
    },
    cardExcerpt: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    cardMeta: {
        ...Typography.default(),
        marginTop: 'auto',
        fontSize: 12,
        lineHeight: 16,
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
        paddingHorizontal: 4,
        paddingVertical: 24,
        gap: 4,
    },
    emptyTitle: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text.primary,
    },
    emptyDescription: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
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

export function SessionAllTabsOverviewBody(props: Readonly<{
    sections: readonly SessionAllTabsSection[];
    currentKey: string | null;
    onOpen: (key: string) => void;
}>) {
    const sections = props.sections.filter((section) => section.rows.length > 0);
    return (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.body} testID="session-all-tabs-overview">
            {sections.length === 0 ? (
                <View style={styles.empty}>
                    <Text style={styles.emptyTitle}>{t('phoneNav.allTabs.emptyTitle')}</Text>
                    <Text style={styles.emptyDescription}>{t('phoneNav.allTabs.emptyDescription')}</Text>
                </View>
            ) : sections.map((section) => (
                <View key={section.key} style={{ gap: 8 }}>
                    <Text style={styles.sectionTitle} accessibilityRole="header">{section.title}</Text>
                    {[section.rows.filter((row) => row.target.kind !== 'tab'), section.rows.filter((row) => row.target.kind === 'tab')]
                        .filter((group) => group.length > 0)
                        .map((group) => (
                    <View key={group[0]!.key} style={styles.grid}>
                        {pairs(group).map(([left, right]) => (
                            <View key={left.key} style={styles.gridRow}>
                                <View style={styles.cell}>
                                    <SessionAllTabsCardView row={left} current={isCurrentRow(left, props.currentKey)} onPress={props.onOpen} />
                                </View>
                                {/* An odd last card keeps its column instead of stretching across both. */}
                                <View style={styles.cell}>
                                    {right ? <SessionAllTabsCardView row={right} current={isCurrentRow(right, props.currentKey)} onPress={props.onOpen} /> : null}
                                </View>
                            </View>
                        ))}
                    </View>
                        ))}
                </View>
            ))}
        </ScrollView>
    );
}

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
        <View style={[styles.page, { paddingTop: insets.top, backgroundColor: materialColor(theme.colors.background.canvas, 'transparent') }]} testID="session-all-tabs-page">
            <View style={styles.pageHeader}>
                <Text style={styles.pageTitle} accessibilityRole="header">{t('phoneNav.allTabs.title')}</Text>
                <Pressable style={styles.done} onPress={props.onDone} accessibilityRole="button" hitSlop={8} testID="session-all-tabs-done">
                    <Text style={styles.doneText}>{t('common.done')}</Text>
                </Pressable>
            </View>
            <SessionAllTabsOverviewBody sections={props.sections} currentKey={props.currentKey} onOpen={props.onOpen} />
        </View>
    );
}
