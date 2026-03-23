import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons, Octicons } from '@expo/vector-icons';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    renderProviderSessionDetailsTab,
    resolveProviderSessionDetailsTabIconName,
} from '@/agents/registry/sessionSubagentUiBehavior';
import { SessionExecutionRunLauncherView } from '@/components/sessions/runs/launcher/SessionExecutionRunLauncherView';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { PinIcon, PinSlashIcon } from '@/components/sessions/shell/sessionPinIcons';
import { t } from '@/text';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { useWebScrollLockBypass } from '@/components/ui/scroll/useWebScrollLockBypass';
import { resolveWebScrollableElementWithin } from '@/components/ui/scroll/resolveWebScrollableElement';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '../shell/sessionScreenTestIds';

export type SessionDetailsPanelProps = Readonly<{
    sessionId: string;
    scopeId: string;
    /**
     * Optional override for the close action. Used by fullscreen/mobile routes that render the same
     * surface as the desktop details pane but need to navigate back in the router stack.
     */
    onRequestClose?: () => void;
}>;

const ViewWithWheel = View as unknown as React.ComponentType<
    React.ComponentPropsWithRef<typeof View> & { onWheel?: any; onTouchMove?: any }
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
    iconButton: {
        width: 34,
        height: 34,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        minHeight: 0,
        minWidth: 0,
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        ...Typography.default(),
        textAlign: 'center',
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

const LazySessionFileDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionFileDetailsView');
    return { default: mod.SessionFileDetailsView };
});

const LazySessionCommitDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionCommitDetailsView');
    return { default: mod.SessionCommitDetailsView };
});

const LazySessionScmReviewDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
    return { default: mod.SessionScmReviewDetailsView };
});

const LazySessionScmStashDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionScmStashDetailsView');
    return { default: mod.SessionScmStashDetailsView };
});

const LazySessionSubagentDetailsView = React.lazy(async () => {
    const mod = await import('@/components/sessions/agents/details/SessionSubagentDetailsView');
    return { default: mod.SessionSubagentDetailsView };
});

function asResource(value: unknown): { kind: string } | null {
    if (!value || typeof value !== 'object') return null;
    if (!('kind' in value)) return null;
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind !== 'string') return null;
    return { kind };
}

function isFileResource(value: unknown): value is Readonly<{ kind: 'file'; path: string }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; path?: unknown };
    return maybe.kind === 'file' && typeof maybe.path === 'string';
}

function isCommitResource(value: unknown): value is Readonly<{ kind: 'commit'; sha: string }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; sha?: unknown; commitHash?: unknown };
    const sha = typeof maybe.sha === 'string' ? maybe.sha : typeof maybe.commitHash === 'string' ? maybe.commitHash : null;
    return maybe.kind === 'commit' && typeof sha === 'string';
}

function isScmReviewResource(value: unknown): value is Readonly<{ kind: 'scmReview' }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown };
    return maybe.kind === 'scmReview';
}

function isScmStashResource(value: unknown): value is Readonly<{ kind: 'scmStash' }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown };
    return maybe.kind === 'scmStash';
}

function isTerminalResource(value: unknown): value is Readonly<{ kind: 'terminal' }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown };
    return maybe.kind === 'terminal';
}

function isSubagentResource(value: unknown): value is Readonly<{ kind: 'subagent'; subagentId: string }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; subagentId?: unknown };
    return maybe.kind === 'subagent' && typeof maybe.subagentId === 'string' && maybe.subagentId.trim().length > 0;
}

function isExecutionRunLauncherResource(value: unknown): value is Readonly<{
    kind: 'executionRunLauncher';
    intent?: 'review' | 'plan' | 'delegate';
}> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; intent?: unknown };
    if (maybe.kind !== 'executionRunLauncher') return false;
    return maybe.intent == null || maybe.intent === 'review' || maybe.intent === 'plan' || maybe.intent === 'delegate';
}

