import React from 'react';
import { View, FlatList, Pressable } from 'react-native';
import { Text } from '@/components/ui/text/StyledText';
import { usePathname, useRouter } from 'expo-router';
import { SessionListViewItem, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { StyleSheet } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/platform/responsive';
import { requestReview } from '@/utils/system/requestReview';
import { UpdateBanner } from '@/components/ui/feedback/UpdateBanner';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { layout } from '@/components/ui/layout/layout';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { SessionGroupDragList, type SessionGroupRowModel } from './SessionGroupDragList';
import { SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { formatPathRelativeToHome } from '@/utils/sessions/sessionUtils';
import { getAllKnownTags, getTagsForSession } from './sessionTagUtils';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    headerSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    groupHeaderSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 6,
    },
    groupHeaderTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        ...Typography.default('semiBold'),
    },
    groupHeaderSubtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingHorizontal: 24,
        paddingTop: 8,
        paddingBottom: 4,
        backgroundColor: theme.colors.groupped.background,
    },
    footerContainer: {
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    footerButton: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    footerButtonText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
}));

type SessionListHeaderItem = Extract<SessionListViewItem, { type: 'header' }>;
type SessionListSessionItem = Extract<SessionListViewItem, { type: 'session' }> & { selected?: boolean };

type SessionListBlock =
    | Readonly<{
          type: 'server-header';
          key: string;
          title: string;
          serverId?: string;
      }>
    | Readonly<{
          type: 'section-header';
          key: string;
          title: string;
          headerKind: 'active' | 'inactive';
      }>
    | Readonly<{
          type: 'group';
          key: string;
          groupKey: string;
          header: SessionListHeaderItem;
          rows: ReadonlyArray<SessionGroupRowModel>;
      }>;

