import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { ApprovalInboxCard } from '@/components/inbox/cards/ApprovalInboxCard';
import { InboxSessionAttentionGroupCard } from '@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard';
import { InboxSessionReviewRow } from '@/components/inbox/InboxSessionReviewRow';
import { InboxMarkAllReadButton } from '@/components/inbox/InboxMarkAllReadButton';
import { ListSection } from '@/components/ui/lists/ListSection';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { UserCard } from '@/components/ui/cards/UserCard';
import { Typography } from '@/constants/Typography';
import {
    SessionListIdentity,
} from '@/components/sessions/shell/SessionListIdentity';
import { SESSION_LIST_ROW_IDENTITY_METRICS } from '@/components/sessions/shell/sessionListRowDensity';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

import { ActionOperationRows } from './actionOperations/ActionOperationLedger';
import type { InboxContentModel } from './useInboxContentModel';

export const InboxContent = React.memo(function InboxContent(props: Readonly<{
    model: InboxContentModel;
    onBeforeNavigate?: () => void;
    presentation?: 'screen' | 'popover';
}>) {
    const { theme } = useUnistyles();
    const model = props.model;
    const presentation = props.presentation ?? 'screen';
    const sectionSurface = presentation === 'screen' ? 'grouped' : 'flat';
    const beforeNavigate = React.useCallback(() => {
        props.onBeforeNavigate?.();
    }, [props.onBeforeNavigate]);
    const openSession = React.useCallback((sessionId: string, serverId: string | null) => {
        beforeNavigate();
        model.openSession(sessionId, serverId);
    }, [beforeNavigate, model]);
    const failedSessions = model.reviewSessions.filter((entry) => entry.reason === 'failed');
    const readySessions = model.reviewSessions.filter((entry) => entry.reason === 'ready');
    const { failedOperations, attentionOperations } = React.useMemo(() => ({
        failedOperations: model.actionOperationModel.inboxEntries
            .filter((entry) => entry.reason === 'failed')
            .map((entry) => entry.operation),
        attentionOperations: model.actionOperationModel.inboxEntries
            .filter((entry) => entry.reason !== 'failed')
            .map((entry) => entry.operation),
    }), [model.actionOperationModel.inboxEntries]);
    const operationRowsProps = {
        observationForOperation: model.actionOperationModel.observationForOperation,
        contextForOperation: model.actionOperationModel.contextForOperation,
        onOpenOperation: (operationId: string) => {
            beforeNavigate();
            model.openOperation(operationId);
        },
        canDismissOperation: model.actionOperationModel.canDismissOperation,
        onDismissOperation: model.actionOperationModel.dismissOperation,
        presentationMode: 'inbox',
    } as const;

    return (
        <View style={[styles.content, presentation === 'popover' ? styles.compactContent : null]}>
            <RecoveryKeyReminderBanner />

            {failedSessions.length > 0 || failedOperations.length > 0 ? (
                <ListSection namespace="inbox" id="errors" title={t('inbox.errors')} surface={sectionSurface}>
                    {failedSessions.map((entry) => {
                        const context = model.sessionContextByKey.get(entry.key);
                        return (
                            <InboxSessionReviewRow
                                key={entry.key}
                                session={entry.session}
                                identityDisplay={model.sessionListIdentityDisplay}
                                sessionId={entry.sessionId}
                                serverId={entry.serverId}
                                title={getSessionName(entry.session)}
                                subtitle={[t('status.error'), context?.workspaceName].filter(Boolean).join(' · ')}
                                statusLabel={t('status.error')}
                                pending={false}
                                onOpen={() => openSession(entry.sessionId, entry.serverId)}
                            />
                        );
                    })}
                    {failedOperations.length > 0 ? (
                        <ActionOperationRows operations={failedOperations} {...operationRowsProps} />
                    ) : null}
                </ListSection>
            ) : null}

            {readySessions.length > 0 ? (
                <ListSection
                    namespace="inbox"
                    id="ready"
                    title={t('status.readyForReview')}
                    headerAction={<InboxMarkAllReadButton model={model} />}
                    spacing="following"
                    surface={sectionSurface}
                >
                    {readySessions.map((entry) => {
                        const target = model.targetBySessionKey.get(entry.key);
                        const context = model.sessionContextByKey.get(entry.key);
                        return (
                            <InboxSessionReviewRow
                                key={entry.key}
                                session={entry.session}
                                identityDisplay={model.sessionListIdentityDisplay}
                                sessionId={entry.sessionId}
                                serverId={entry.serverId}
                                title={getSessionName(entry.session)}
                                subtitle={[t('status.readyForReview'), context?.workspaceName].filter(Boolean).join(' · ')}
                                statusLabel={t('status.readyForReview')}
                                pending={target ? model.pendingReadKeys.has(target.key) : false}
                                onOpen={() => openSession(entry.sessionId, entry.serverId)}
                                onMarkRead={target ? () => model.markRead([target]) : undefined}
                            />
                        );
                    })}
                </ListSection>
            ) : null}

            {model.openApprovals.length > 0 || model.sessionsNeedingAttention.length > 0 || attentionOperations.length > 0 ? (
                <ListSection
                    namespace="inbox"
                    id="needs-attention"
                    title={t('inbox.actionOperations.sections.needsAttention')}
                    spacing="separated"
                    surface={sectionSurface}
                >
                    {model.openApprovals.map((artifact) => (
                        <ApprovalInboxCard
                            key={artifact.id}
                            artifact={artifact}
                            sessionContext={model.approvalContextByArtifactId.get(artifact.id)}
                            onPress={() => {
                                beforeNavigate();
                                model.openApproval(artifact.id);
                            }}
                        />
                    ))}
                    {model.sessionsNeedingAttention.map((entry) => {
                        const context = model.sessionContextByKey.get(entry.key);
                        const statusLabel = entry.reason === 'permission_required'
                            ? t('status.permissionRequired')
                            : t('status.actionRequired');
                        if (
                            'agentState' in entry.session
                            && (entry.pendingPermissions.length > 0 || entry.pendingUserActions.length > 0)
                        ) {
                            return (
                                <InboxSessionAttentionGroupCard
                                    key={entry.key}
                                    session={entry.session}
                                    serverId={entry.serverId}
                                    permissionRequests={entry.pendingPermissions}
                                    userActionRequests={entry.pendingUserActions}
                                    machineLabel={context?.machineLabel ?? null}
                                    workspaceName={context?.workspaceName ?? null}
                                    identityDisplay={model.sessionListIdentityDisplay}
                                    onOpenSession={() => openSession(entry.sessionId, entry.serverId)}
                                />
                            );
                        }

                        return (
                            <Item
                                key={entry.key}
                                testID={`inbox.session_attention.${entry.serverId ?? 'local'}.${entry.sessionId}`}
                                title={getSessionName(entry.session)}
                                subtitle={[statusLabel, context?.workspaceName].filter(Boolean).join(' · ')}
                                density="compact"
                                leftElement={model.sessionListIdentityDisplay !== 'none' ? (
                                    <SessionListIdentity
                                        session={entry.session}
                                        display={model.sessionListIdentityDisplay}
                                        avatarSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize}
                                        agentLogoSize={SESSION_LIST_ROW_IDENTITY_METRICS.compact.agentLogoSize}
                                        color={theme.colors.text.primary}
                                        testID={`inbox.session_attention.${entry.serverId ?? 'local'}.${entry.sessionId}.identity`}
                                    />
                                ) : undefined}
                                iconBoxSize={model.sessionListIdentityDisplay !== 'none'
                                    ? SESSION_LIST_ROW_IDENTITY_METRICS.compact.slotSize
                                    : undefined}
                                onPress={() => openSession(entry.sessionId, entry.serverId)}
                            />
                        );
                    })}
                    {attentionOperations.length > 0 ? (
                        <ActionOperationRows operations={attentionOperations} {...operationRowsProps} />
                    ) : null}
                </ListSection>
            ) : null}

            {model.showFriendsActivity && model.friendRequests.length > 0 ? (
                <ListSection namespace="inbox" id="friend-requests" title={t('friends.pendingRequests')} spacing="separated" surface={sectionSurface}>
                    {model.friendRequests.map((friend) => (
                        <UserCard
                            key={friend.id}
                            user={friend}
                            density="compact"
                            onPress={() => {
                                beforeNavigate();
                                model.openFriend(friend.id);
                            }}
                        />
                    ))}
                </ListSection>
            ) : null}

            {model.isFriendsLoading && !model.hasContent ? (
                <View style={styles.loadingContainer}>
                    <ActivitySpinner size="large" color={theme.colors.text.secondary} />
                </View>
            ) : null}

            {model.showCaughtUp ? (
                <View style={[styles.emptyContainer, presentation === 'popover' ? styles.compactEmptyContainer : null]}>
                    <View style={styles.emptyIconSurface}>
                        <Icon name="check-circle" size={25} color={theme.colors.state.success.foreground} />
                    </View>
                    <Text style={styles.emptyTitle}>{t('inbox.emptyTitle')}</Text>
                    <Text style={styles.emptyDescription}>{t('inbox.emptyDescription')}</Text>
                </View>
            ) : null}

        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    content: {
        flexGrow: 1,
        paddingBottom: 24,
    },
    compactContent: {
        paddingBottom: 14,
    },
    emptyContainer: {
        flexGrow: 1,
        minHeight: 320,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
        paddingVertical: 48,
    },
    compactEmptyContainer: {
        minHeight: 220,
        paddingVertical: 34,
    },
    emptyIconSurface: {
        width: 52,
        height: 52,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 18,
        backgroundColor: theme.colors.state.success.background,
        borderWidth: 1,
        borderColor: theme.colors.state.success.border,
    },
    emptyTitle: {
        fontSize: 20,
        lineHeight: 26,
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        marginBottom: 7,
        textAlign: 'center',
    },
    emptyDescription: {
        maxWidth: 360,
        fontSize: 15,
        ...Typography.default(),
        color: theme.colors.text.secondary,
        textAlign: 'center',
        lineHeight: 21,
    },
    loadingContainer: {
        flexGrow: 1,
        minHeight: 240,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