export const SessionDetailsPanel = React.memo((props: SessionDetailsPanelProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const requestClose = props.onRequestClose ?? pane.closeDetails;
    const editorFocusModeEnabled = useLocalSetting('editorFocusModeEnabled');
    const [, setEditorFocusModeEnabled] = useLocalSettingMutable('editorFocusModeEnabled');
    const sessionScreenTestIdsEnabled = useSessionScreenTestIdsEnabled();
    const rootRef = React.useRef<any>(null);
    useWebScrollLockBypass({ rootRef, enabled: true });
    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) overlays on web can install document-level wheel/touchmove listeners
        // that prevent default scrolling. Stopping propagation at the pane root keeps scrolling inside
        // nested scroll views (FlashList/ScrollView) working reliably.
        if (Platform.OS !== 'web') return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);
    const details = pane.scopeState?.details ?? null;
    const tabs = details?.tabs ?? [];
    const activeKey = details?.activeTabKey ?? null;

    const activeTab = React.useMemo(() => tabs.find((t) => t.key === activeKey) ?? tabs.at(-1) ?? null, [activeKey, tabs]);
    const effectiveActiveKey = activeKey ?? activeTab?.key ?? null;

    const openFileTab = React.useCallback((path: string, intent: 'default' | 'pinned' = 'default') => {
        const fileName = path.split('/').pop() ?? path;
        deferOnWeb(() => {
            pane.openDetailsTab(
                {
                    key: `file:${path}`,
                    kind: 'file',
                    title: fileName,
                    resource: { kind: 'file', path },
                },
                { intent },
            );
        });
    }, [pane]);

    const renderLoadingFallback = React.useCallback(() => (
        <View style={styles.loading}>
            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            <Text style={styles.loadingText}>{t('common.loading')}</Text>
        </View>
    ), [styles.loading, styles.loadingText, theme.colors.textSecondary]);

    const renderTabContent = React.useCallback((tab: any) => {
        const resource = asResource(tab.resource);
        if (resource?.kind === 'file') {
            if (isFileResource(tab.resource)) {
                const anchor = (tab.resource as any)?.deepLinkAnchor ?? null;
                return (
                    <React.Suspense fallback={renderLoadingFallback()}>
                        <LazySessionFileDetailsView
                            sessionId={props.sessionId}
                            filePath={tab.resource.path}
                            deepLinkAnchor={anchor}
                            presentation="panel"
                            scopeId={props.scopeId}
                            onStartEditingFile={() => {
                                if (tab.isPreview) {
                                    pane.pinDetailsTab(tab.key);
                                }
                            }}
                        />
                    </React.Suspense>
                );
            }
        }
        if (resource?.kind === 'commit') {
            if (isCommitResource(tab.resource)) {
                const sha = (tab.resource as any)?.sha ?? (tab.resource as any)?.commitHash ?? '';
                return (
                    <React.Suspense fallback={renderLoadingFallback()}>
                        <LazySessionCommitDetailsView
                            sessionId={props.sessionId}
                            sha={String(sha)}
                            onBack={requestClose}
                            presentation="panel"
                            onOpenFile={(path) => openFileTab(path, 'default')}
                            onOpenFilePinned={(path) => openFileTab(path, 'pinned')}
                        />
                    </React.Suspense>
                );
            }
        }
        if (resource?.kind === 'scmReview') {
            if (isScmReviewResource(tab.resource)) {
                return (
                    <React.Suspense fallback={renderLoadingFallback()}>
                        <LazySessionScmReviewDetailsView sessionId={props.sessionId} scopeId={props.scopeId} />
                    </React.Suspense>
                );
            }
        }
        if (resource?.kind === 'scmStash') {
            if (isScmStashResource(tab.resource)) {
                return (
                    <React.Suspense fallback={renderLoadingFallback()}>
                        <LazySessionScmStashDetailsView
                            sessionId={props.sessionId}
                            scopeId={props.scopeId}
                            onOpenFile={(path) => openFileTab(path, 'default')}
                            onOpenFilePinned={(path) => openFileTab(path, 'pinned')}
                        />
                    </React.Suspense>
                );
            }
        }
        if (resource?.kind === 'terminal') {
            if (isTerminalResource(tab.resource)) {
                return (
                    <SessionEmbeddedTerminalPane
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        currentDockLocation="details"
                        testIdPrefix={sessionScreenTestIdsEnabled ? 'session-details-terminal' : null}
                    />
                );
            }
        }
        if (resource?.kind === 'subagent') {
            if (isSubagentResource(tab.resource)) {
                return (
                    <React.Suspense fallback={renderLoadingFallback()}>
                        <LazySessionSubagentDetailsView
                            sessionId={props.sessionId}
                            scopeId={props.scopeId}
                            subagentId={tab.resource.subagentId}
                        />
                    </React.Suspense>
                );
            }
        }
        if (resource?.kind === 'executionRunLauncher') {
            if (isExecutionRunLauncherResource(tab.resource)) {
                return (
                    <SessionExecutionRunLauncherView
                        sessionId={props.sessionId}
                        scopeId={props.scopeId}
                        presentation="panel"
                        initialIntent={tab.resource.intent}
                        onRequestClose={() => pane.closeDetailsTab(tab.key)}
                    />
                );
            }
        }
        const providerDetailsTab = renderProviderSessionDetailsTab({
            sessionId: props.sessionId,
            scopeId: props.scopeId,
            tab,
        });
        if (providerDetailsTab) {
            return providerDetailsTab;
        }

        return (
            <View style={styles.empty}>
                <Text style={styles.emptyText}>{t('session.detailsPanel.unsupportedTab')}</Text>
            </View>
        );
    }, [openFileTab, pane, props.scopeId, props.sessionId, renderLoadingFallback, requestClose, styles.empty, styles.emptyText]);

    return (
        <ViewWithWheel
            ref={rootRef}
            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-panel-root')}
            style={styles.container}
            {...(Platform.OS === 'web'
                ? ({ onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb } as any)
                : {})}
        >
            <View style={styles.header}>
                <ScrollView horizontal style={styles.tabsScroll} showsHorizontalScrollIndicator={false}>
                    {tabs.map((tab) => {
                        const isActive = effectiveActiveKey ? tab.key === effectiveActiveKey : false;
                        const safeTabKey = toTestIdSafeValue(tab.key);
                        const iconName =
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
                                            : resolveProviderSessionDetailsTabIconName(tab) ?? 'circle';
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
                                    onPress={() => pane.setActiveDetailsTab(tab.key)}
                                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-${safeTabKey}`)}
                                    style={[
                                        styles.tab,
                                        isActive ? styles.tabActive : null,
                                        // Reserve room for the action buttons so the label doesn't overlap.
                                        { paddingRight: tab.isPreview || tab.isPinned ? 52 : 34 },
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('session.detailsPanel.openTabA11y', { title: tab.title })}
                                >
                                    <Octicons
                                        name={iconName as any}
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
                                            onPress={(event: any) => {
                                                event?.stopPropagation?.();
                                                pane.pinDetailsTab(tab.key);
                                            }}
                                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-pin-${safeTabKey}`)}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('session.detailsPanel.pinTabA11y')}
                                            hitSlop={10}
                                        >
                                            <PinIcon size={16} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    ) : tab.isPinned ? (
                                        <Pressable
                                            onPress={(event: any) => {
                                                event?.stopPropagation?.();
                                                pane.unpinDetailsTab(tab.key);
                                            }}
                                            testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-unpin-${safeTabKey}`)}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('session.detailsPanel.unpinTabA11y')}
                                            hitSlop={10}
                                        >
                                            <PinSlashIcon size={16} color={theme.colors.textSecondary} />
                                        </Pressable>
                                    ) : null}
                                    <Pressable
                                        onPress={(event: any) => {
                                            event?.stopPropagation?.();
                                            pane.closeDetailsTab(tab.key);
                                        }}
                                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, `session-details-tab-close-${safeTabKey}`)}
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
                {Platform.OS === 'web' ? (
                    <Pressable
                        onPress={() => setEditorFocusModeEnabled(!editorFocusModeEnabled)}
                        testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-focus-toggle')}
                        style={styles.iconButton}
                        accessibilityRole="button"
                        accessibilityLabel={
                            editorFocusModeEnabled
                                ? t('session.detailsPanel.exitFocusModeA11y')
                                : t('session.detailsPanel.enterFocusModeA11y')
                        }
                    >
                        <Ionicons
                            name={editorFocusModeEnabled ? 'contract-outline' : 'expand-outline'}
                            size={18}
                            color={theme.colors.textSecondary}
                        />
                    </Pressable>
                ) : null}
                <Pressable
                    onPress={requestClose}
                    testID={resolveOptionalSessionScreenTestId(sessionScreenTestIdsEnabled, 'session-details-close')}
                    style={styles.iconButton}
                    accessibilityRole="button"
                    accessibilityLabel={t('session.detailsPanel.closeA11y')}
                >
                    <Octicons name="chevron-right" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
            {tabs.length === 0 ? (
                <View style={styles.empty}>
                    <Text style={styles.emptyText}>{t('session.detailsPanel.emptyHint')}</Text>
                </View>
            ) : (
                <View style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
                    {tabs.map((tab) => {
                        const isActive = effectiveActiveKey ? tab.key === effectiveActiveKey : false;
                        return (
                            <DetailsTabSurface key={tab.key} isActive={isActive}>
                                <React.Suspense fallback={<DetailsPaneLoadingFallback color={theme.colors.textSecondary} />}>
                                    {renderTabContent(tab)}
                                </React.Suspense>
                            </DetailsTabSurface>
                        );
                    })}
                </View>
            )}
        </ViewWithWheel>
    );
});

const DetailsPaneLoadingFallback = React.memo((props: Readonly<{ color: string }>) => {
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 24, paddingHorizontal: 16 }}>
            <Text style={{ fontSize: 12, color: props.color, ...Typography.default() }}>
                {t('common.loading')}
            </Text>
        </View>
    );
});

const DetailsTabSurface = React.memo((props: Readonly<{ isActive: boolean; children: React.ReactNode }>) => {
    const rootRef = React.useRef<any>(null);
    const scrollSnapshotRef = React.useRef<Array<{ testId: string; top: number; left: number }>>([]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const raw = rootRef.current as any;
        const rootEl = (raw?.getScrollableNode?.() ?? raw) as HTMLElement | null;
        const doc: any = (globalThis as any).document;
        if (!rootEl || !doc?.defaultView?.getComputedStyle) return;
        const win = doc.defaultView as Window;
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
        const raf: (cb: FrameRequestCallback) => number =
            typeof globalThis.requestAnimationFrame === 'function'
                ? globalThis.requestAnimationFrame.bind(globalThis)
                : (cb) => globalThis.setTimeout(() => cb(Date.now()), 0);
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
            raf(() => step());
        };
        raf(() => step());
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
            style={[
                StyleSheet.absoluteFillObject,
                // `minHeight: 0` is critical for nested flex+scroll layouts on web; without it,
                // some browsers can treat the absolute-fill container as having an "auto" min-size
                // and prevent inner scroll views (FlashList/ScrollView) from scrolling.
                { minHeight: 0, minWidth: 0, opacity: props.isActive ? 1 : 0 },
            ]}
            {...(a11yHiddenProps ?? {})}
        >
            {props.children}
        </View>
    );
});
