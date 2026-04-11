import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';

import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { useWebScrollLockBypass } from '@/components/ui/scroll/useWebScrollLockBypass';
import { resolveWebScrollableElementWithin } from '@/components/ui/scroll/resolveWebScrollableElement';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PinIcon, PinSlashIcon } from '@/components/sessions/shell/sessionPinIcons';
import { t } from '@/text';
import type { DetailsTabState } from '@/components/appShell/panes/model/appPaneReducer';

export type PaneDetailsTabsPanelTestIds = Readonly<{
    root?: string;
    tab?: (tabKey: string) => string | null | undefined;
    tabPin?: (tabKey: string) => string | null | undefined;
    tabUnpin?: (tabKey: string) => string | null | undefined;
    tabClose?: (tabKey: string) => string | null | undefined;
}>;

export type PaneDetailsTabsPanelProps = Readonly<{
    pane: AppPaneScopeApi;
    paddingTop?: number;
    headerPaddingTop?: number;
    forceEmptyState?: boolean;
    testIds?: PaneDetailsTabsPanelTestIds;
    resolveTabIconName?: ((tab: DetailsTabState) => string | null | undefined) | null;
    renderTabContent: (tab: DetailsTabState) => React.ReactNode;
    renderHeaderActions?: (() => React.ReactNode) | null;
    renderEmptyState?: (() => React.ReactNode) | null;
}>;

type ScrollPropagationEvent = Readonly<{ stopPropagation?: () => void }>;

const ViewWithWheel = View as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & { onWheel?: (event: unknown) => void; onTouchMove?: (event: unknown) => void }
>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        minHeight: 0,
        minWidth: 0,
    },
    header: {
        paddingHorizontal: 10,
        paddingTop: 10,
        paddingBottom: 8,
        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    tabsScroll: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    tab: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        paddingRight: 52,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        maxWidth: 220,
    },
    tabActive: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    tabLabel: {
        flexShrink: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    tabLabelActive: {
        color: theme.colors.text,
    },
    tabCopy: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    tabSubtitle: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    tabActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        gap: 10,
    },
    loadingText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default(),
        textAlign: 'center',
    },
}));

const DetailsTabSurface = React.memo((props: Readonly<{ isActive: boolean; children: React.ReactNode }>) => {
    const rootRef = React.useRef<View | null>(null);
    const scrollSnapshotRef = React.useRef<Array<{ testId: string; top: number; left: number }>>([]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const raw = rootRef.current as unknown;
        const maybeScrollable =
            raw && typeof (raw as { getScrollableNode?: unknown }).getScrollableNode === 'function'
                ? (raw as { getScrollableNode: () => unknown }).getScrollableNode()
                : raw;
        const rootEl = maybeScrollable as HTMLElement | null;
        const win = typeof window !== 'undefined' ? window : null;
        if (!rootEl || !win || typeof win.getComputedStyle !== 'function') return;
        const findScrollableWithin = (host: HTMLElement | null): HTMLElement | null => {
            if (!host) return null;
            return resolveWebScrollableElementWithin(host, { win, pick: 'best', maxDescendants: 600 });
        };

        if (!props.isActive) {
            // Only snapshot scrollables with stable identifiers. Without a `data-testid`, order can
            // change between renders (virtualized lists, diff viewers), and restoring by index can
            // accidentally reset the primary scroll container.
            const dedup = new Map<string, { testId: string; top: number; left: number; score: number }>();
            const hosts = Array.from(rootEl.querySelectorAll<HTMLElement>('[data-testid]'));
            for (const host of hosts) {
                const testId = host.getAttribute('data-testid');
                if (typeof testId !== 'string' || testId.length === 0) continue;
                const target = findScrollableWithin(host);
                if (!target) continue;
                const top = typeof target.scrollTop === 'number' ? target.scrollTop : 0;
                const left = typeof target.scrollLeft === 'number' ? target.scrollLeft : 0;
                const verticalViewport = Math.max(target.clientHeight, 0);
                const verticalOverflow = Math.max(target.scrollHeight - target.clientHeight, 0);
                const horizontalOverflow = Math.max(target.scrollWidth - target.clientWidth, 0);
                const score = verticalViewport * 1_000_000 + verticalOverflow + horizontalOverflow;
                const prev = dedup.get(testId);
                if (!prev || score >= prev.score) {
                    dedup.set(testId, { testId, top, left, score });
                }
            }
            scrollSnapshotRef.current = Array.from(dedup.values()).map(({ testId, top, left }) => ({ testId, top, left }));
            return;
        }

        const snapshot = scrollSnapshotRef.current;
        if (!snapshot || snapshot.length === 0) return;

        for (let i = 0; i < snapshot.length; i += 1) {
            const s = snapshot[i];
            const host = rootEl.querySelector<HTMLElement>(`[data-testid="${s.testId}"]`) ?? null;
            const target = findScrollableWithin(host);
            if (!target) continue;
            if (typeof s.top === 'number') target.scrollTop = s.top;
            if (typeof s.left === 'number') target.scrollLeft = s.left;
        }

        // Some virtualized scroll views (FlashList, diff viewers) can apply post-layout adjustments
        // after tab activation, which can override the first restore write. Re-apply for a short,
        // bounded window so tab switches feel stable and scroll positions don't "jump" when the
        // tab becomes visible.
        const scheduleFrame = (cb: FrameRequestCallback) => {
            if (typeof globalThis.requestAnimationFrame === 'function') {
                globalThis.requestAnimationFrame(cb);
                return;
            }
            globalThis.setTimeout(() => cb(Date.now()), 0);
        };
        const apply = () => {
            for (let i = 0; i < snapshot.length; i += 1) {
                const s = snapshot[i];
                const host = rootEl.querySelector<HTMLElement>(`[data-testid="${s.testId}"]`) ?? null;
                const target = findScrollableWithin(host);
                if (!target) continue;
                if (typeof s.top === 'number') target.scrollTop = s.top;
                if (typeof s.left === 'number') target.scrollLeft = s.left;
            }
        };
        const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
        const maxMs = 200;
        const step = () => {
            apply();
            const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
                ? performance.now()
                : Date.now();
            if (now - startedAt >= maxMs) return;
            scheduleFrame(() => step());
        };
        scheduleFrame(() => step());
    }, [props.isActive]);

    const a11yHiddenProps =
        Platform.OS === 'web'
            ? null
            : {
                accessibilityElementsHidden: !props.isActive,
                importantForAccessibility: props.isActive ? ('auto' as const) : ('no-hide-descendants' as const),
            };

    return (
        <View
            ref={rootRef}
            pointerEvents={props.isActive ? 'auto' : 'none'}
            style={[{ flex: 1, minHeight: 0, minWidth: 0 }, !props.isActive ? { display: 'none' } : null]}
            {...a11yHiddenProps}
        >
            {props.children}
        </View>
    );
});

