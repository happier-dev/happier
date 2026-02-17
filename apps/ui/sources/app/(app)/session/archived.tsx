import React from 'react';
import { Pressable, View, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text/StyledText';
import { layout } from '@/components/ui/layout/layout';
import { Typography } from '@/constants/Typography';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useAllSessions } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionAvatarId, getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { sessionUnarchiveWithServerScope } from '@/sync/ops';

const styles = StyleSheet.create((theme) => ({
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
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    sessionCard: {
        backgroundColor: theme.colors.surface,
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
        color: theme.colors.text,
        marginBottom: 2,
        ...Typography.default('semiBold'),
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
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
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));

function canManageArchive(session: Session): boolean {
    // Owner sessions have no accessLevel set; shared sessions require admin.
    return !session.accessLevel || session.accessLevel === 'admin';
}

export default function ArchivedSessionsScreen() {
    const safeArea = useSafeAreaInsets();
    const navigateToSession = useNavigateToSession();
    const allSessions = useAllSessions();

    const archivedSessions = React.useMemo(() => {
        return allSessions
            .filter((s) => s.archivedAt != null)
            .slice()
            .sort((a, b) => {
                const aAt = typeof a.archivedAt === 'number' ? a.archivedAt : 0;
                const bAt = typeof b.archivedAt === 'number' ? b.archivedAt : 0;
                if (bAt !== aAt) return bAt - aAt;
                return b.updatedAt - a.updatedAt;
            });
    }, [allSessions]);

    const handleUnarchive = React.useCallback((session: Session) => {
        Modal.alert(
            t('sessionInfo.unarchiveSession'),
            t('sessionInfo.unarchiveSessionConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('sessionInfo.unarchiveSession'),
                    style: 'default',
                    onPress: async () => {
                        const result = await sessionUnarchiveWithServerScope(session.id, { serverId: null });
                        if (!result.success) {
                            Modal.alert(t('common.error'), result.message || t('sessionInfo.failedToUnarchiveSession'));
                        }
                    },
                },
            ],
        );
    }, []);

    const renderItem = React.useCallback(
        ({ item, index }: { item: Session; index: number }) => {
            const sessionName = getSessionName(item);
            const sessionSubtitle = getSessionSubtitle(item);
            const avatarId = getSessionAvatarId(item);

            const isFirst = index === 0;
            const isLast = index === archivedSessions.length - 1;
            const isSingle = archivedSessions.length === 1;

            return (
                <Pressable
                    style={[
                        styles.sessionCard,
                        isSingle ? styles.sessionCardSingle : isFirst ? styles.sessionCardFirst : isLast ? styles.sessionCardLast : null,
                    ]}
                    onPress={() => navigateToSession(item.id)}
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
                    {canManageArchive(item) ? (
                        <Pressable
                            style={styles.actionButton}
                            onPress={() => handleUnarchive(item)}
                            accessibilityRole="button"
                            accessibilityLabel={t('sessionInfo.unarchiveSession')}
                            hitSlop={8}
                        >
                            <Ionicons name="arrow-undo-outline" size={18} color={String((styles.sessionSubtitle as any)?.color ?? '#666')} />
                        </Pressable>
                    ) : null}
                </Pressable>
            );
        },
        [archivedSessions.length, handleUnarchive, navigateToSession],
    );

    return (
        <View style={styles.container}>
            <View style={styles.contentContainer}>
                <View style={styles.headerSection}>
                    <Text style={styles.headerText}>{t('sessionInfo.archivedSessions')}</Text>
                </View>

                {archivedSessions.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>{t('sessionHistory.empty')}</Text>
                    </View>
                ) : (
                    <FlatList
                        data={archivedSessions}
                        renderItem={renderItem}
                        keyExtractor={(item) => item.id}
                        contentContainerStyle={{ paddingBottom: safeArea.bottom + 64, maxWidth: layout.maxWidth }}
                    />
                )}
            </View>
        </View>
    );
}
