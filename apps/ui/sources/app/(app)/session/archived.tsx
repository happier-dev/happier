import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';
import { VirtualizedSectionList } from '@/components/ui/lists/virtualized/VirtualizedSectionList';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text/Text';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Typography } from '@/constants/Typography';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useAllSessions, useSessionListRowStateByServerId, useSessionOrganizationPinnedSessionKeys, useSetting } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { getSessionAvatarId, getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { sessionUnarchiveWithServerScope } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { Icon } from '@/components/ui/icons/Icon';

type ArchivedScreenSession = Session | (SessionListRenderableSession & { serverId?: string });

type ArchivedSessionsSectionKind = 'archived' | 'hidden';

type ArchivedSessionsSection = Readonly<{
    title: string;
    kind: ArchivedSessionsSectionKind;
    data: ArchivedScreenSession[];
}>;

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

function getPinnedSessionKey(session: ArchivedScreenSession): string {
    const serverId = String(session.serverId ?? '').trim();
    const sessionId = String(session.id ?? '').trim();
    return serverId && sessionId ? `${serverId}:${sessionId}` : '';
}

function getArchivedSessionKey(session: ArchivedScreenSession): string {
    const serverId = String(session.serverId ?? '').trim();
    const sessionId = String(session.id ?? '').trim();
    return serverId && sessionId ? `${serverId}:${sessionId}` : sessionId;
}

function isHiddenInactiveSession(session: ArchivedScreenSession, pinnedSessionKeysV1: ReadonlyArray<string>): boolean {
    if (session.archivedAt != null) return false;
    if (session.active === true) return false;
    if ('keepVisibleWhenInactive' in session && (session as { keepVisibleWhenInactive?: boolean }).keepVisibleWhenInactive === true) return false;
    const key = getPinnedSessionKey(session);
    return key === '' || !pinnedSessionKeysV1.includes(key);
}

export default function ArchivedSessionsScreen() {
    const safeArea = useSafeAreaInsets();
    // Composed at render time: the module-scope stylesheet evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const contentMaxWidthStyle = useLayoutMaxWidthStyle();
    const contentContainerStyle = React.useMemo(
        () => [styles.contentContainer, contentMaxWidthStyle],
        [contentMaxWidthStyle],
    );
    const listContentContainerStyle = React.useMemo(
        () => ({ paddingBottom: safeArea.bottom + 64, maxWidth: contentMaxWidthStyle.maxWidth }),
        [contentMaxWidthStyle, safeArea.bottom],
    );
    const { theme } = useUnistyles();
    const navigateToSession = useNavigateToSession();
    const allSessions = useAllSessions();
    const sessionListRowStateByServerId = useSessionListRowStateByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions') === true;
    const pinnedSessionKeysV1 = useSessionOrganizationPinnedSessionKeys();

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

    const cachedArchivedSessions = React.useMemo(() => {
        const byId = new Map<string, ArchivedScreenSession>();
        for (const [serverId, rowsBySessionId] of Object.entries(sessionListRowStateByServerId ?? {})) {
            if (!rowsBySessionId || typeof rowsBySessionId !== 'object') continue;
            for (const row of Object.values(rowsBySessionId)) {
                if (!row || row.archivedAt == null) continue;
                const session = {
                    ...row,
                    serverId,
                };
                if (!isUserFacingSession(session)) continue;
                byId.set(getArchivedSessionKey(session), session);
            }
        }
        return Array.from(byId.values());
    }, [sessionListRowStateByServerId]);

    const archivedSessions = React.useMemo(() => {
        const byId = new Map<string, ArchivedScreenSession>();
        for (const session of cachedArchivedSessions) {
            byId.set(getArchivedSessionKey(session), session);
        }
        for (const session of allSessions) {
            if (session.archivedAt != null && isUserFacingSession(session)) {
                byId.set(getArchivedSessionKey(session), session);
            }
        }
        return Array.from(byId.values())
            .sort((a, b) => {
                const aAt = typeof a.archivedAt === 'number' ? a.archivedAt : 0;
                const bAt = typeof b.archivedAt === 'number' ? b.archivedAt : 0;
                if (bAt !== aAt) return bAt - aAt;
                return b.updatedAt - a.updatedAt;
            });
    }, [allSessions, cachedArchivedSessions]);

    const hiddenInactiveSessions = React.useMemo(() => {
        if (!hideInactiveSessions) {
            return [];
        }
        return allSessions
            .filter((session) => isUserFacingSession(session) && isHiddenInactiveSession(session, pinnedSessionKeysV1))
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }, [allSessions, hideInactiveSessions, pinnedSessionKeysV1]);

    const sections = React.useMemo<ArchivedSessionsSection[]>(() => {
        const out: ArchivedSessionsSection[] = [];
        if (hiddenInactiveSessions.length > 0) {
            out.push({
                title: t('settingsFeatures.hiddenInactiveSessionsSectionTitle'),
                kind: 'hidden',
                data: hiddenInactiveSessions,
            });
        }
        if (archivedSessions.length > 0) {
            out.push({
                title: t('sessionInfo.archivedSessions'),
                kind: 'archived',
                data: archivedSessions,
            });
        }
        return out;
    }, [archivedSessions, hiddenInactiveSessions]);

    const handleUnarchive = React.useCallback((session: ArchivedScreenSession) => {
        Modal.alert(
            t('sessionInfo.unarchiveSession'),
            t('sessionInfo.unarchiveSessionConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.unarchiveSession'),
                    style: 'default',
                    onPress: async () => {
                        const result = await sessionUnarchiveWithServerScope(session.id, { serverId: session.serverId ?? null });
                        if (!result.success) {
                            Modal.alert(t('common.error'), result.message || t('sessionInfo.failedToUnarchiveSession'));
                        }
                    },
                },
            ],
        );
    }, []);

    const renderSessionCard = React.useCallback(
        (item: ArchivedScreenSession, index: number, section: ArchivedSessionsSection) => {
            const sessionName = getSessionName(item);
            const sessionSubtitle = getSessionSubtitle(item);
            const avatarId = getSessionAvatarId(item);

            const isFirst = index === 0;
            const isLast = index === section.data.length - 1;
            const isSingle = section.data.length === 1;

            return (
                <Pressable
                    key={getArchivedSessionKey(item)}
                    style={[
                        styles.sessionCard,
                        isSingle ? styles.sessionCardSingle : isFirst ? styles.sessionCardFirst : isLast ? styles.sessionCardLast : null,
                    ]}
                    onPress={() => navigateToSession(item.id, item.serverId ? { serverId: item.serverId } : undefined)}
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
                    {section.kind === 'archived' && canManageArchive(item) ? (
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
        ({ section }: { section: { title?: string } }) => (
            <View style={styles.headerSection}>
                <Text style={styles.headerText}>{section.title ?? ''}</Text>
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
            <View style={contentContainerStyle}>
                {sections.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>{t('sessionHistory.empty')}</Text>
                    </View>
                ) : (
                    <VirtualizedSectionList
                        style={styles.list}
                        sections={sections}
                        renderItem={({ item, index, section }) => renderSessionCard(item, index, section as ArchivedSessionsSection)}
                        renderSectionHeader={renderSectionHeader}
                        keyExtractor={getArchivedSessionKey}
                        onEndReached={handleLoadMoreSessions}
                        onEndReachedThreshold={0.4}
                        webScrollHandlers={Platform.OS === 'web'
                            ? { onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb }
                            : undefined}
                        contentContainerStyle={listContentContainerStyle}
                    />
                )}
            </View>
        </View>
    );
}