export function SessionsList() {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const data = useVisibleSessionListViewData();
    const pathname = usePathname();
    const router = useRouter();
    const isTablet = useIsTablet();
    const [pinnedSessionKeysV1, setPinnedSessionKeysV1] = useSettingMutable('pinnedSessionKeysV1');
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1');
    const [sessionTagsV1, setSessionTagsV1] = useSettingMutable('sessionTagsV1');
    const sessionTagsEnabled = useSetting('sessionTagsEnabled');
    const compactSessionView = useSetting('compactSessionView');
    const compactSessionViewMinimal = useSetting('compactSessionViewMinimal');
    const selection = useResolvedActiveServerSelection();
    const selectedServerCount = selection.allowedServerIds?.length ?? 0;
    const showServerBadge = selection.enabled && selection.presentation === 'flat-with-badge' && selectedServerCount > 1;
    const showPinnedServerBadge = selection.enabled && selectedServerCount > 1;
    const selectable = isTablet;
    const dataWithSelected = React.useMemo(() => {
        if (!data) return data;
        if (!selectable) return data;
        return data.map((item) => ({
            ...item,
            selected: pathname.startsWith(`/session/${item.type === 'session' ? item.session.id : ''}`),
        }));
    }, [data, pathname, selectable]);

    const pinnedKeySet = React.useMemo(() => {
        return new Set(Array.isArray(pinnedSessionKeysV1) ? pinnedSessionKeysV1 : []);
    }, [pinnedSessionKeysV1]);

    const pinnedKeyList = Array.isArray(pinnedSessionKeysV1) ? pinnedSessionKeysV1 : [];
    const currentGroupOrderMap = sessionListGroupOrderV1 ?? {};

    const allKnownTags = React.useMemo(() => getAllKnownTags(sessionTagsV1), [sessionTagsV1]);

    const hasMultipleMachines = React.useMemo(() => {
        if (!dataWithSelected) return false;
        const machineIds = new Set<string>();
        for (const item of dataWithSelected) {
            if (!item || item.type !== 'session') continue;
            const machineId = String(item.session?.metadata?.machineId ?? '').trim();
            const host = String(item.session?.metadata?.host ?? '').trim();
            const key = machineId || host;
            if (key) machineIds.add(key);
            if (machineIds.size > 1) return true;
        }
        return false;
    }, [dataWithSelected]);

    // Request review
    React.useEffect(() => {
        if (data && data.length > 0) {
            requestReview();
        }
    }, [data && data.length > 0]);

    // Early return if no data yet
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    const blocks: SessionListBlock[] = React.useMemo(() => {
        const blocks: SessionListBlock[] = [];
        const items = (dataWithSelected ?? []) as Array<SessionListViewItem | (SessionListSessionItem & { selected?: boolean })>;

        let currentGroupHeader: SessionListHeaderItem | null = null;
        let currentGroupRows: SessionGroupRowModel[] = [];

        const flushGroup = () => {
            if (!currentGroupHeader) return;
            const groupKey = String(currentGroupHeader.groupKey ?? '').trim();
            if (!groupKey || currentGroupRows.length === 0) {
                currentGroupHeader = null;
                currentGroupRows = [];
                return;
            }
            blocks.push({
                type: 'group',
                key: `group:${groupKey}`,
                groupKey,
                header: currentGroupHeader,
                rows: currentGroupRows,
            });
            currentGroupHeader = null;
            currentGroupRows = [];
        };

        for (const item of items) {
            if (item.type === 'header') {
                if (item.headerKind === 'server') {
                    flushGroup();
                    blocks.push({
                        type: 'server-header',
                        key: `server:${String(item.serverId ?? item.title ?? '').trim() || 'unknown'}`,
                        title: item.title,
                        serverId: item.serverId,
                    });
                    continue;
                }
                if (item.headerKind === 'active' || item.headerKind === 'inactive') {
                    flushGroup();
                    blocks.push({
                        type: 'section-header',
                        key: `section:${item.headerKind}:${String(item.serverId ?? '')}:${item.title}`,
                        title: item.title,
                        headerKind: item.headerKind,
                    });
                    continue;
                }
                flushGroup();
                currentGroupHeader = item;
                continue;
            }

            if (item.type === 'session') {
                const groupKey = String(item.groupKey ?? '').trim();
                if (!groupKey) continue;

                if (!currentGroupHeader || String(currentGroupHeader.groupKey ?? '').trim() !== groupKey) {
                    // Group header missing; start a synthetic header so we still render the group block.
                    currentGroupHeader = { type: 'header', title: '', headerKind: item.groupKind ?? 'date', groupKey };
                    currentGroupRows = [];
                }

                const sessionKey = typeof item.serverId === 'string' ? `${item.serverId}:${item.session.id}` : null;
                const pinned = item.pinned === true || (sessionKey ? pinnedKeySet.has(sessionKey) : false);
                const pathSubtitle = item.session?.metadata?.path
                    ? formatPathRelativeToHome(item.session.metadata.path, item.session.metadata.homeDir)
                    : '';
                const machineLabel = String(item.session?.metadata?.host ?? '').trim();
                const computedSubtitle = hasMultipleMachines
                    ? (machineLabel && pathSubtitle ? `${machineLabel} · ${pathSubtitle}` : machineLabel || pathSubtitle)
                    : pathSubtitle;
                const isGroupedByPath = item.groupKind === 'project' && item.variant === 'no-path';
                const subtitle = isGroupedByPath ? null : computedSubtitle;

                const rowTags = sessionKey ? getTagsForSession(sessionTagsV1, sessionKey) : [];
                currentGroupRows.push({
                    key: sessionKey ?? item.session.id,
                    session: item.session,
                    subtitle,
                    serverId: item.serverId,
                    serverName: item.serverName,
                    showServerBadge: pinned ? showPinnedServerBadge : showServerBadge,
                    pinned,
                    onTogglePinned:
                        sessionKey
                            ? () => {
                                  if (pinnedKeySet.has(sessionKey)) {
                                      setPinnedSessionKeysV1(pinnedKeyList.filter((k) => k !== sessionKey));
                                  } else {
                                      setPinnedSessionKeysV1([...pinnedKeyList, sessionKey]);
                                  }
                              }
                            : null,
                    tags: rowTags,
                    allKnownTags,
                    onSetTags: sessionKey
                        ? (newTags: string[]) => {
                              const next = { ...sessionTagsV1 };
                              if (newTags.length === 0) {
                                  delete next[sessionKey];
                              } else {
                                  next[sessionKey] = newTags;
                              }
                              setSessionTagsV1(next);
                          }
                        : null,
                    tagsEnabled: sessionTagsEnabled === true,
                    selected: (item as SessionListSessionItem).selected,
                    variant: item.variant,
                });
            }
        }

        flushGroup();
        return blocks;
    }, [
        dataWithSelected,
        hasMultipleMachines,
        pinnedKeyList,
        pinnedKeySet,
        setPinnedSessionKeysV1,
        showPinnedServerBadge,
        showServerBadge,
        sessionTagsV1,
        sessionTagsEnabled,
        allKnownTags,
        setSessionTagsV1,
    ]);

    const keyExtractor = React.useCallback((item: SessionListBlock) => item.key, []);

    const renderItem = React.useCallback(({ item }: { item: SessionListBlock }) => {
        switch (item.type) {
            case 'server-header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>{`Server: ${item.title}`}</Text>
                    </View>
                );
            case 'section-header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>{item.title}</Text>
                    </View>
                );
            case 'group':
                return (
                    <View>
                        {item.header.title && item.header.headerKind === 'project' ? (
                            <View style={styles.groupHeaderSection}>
                                <Text style={styles.groupHeaderTitle}>{item.header.title}</Text>
                                {hasMultipleMachines && item.header.subtitle ? (
                                    <Text style={styles.groupHeaderSubtitle}>{item.header.subtitle}</Text>
                                ) : null}
                            </View>
                        ) : item.header.title ? (
                            <View style={styles.headerSection}>
                                <Text style={styles.headerText}>{item.header.title}</Text>
                            </View>
                        ) : null}
                        <SessionGroupDragList
                            groupKey={item.groupKey}
                            rows={item.rows}
                            compact={Boolean(compactSessionView)}
                            compactMinimal={Boolean(compactSessionView && compactSessionViewMinimal)}
                            onReorderKeys={(orderedKeys) => {
                                const trimmed = Array.isArray(orderedKeys) ? orderedKeys.filter(Boolean) : [];
                                const capped = trimmed.slice(0, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);
                                setSessionListGroupOrderV1({ ...(currentGroupOrderMap ?? {}), [item.groupKey]: capped });
                            }}
                        />
                    </View>
                );
        }
    }, [compactSessionView, compactSessionViewMinimal, currentGroupOrderMap, hasMultipleMachines, setSessionListGroupOrderV1, styles]);

    const HeaderComponent = React.useCallback(() => {
        return (
            <View>
                <RecoveryKeyReminderBanner />
                <UpdateBanner />
                <View style={styles.headerActions} />
            </View>
        );
    }, [styles]);

    const FooterComponent = React.useCallback(() => {
        return (
            <View style={styles.footerContainer}>
                <Pressable
                    style={styles.footerButton}
                    onPress={() => router.push('/session/archived')}
                    accessibilityRole="button"
                >
                    <Text style={styles.footerButtonText}>{t('sessionInfo.archivedSessions')}</Text>
                </Pressable>
            </View>
        );
    }, [router, styles.footerButton, styles.footerButtonText, styles.footerContainer]);

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={blocks}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    contentContainerStyle={{ paddingBottom: safeArea.bottom + 128, maxWidth: layout.maxWidth }}
                    ListHeaderComponent={HeaderComponent}
                    ListFooterComponent={FooterComponent}
                />
            </View>
        </View>
    );
}
