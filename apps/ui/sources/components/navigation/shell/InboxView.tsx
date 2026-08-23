import * as React from 'react';
import { View, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    useAllSessionListRenderablesForAttention,
    useAllSessionsForAttention,
    useArtifacts,
    useFeedItems,
    useFeedLoaded,
    useFriendRequests,
    useFriendsLoaded,
    useRequestedFriends,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { UpdateBanner } from '@/components/ui/feedback/UpdateBanner';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { Typography } from '@/constants/Typography';
import { useRouter } from 'expo-router';

import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { layout } from '@/components/ui/layout/layout';
import { useIsTablet } from '@/utils/platform/responsive';
import { Header } from '@/components/navigation/Header';
import { Image } from 'expo-image';
import { FeedItemCard } from '@/components/inbox/cards/FeedItemCard';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { Text } from '@/components/ui/text/Text';
import { UserCard } from '@/components/ui/cards/UserCard';
import { trackFriendsProfileView } from '@/track';
import { ApprovalInboxCard } from '@/components/inbox/cards/ApprovalInboxCard';
import { InboxSessionAttentionGroupCard } from '@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { buildInboxSessionState } from '@/hooks/inbox/buildInboxSessionState';
import { ActionOperationLedger } from '@/components/inbox/actionOperations/ActionOperationLedger';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { useActionOperationActivityModel } from '@/components/inbox/actionOperations/useActionOperationActivityModel';

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    emptyIcon: {
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 20,
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyDescription: {
        fontSize: 16,
        ...Typography.default(),
        color: theme.colors.text.secondary,
        textAlign: 'center',
        lineHeight: 22,
    },
    emptyActivityDescription: {
        marginTop: 8,
        fontSize: 14,
        ...Typography.default(),
        color: theme.colors.text.tertiary,
        textAlign: 'center',
        lineHeight: 20,
    },
}));

interface InboxViewProps {}

// Header components for tablet mode only (phone mode header is in MainView)
function HeaderTitleTablet() {
    const { theme } = useUnistyles();
    return (
        <Text style={{
            fontSize: 17,
            color: theme.colors.chrome.header.foreground,
            fontWeight: '600',
            ...Typography.default('semiBold'),
        }}>
            {t('tabs.inbox')}
        </Text>
    );
}