export const PaneDetailsTabsPanel = React.memo((props: PaneDetailsTabsPanelProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const rootRef = React.useRef<View | null>(null);
    useWebScrollLockBypass({ rootRef, enabled: true });

    const stopScrollEventPropagationOnWeb = React.useCallback((event: unknown) => {
        // Expo Router (Vaul/Radix) overlays on web can install document-level wheel/touchmove listeners
        // that prevent default scrolling. Stopping propagation at the pane root keeps scrolling inside
        // nested scroll views (FlashList/ScrollView) working reliably.
        if (Platform.OS !== 'web') return;
        if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
            (event as ScrollPropagationEvent).stopPropagation?.();
        }
    }, []);

    const details = props.pane.scopeState?.details ?? null;
    const tabs: ReadonlyArray<DetailsTabState> = details?.tabs ?? [];
    const activeKey = details?.activeTabKey ?? null;

    const activeTab = React.useMemo(() => tabs.find((t) => t.key === activeKey) ?? tabs.at(-1) ?? null, [activeKey, tabs]);
    const effectiveActiveKey = activeKey ?? activeTab?.key ?? null;
    const forceEmptyState = props.forceEmptyState === true;

    const renderLoadingFallback = React.useCallback(() => (
        <View style={styles.loading}>
            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            <Text style={styles.loadingText}>{t('common.loading')}</Text>
        </View>
    ), [styles.loading, styles.loadingText, theme.colors.textSecondary]);

    const headerPaddingTop = props.headerPaddingTop ?? 10;

    return (
        <ViewWithWheel
            ref={rootRef}
            testID={props.testIds?.root}
            style={[styles.container, props.paddingTop ? { paddingTop: props.paddingTop } : null]}
            {...(Platform.OS === 'web'
                ? { onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb }
                : {})}
        >
            <View style={[styles.header, { paddingTop: headerPaddingTop }]}>
                {!forceEmptyState ? (
                    <ScrollView horizontal style={styles.tabsScroll} showsHorizontalScrollIndicator={false}>
                        {tabs.map((tab) => {
                            const isActive = effectiveActiveKey ? tab.key === effectiveActiveKey : false;
                            const safeTabKey = toTestIdSafeValue(tab.key);
                            const iconName =
                                props.resolveTabIconName?.(tab)
                                ?? (
                                    tab.kind === 'commit'
                                        ? 'git-commit'
                                        : tab.kind === 'file'
                                            ? 'file'
                                            : tab.kind === 'scmReview'
                                                ? 'diff'
                                                : tab.kind === 'scmStash'
                                                    ? 'archive'
                                                    : tab.kind === 'terminal'
                                                        ? 'terminal'
                                                        : tab.kind === 'executionRunLauncher'
                                                            ? 'play'
                                                            : 'circle'
                                );
                            return (
                                <View
                                    key={tab.key}
                                    style={{
                                        position: 'relative',
                                        marginRight: 8,
                                        maxWidth: 220,
                                        flexShrink: 0,
                                    }}
                                >
                                    <Pressable
                                        onPress={() => props.pane.setActiveDetailsTab(tab.key)}
                                        testID={props.testIds?.tab?.(safeTabKey) ?? undefined}
                                        style={[
                                            styles.tab,
                                            isActive ? styles.tabActive : null,
                                            { paddingRight: tab.isPreview || tab.isPinned ? 52 : 34 },
                                        ]}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('session.detailsPanel.openTabA11y', { title: tab.title })}
                                    >
                                        <Octicons
                                            name={iconName as React.ComponentProps<typeof Octicons>['name']}
                                            size={14}
                                            color={isActive ? theme.colors.textSecondary : theme.colors.textSecondary}
                                        />
                                        <View style={styles.tabCopy}>
                                            <Text
                                                style={[styles.tabLabel, isActive ? styles.tabLabelActive : null]}
                                                numberOfLines={1}
                                            >
                                                {tab.title}
                                            </Text>
                                            {typeof tab.subtitle === 'string' && tab.subtitle.trim().length > 0 ? (
                                                <Text style={styles.tabSubtitle} numberOfLines={1}>
                                                    {tab.subtitle}
                                                </Text>
                                            ) : null}
                                        </View>
                                    </Pressable>
                                    <View
                                        style={[
                                            styles.tabActions,
                                            { position: 'absolute', right: 10, top: 0, bottom: 0, zIndex: 1 },
                                        ]}
                                    >
                                        {tab.isPreview ? (
                                            <Pressable
                                                onPress={(event: unknown) => {
                                                    if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                                        (event as ScrollPropagationEvent).stopPropagation?.();
                                                    }
                                                    props.pane.pinDetailsTab(tab.key);
                                                }}
                                                testID={props.testIds?.tabPin?.(safeTabKey) ?? undefined}
                                                accessibilityRole="button"
                                                accessibilityLabel={t('session.detailsPanel.pinTabA11y')}
                                                hitSlop={10}
                                            >
                                                <PinIcon size={16} color={theme.colors.textSecondary} />
                                            </Pressable>
                                        ) : tab.isPinned ? (
                                            <Pressable
                                                onPress={(event: unknown) => {
                                                    if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                                        (event as ScrollPropagationEvent).stopPropagation?.();
                                                    }
                                                    props.pane.unpinDetailsTab(tab.key);
                                                }}
                                                testID={props.testIds?.tabUnpin?.(safeTabKey) ?? undefined}
                                                accessibilityRole="button"
                                                accessibilityLabel={t('session.detailsPanel.unpinTabA11y')}
                                                hitSlop={10}
                                            >
                                                <PinSlashIcon size={16} color={theme.colors.textSecondary} />
                                            </Pressable>
                                        ) : null}
                                        <Pressable
                                            onPress={(event: unknown) => {
                                                if (event && typeof (event as ScrollPropagationEvent).stopPropagation === 'function') {
                                                    (event as ScrollPropagationEvent).stopPropagation?.();
                                                }
                                                props.pane.closeDetailsTab(tab.key);
                                            }}
                                            testID={props.testIds?.tabClose?.(safeTabKey) ?? undefined}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('session.detailsPanel.closeTabA11y')}
                                            hitSlop={10}
                                        >
                                            <Octicons name="x" size={14} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    </View>
                                </View>
                            );
                        })}
                    </ScrollView>
                ) : (
                    <View style={styles.tabsScroll} />
                )}
                {props.renderHeaderActions ? props.renderHeaderActions() : null}
            </View>
            {forceEmptyState || tabs.length === 0 ? (
                props.renderEmptyState ? props.renderEmptyState() : (
                    <View style={{ flex: 1, minHeight: 0, minWidth: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
                        <CenteredInfoTile
                            titleTestID="pane-details-empty-state-title"
                            descriptionTestID="pane-details-empty-state-description"
                            icon={(
                                <Octicons
                                    name="plus-circle"
                                    size={44}
                                    color={theme.colors.textSecondary}
                                    style={{ marginBottom: 12 }}
                                />
                            )}
                            title={t('session.detailsPanel.emptyTitle')}
                            description={t('session.detailsPanel.emptyHint')}
                            paddingHorizontal={0}
                        />
                    </View>
                )
            ) : (
                <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                    {tabs.map((tab) => {
                        const isActive = effectiveActiveKey ? tab.key === effectiveActiveKey : false;
                        return (
                            <DetailsTabSurface key={tab.key} isActive={isActive}>
                                <React.Suspense fallback={renderLoadingFallback()}>
                                    {props.renderTabContent(tab)}
                                </React.Suspense>
                            </DetailsTabSurface>
                        );
                    })}
                </View>
            )}
        </ViewWithWheel>
    );
});
