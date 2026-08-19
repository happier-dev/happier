import React from 'react';
import { Pressable, View, SectionList, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { Typography } from '@/constants/Typography';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useAllSessions, useSessionListViewDataByServerId, useSessionOrganizationPinnedSessionKeys, useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getSessionAvatarId, getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { sessionUnarchiveWithServerScope } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { Icon } from '@/components/ui/icons/Icon';
import { useIsFocused } from '@react-navigation/native';
import { useSessionListPaneSourceScopeKey } from '@/components/sessions/shell/surface/sessionListPaneRetention';
import { useSessionNavigationCursorPublisher } from '@/sync/domains/session/navigation/useSessionNavigationCursorPublisher';
import type { SessionListLikeItem } from '@/sync/domains/session/navigation/sessionNavigationOrder';

type ArchivedScreenSession = Session | (SessionListRenderableSession & { serverId?: string });

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.background.canvas,
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    list: {
        flex: 1,
    },
    headerSection: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    headerText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    sectionDescription: {
        marginTop: 6,
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    sessionCard: {
        backgroundColor: theme.colors.surface.base,
        marginHorizontal: 16,
        marginBottom: 1,
        paddingVertical: 16,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
    },
    sessionCardFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionCardLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 12,
    },
    sessionCardSingle: {
        borderRadius: 12,
        marginBottom: 12,
    },
    sessionContent: {
        flex: 1,
        marginLeft: 16,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text.primary,
        marginBottom: 2,
        ...Typography.default('semiBold'),
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    actionButton: {
        width: 34,
        height: 34,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

function canManageArchive(session: ArchivedScreenSession): boolean {
    // Owner sessions have no accessLevel set; shared sessions require admin.
    return !session.accessLevel || session.accessLevel === 'admin';
}

function normalizeServerId(serverIdRaw: unknown): string | null {
    const serverId = typeof serverIdRaw === 'string' ? serverIdRaw.trim() : '';
    return serverId || null;
}

function normalizeServerScopedSessionKey(serverIdRaw: unknown, sessionIdRaw: unknown): string | null {
    const serverId = normalizeServerId(serverIdRaw) ?? '';
    const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
    if (!serverId || !sessionId) return null;
    return `${serverId}:${sessionId}`;
}

function getArchivedSessionKey(session: ArchivedScreenSession): string {
    return normalizeServerScopedSessionKey(session.serverId, session.id) ?? session.id;
}

export default function ArchivedSessionsScreen() {
    const safeArea = useSafeAreaInsets();
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const isFocused = useIsFocused();
    const sourceScopeKey = useSessionListPaneSourceScopeKey();
    const allSessions = useAllSessions();
    const sessionListViewDataByServerId = useSessionListViewDataByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const pinnedSessionKeys = useSessionOrganizationPinnedSessionKeys();

    React.useEffect(() => {
        void sync.fetchArchivedSessions().catch(() => undefined);
    }, []);

    const handleLoadMoreSessions = React.useCallback(() => {
        const requests = [sync.fetchMoreArchivedSessions()];
        if (hideInactiveSessions) {
            requests.push(sync.fetchMoreSessions());
        }
        void Promise.all(requests).catch(() => undefined);
    }, [hideInactiveSessions]);

    const pinnedSessionKeySet = React.useMemo(() => {
        return new Set(pinnedSessionKeys);
    }, [pinnedSessionKeys]);

    const cachedArchivedSessions = React.useMemo(() => {
        const byKey = new Map<string, ArchivedScreenSession>();
        for (const [serverId, items] of Object.entries(sessionListViewDataByServerId)) {
            if (!Array.isArray(items)) continue;
            for (const item of items) {
                if (item.type !== 'session') continue;
                if (item.session.archivedAt == null) continue;
                const normalizedServerId = normalizeServerId(item.serverId) ?? normalizeServerId(serverId);
                const archivedSession: ArchivedScreenSession = normalizedServerId
                    ? { ...item.session, serverId: normalizedServerId }
                    : item.session;
                byKey.set(getArchivedSessionKey(archivedSession), archivedSession);
            }
        }
        return Array.from(byKey.values());
    }, [sessionListViewDataByServerId]);

    const archivedSessions = React.useMemo(() => {
        const byKey = new Map<string, ArchivedScreenSession>();
        for (const session of cachedArchivedSessions) {
            byKey.set(getArchivedSessionKey(session), session);
        }
        for (const session of allSessions) {
            if (session.archivedAt != null) {
                byKey.set(getArchivedSessionKey(session), session);
            }
        }

        return Array.from(byKey.values())
            .sort((a, b) => {
                const aAt = typeof a.archivedAt === 'number' ? a.archivedAt : 0;
                const bAt = typeof b.archivedAt === 'number' ? b.archivedAt : 0;
                if (bAt !== aAt) return bAt - aAt;
                return b.updatedAt - a.updatedAt;
            });
    }, [allSessions, cachedArchivedSessions]);

    const hiddenInactiveSessions = React.useMemo(() => {
        if (!hideInactiveSessions) return [];

        return allSessions
            .filter((session) => {
                if (session.archivedAt != null) return false;
                if (session.active === true) return false;
                const sessionKey = normalizeServerScopedSessionKey(session.serverId, session.id);
                if (sessionKey && pinnedSessionKeySet.has(sessionKey)) return false;
                return true;
            })
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }, [allSessions, hideInactiveSessions, pinnedSessionKeySet]);

    const sections = React.useMemo(() => {
        const nextSections: Array<{
            key: 'archived' | 'hidden_inactive';
            title: string;
            data: ArchivedScreenSession[];
        }> = [];

        if (hiddenInactiveSessions.length > 0) {
            nextSections.push({
                key: 'hidden_inactive',
                title: t('settingsFeatures.hiddenInactiveSessionsSectionTitle'),
                data: hiddenInactiveSessions,
            });
        }

        if (archivedSessions.length > 0) {
            nextSections.push({
                key: 'archived',
                title: t('sessionInfo.archivedSessions'),
                data: archivedSessions,
            });
        }

        return nextSections;
    }, [archivedSessions, hiddenInactiveSessions]);

    // The rows this screen opens, in render order. `serverId` lives on the session record here
    // rather than on a list row, so it is mapped across explicitly — an unscoped key would not
    // match the session route it has to anchor on.
    const sessionNavigationItems = React.useMemo<SessionListLikeItem[]>(
        () => sections.flatMap((section) => section.data.map((session) => ({
            type: 'session',
            serverId: normalizeServerId(session.serverId) ?? undefined,
            session: { id: session.id },
        }))),
        [sections],
    );
    useSessionNavigationCursorPublisher({
        active: isFocused,
        origin: 'archived',
        sourceScopeKey,
        storageKind: 'all',
        items: sessionNavigationItems,
    });

    const handleUnarchive = React.useCallback((session: ArchivedScreenSession) => {
        const serverId = typeof session.serverId === 'string' && session.serverId.trim()
            ? session.serverId.trim()
            : null;

        Modal.alert(
            t('sessionInfo.unarchiveSession'),
            t('sessionInfo.unarchiveSessionConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.unarchiveSession'),
                    style: 'default',
                    onPress: async () => {
                        const result = await sessionUnarchiveWithServerScope(session.id, { serverId });
                        if (!result.success) {
                            Modal.alert(t('common.error'), result.message || t('sessionInfo.failedToUnarchiveSession'));
                        }
                    },
                },
            ],
        );
    }, []);

    const renderItem = React.useCallback(
        ({ item, index, section }: { item: ArchivedScreenSession; index: number; section: { key: 'archived' | 'hidden_inactive'; data: ArchivedScreenSession[] } }) => {
            const sessionName = getSessionName(item);
            const sessionSubtitle = getSessionSubtitle(item);
            const avatarId = getSessionAvatarId(item);

            const isFirst = index === 0;
            const isLast = index === section.data.length - 1;
            const isSingle = section.data.length === 1;
            const canShowUnarchive = section.key === 'archived' && canManageArchive(item);

            return (
                <Pressable
                    style={[
                        styles.sessionCard,
                        isSingle ? styles.sessionCardSingle : isFirst ? styles.sessionCardFirst : isLast ? styles.sessionCardLast : null,
                    ]}
                    onPress={() => navigateToSession(
                        item.id,
                        typeof item.serverId === 'string' && item.serverId.trim()
                            ? { serverId: item.serverId.trim() }
                            : undefined,
                    )}
                >
                    <Avatar id={avatarId} size={48} />
                    <View style={styles.sessionContent}>
                        <Text style={styles.sessionTitle} numberOfLines={1}>
                            {sessionName}
                        </Text>
                        <Text style={styles.sessionSubtitle} numberOfLines={1}>
                            {sessionSubtitle}
                        </Text>
                    </View>
                    {canShowUnarchive ? (
                        <Pressable
                            style={styles.actionButton}
                            onPress={() => handleUnarchive(item)}
                            accessibilityRole="button"
                            accessibilityLabel={t('sessionInfo.unarchiveSession')}
                            hitSlop={8}
                        >
                            <Icon name="arrow-arc-left" size={16} color={theme.colors.text.secondary} />
                        </Pressable>
                    ) : null}
                </Pressable>
            );
        },
        [handleUnarchive, navigateToSession, theme.colors.text.secondary],
    );

    const renderSectionHeader = React.useCallback(
        ({ section }: { section: { title: string } }) => (
            <View style={styles.headerSection}>
                <Text style={styles.headerText}>{section.title}</Text>
            </View>
        ),
        [],
    );

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        if (Platform.OS !== 'web') return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                {sections.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>{t('sessionHistory.empty')}</Text>
                    </View>
                ) : (
                    <SectionList
                        style={styles.list}
                        sections={sections}
                        renderItem={renderItem}
                        renderSectionHeader={renderSectionHeader}
                        keyExtractor={getArchivedSessionKey}
                        onEndReached={handleLoadMoreSessions}
                        onEndReachedThreshold={0.4}
                        {...(Platform.OS === 'web'
                            ? ({ onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb } as any)
                            : null)}
                        contentContainerStyle={{ paddingBottom: safeArea.bottom + 64, maxWidth: layout.maxWidth }}
                    />
                )}
            </View>
        </View>
    );
}