export const InboxView = React.memo(({}: InboxViewProps) => {
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const friendRequests = useFriendRequests();
    const requestedFriends = useRequestedFriends();
    const feedItems = useFeedItems();
    const artifacts = useArtifacts();
    const feedLoaded = useFeedLoaded();
    const friendsLoaded = useFriendsLoaded();
    const { theme } = useUnistyles();
    const isTablet = useIsTablet();
    const friendsEnabled = useFriendsEnabled();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsIdentityReady = friendsIdentityReadiness.isReady;
    const sessions = useAllSessionsForAttention();
    const actionOperationModel = useActionOperationActivityModel();
    const actionOperations = actionOperationModel.operations;
    const sessionRows = useAllSessionListRenderablesForAttention();
    const { unreadSessions, sessionsNeedingAttention } = React.useMemo(
        () => buildInboxSessionState({ sessions, sessionRows }),
        [sessionRows, sessions],
    );

    const openApprovals = React.useMemo(() => {
        return artifacts.filter((a) => a.header?.kind === 'approval_request.v1' && a.header?.approvalStatus === 'open');
    }, [artifacts]);

    const showFriendsActivity = friendsEnabled && friendsIdentityReady;
    const isLoading = friendsEnabled ? (!feedLoaded || !friendsLoaded) : false;
    const isEmpty = !isLoading &&
        openApprovals.length === 0 &&
        actionOperations.length === 0 &&
        sessionsNeedingAttention.length === 0 &&
        unreadSessions.length === 0 &&
        (!showFriendsActivity || (
            friendRequests.length === 0 &&
            requestedFriends.length === 0 &&
            feedItems.length === 0
        ));

    if (isLoading) {
        return (
            <View style={styles.container}>
                {isTablet && (
                    <View style={{ backgroundColor: theme.colors.background.canvas }}>
                        <Header
                            title={<HeaderTitleTablet />}
                            headerRight={() => null}
                            headerLeft={() => null}
                            headerShadowVisible={false}
                            headerTransparent={true}
                        />
                    </View>
                )}
                <RecoveryKeyReminderBanner />
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    <ActivitySpinner size="large" color={theme.colors.text.secondary} />
                </View>
            </View>
        );
    }

    if (isEmpty) {
        return (
            <View style={styles.container}>
                {isTablet && (
                    <View style={{ backgroundColor: theme.colors.background.canvas }}>
                        <Header
                            title={<HeaderTitleTablet />}
                            headerRight={() => null}
                            headerLeft={() => null}
                            headerShadowVisible={false}
                            headerTransparent={true}
                        />
                    </View>
                )}
                <RecoveryKeyReminderBanner />
                <UpdateBanner />
                <View style={styles.emptyContainer}>
                    <Image
                        source={require('@/assets/images/brutalist/Brutalism 10.png')}
                        contentFit="contain"
                        style={[{ width: 64, height: 64 }, styles.emptyIcon]}
                        tintColor={theme.colors.text.secondary}
                    />
                    <Text style={styles.emptyTitle}>{t('inbox.emptyTitle')}</Text>
                    <Text style={styles.emptyDescription}>{t('inbox.emptyDescription')}</Text>
                    <Text style={styles.emptyActivityDescription}>{t('inbox.actionOperations.empty')}</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {isTablet && (
                <View style={{ backgroundColor: theme.colors.background.canvas }}>
                    <Header
                        title={<HeaderTitleTablet />}
                        headerRight={() => null}
                        headerLeft={() => null}
                        headerShadowVisible={false}
                        headerTransparent={true}
                    />
                </View>
            )}
            <ScrollView contentContainerStyle={{
                maxWidth: layout.maxWidth,
                alignSelf: 'center',
                width: '100%'
            }}>
                <RecoveryKeyReminderBanner />
                <UpdateBanner />

                <ActionOperationLedger
                    operations={actionOperations}
                    observationForOperation={actionOperationModel.observationForOperation}
                    contextForOperation={actionOperationModel.contextForOperation}
                    onOpenOperation={openActionOperationDetail}
                    canDismissOperation={actionOperationModel.canDismissOperation}
                    onDismissOperation={actionOperationModel.dismissOperation}
                    showEmptyState={false}
                />

                {openApprovals.length > 0 && (
                    <ItemGroup title={t('inbox.approvals')}>
                        {openApprovals.map((artifact) => (
                            <ApprovalInboxCard
                                key={artifact.id}
                                artifact={artifact}
                                onPress={() => router.push(`/inbox/approvals/${artifact.id}`)}
                            />
                        ))}
                    </ItemGroup>
                )}

                {sessionsNeedingAttention.length > 0 && (
                    <ItemGroup title={t('inbox.permissions')}>
                        {sessionsNeedingAttention.map((entry) => {
                            return (
                                <InboxSessionAttentionGroupCard
                                    key={entry.session.id}
                                    session={entry.session}
                                    permissionRequests={entry.pendingPermissions}
                                    userActionRequests={entry.pendingUserActions}
                                />
                            );
                        })}
                    </ItemGroup>
                )}

                {unreadSessions.length > 0 && (
                    <ItemGroup title={t('inbox.unreadSessions')}>
                        {unreadSessions.map((session) => (
                            <Item
                                key={session.id}
                                title={getSessionName(session)}
                                subtitle={getSessionSubtitle(session)}
                                onPress={() => { void navigateToSession(session.id); }}
                            />
                        ))}
                    </ItemGroup>
                )}

                {showFriendsActivity && friendRequests.length > 0 && (
                    <ItemGroup title={t('friends.pendingRequests')}>
                        {friendRequests.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => {
                                    trackFriendsProfileView();
                                    router.push(`/user/${friend.id}`);
                                }}
                            />
                        ))}
                    </ItemGroup>
                )}

                {showFriendsActivity && requestedFriends.length > 0 && (
                    <ItemGroup title={t('friends.requestPending')}>
                        {requestedFriends.map((friend) => (
                            <UserCard
                                key={friend.id}
                                user={friend}
                                onPress={() => {
                                    trackFriendsProfileView();
                                    router.push(`/user/${friend.id}`);
                                }}
                            />
                        ))}
                    </ItemGroup>
                )}

                {showFriendsActivity && feedItems.length > 0 && (
                    <ItemGroup title={t('inbox.updates')}>
                        {feedItems.map((item) => (
                            <FeedItemCard key={item.id} item={item} />
                        ))}
                    </ItemGroup>
                )}
            </ScrollView>
        </View>
    );
});
