import React, { memo, useState, useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { useSession, useIsDataReady } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { openFriendSelectorModal } from '@/components/sessions/sharing/openFriendSelectorModal';
import { openPublicLinkDialog } from '@/components/sessions/sharing/openPublicLinkDialog';
import { openSessionShareDialog } from '@/components/sessions/sharing/openSessionShareDialog';
import { SessionShare, PublicSessionShare, ShareAccessLevel } from '@/sync/domains/social/sharingTypes';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    getSessionShares,
    createSessionShare,
    updateSessionShare,
    deleteSessionShare,
    getPublicShare,
    createPublicShare,
    deletePublicShare
} from '@/sync/api/social/apiSharing';
import { sync } from '@/sync/sync';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { HappyError } from '@/utils/errors/errors';
import { getSessionFriendsList } from '@/sync/api/social/createSessionSocialRequest';
import { UserProfile } from '@/sync/domains/social/friendTypes';
import { encryptDataKeyForPublicShare } from '@/sync/encryption/publicShareEncryption';
import { getRandomBytes } from 'expo-crypto';
import { encryptDataKeyForRecipientV0, verifyRecipientContentPublicKeyBinding } from '@/sync/encryption/directShareEncryption';
import { buildCreateSessionShareRequest } from '@/sync/domains/social/sharingRequests/buildCreateSessionShareRequest';
import { Text } from '@/components/ui/text/Text';
import { mergePublicShareWithCachedToken } from '@/sync/domains/social/mergePublicShareWithCachedToken';
import { createPublicShareWithClientToken } from '@/sync/domains/social/createPublicShareWithClientToken';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveSessionShareRecipientEligibility } from '@/sync/domains/social/sessionShareRecipientEligibility';

type SharingData = Readonly<{
    shares: SessionShare[];
    publicShare: PublicSessionShare | null;
    friends: UserProfile[];
}>;

type SharingDataState = Readonly<{
    data: SharingData | null;
    loading: boolean;
    error: boolean;
}>;

function SharingManagementContent({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const canManage = !session?.accessLevel || session.accessLevel === 'admin';

    const publicShareTokenRef = useRef<string | null>(null);
    const sharingDataRequestRevisionRef = useRef(0);
    const [sharingDataState, setSharingDataState] = useState<SharingDataState>({
        data: null,
        loading: true,
        error: false,
    });
    const shares = sharingDataState.data?.shares ?? [];
    const publicShare = sharingDataState.data?.publicShare ?? null;
    const friends = sharingDataState.data?.friends ?? [];

    // Load sharing data
    const loadSharingData = useCallback(async () => {
        // Non-admin collaborators can view the session, but must not see or manage sharing settings.
        // Avoiding these calls prevents noisy 403 spam and misleading "Not shared" UI states.
        if (!canManage) return;
        const requestRevision = ++sharingDataRequestRevisionRef.current;
        setSharingDataState((current) => ({ ...current, loading: true, error: false }));
        const credentials = sync.getCredentials();
        try {
            const [sharesData, publicShareData, friendsData] = await Promise.all([
                getSessionShares(credentials, sessionId),
                getPublicShare(credentials, sessionId),
                getSessionFriendsList(credentials, sessionId),
            ]);
            if (sharingDataRequestRevisionRef.current !== requestRevision) return;
            setSharingDataState((current) => {
                const merged = mergePublicShareWithCachedToken({
                    previousPublicShare: current.data?.publicShare ?? null,
                    cachedToken: publicShareTokenRef.current,
                    outcome: { ok: true, publicShare: publicShareData },
                });
                publicShareTokenRef.current = merged.cachedToken;
                return {
                    data: {
                        shares: sharesData,
                        publicShare: merged.publicShare,
                        friends: friendsData,
                    },
                    loading: false,
                    error: false,
                };
            });
        } catch (error) {
            if (sharingDataRequestRevisionRef.current !== requestRevision) return;
            console.error('Failed to load sharing data:', error);
            setSharingDataState((current) => ({ ...current, loading: false, error: true }));
        }
    }, [canManage, sessionId]);

    useEffect(() => {
        void loadSharingData();
        return () => {
            sharingDataRequestRevisionRef.current += 1;
        };
    }, [loadSharingData]);

    // Handle adding a new share
    const handleAddShare = useCallback(async (userId: string, accessLevel: ShareAccessLevel, canApprovePermissions?: boolean) => {
        try {
            const credentials = sync.getCredentials();

            const friend = friends.find(f => f.id === userId);
            if (!friend) {
                throw new HappyError(t('errors.operationFailed'), false);
            }
            const eligibility = resolveSessionShareRecipientEligibility(friend);
            if (!eligibility.eligible) {
                throw new HappyError(
                    eligibility.reason === 'missing-content-keys'
                        ? t('session.sharing.recipientMissingKeys')
                        : t(`friends.status.${friend.status}`),
                    false,
                );
            }
            const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';

            const encryptedDataKey =
                sessionEncryptionMode === 'plain'
                    ? undefined
                    : (() => {
                        if (!friend.publicKey || !friend.contentPublicKey || !friend.contentPublicKeySig) {
                            throw new HappyError(t('session.sharing.recipientMissingKeys'), false);
                        }
                        const isValidBinding = verifyRecipientContentPublicKeyBinding({
                            signingPublicKeyHex: friend.publicKey,
                            contentPublicKeyB64: friend.contentPublicKey,
                            contentPublicKeySigB64: friend.contentPublicKeySig,
                        });
                        if (!isValidBinding) {
                            throw new HappyError(t('errors.operationFailed'), false);
                        }

                        // Get plaintext session DEK from the sync layer (owner/admin only)
                        const dataKey = sync.getSessionDataKey(sessionId);
                        if (!dataKey) {
                            throw new HappyError(t('errors.sessionNotFound'), false);
                        }
                        return encryptDataKeyForRecipientV0(dataKey, friend.contentPublicKey);
                    })();

            await createSessionShare(
                credentials,
                sessionId,
                buildCreateSessionShareRequest({
                    sessionEncryptionMode,
                    userId,
                    accessLevel,
                    ...(canApprovePermissions !== undefined ? { canApprovePermissions } : {}),
                    ...(encryptedDataKey ? { encryptedDataKey } : {}),
                }),
            );

            await loadSharingData();
        } catch (error) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [friends, sessionId, loadSharingData, session?.encryptionMode]);

    // Handle updating share access level
    const handleUpdateShare = useCallback(async (shareId: string, patch: { accessLevel?: ShareAccessLevel; canApprovePermissions?: boolean }) => {
        try {
            const credentials = sync.getCredentials();
            await updateSessionShare(credentials, sessionId, shareId, patch);
            await loadSharingData();
        } catch (error) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    // Handle removing a share
    const handleRemoveShare = useCallback(async (shareId: string) => {
        try {
            const credentials = sync.getCredentials();
            await deleteSessionShare(credentials, sessionId, shareId);
            await loadSharingData();
        } catch (error) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    // Handle creating public share
    const handleCreatePublicShare = useCallback(async (options: {
        expiresInDays?: number;
        maxUses?: number;
        isConsentRequired: boolean;
    }): Promise<PublicSessionShare> => {
        try {
            const credentials = sync.getCredentials();

            const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';

            const created = await createPublicShareWithClientToken({
                credentials,
                sessionId,
                sessionEncryptionMode,
                expiresInDays: options.expiresInDays,
                maxUses: options.maxUses,
                isConsentRequired: options.isConsentRequired,
                tokenCache: {
                    get: () => publicShareTokenRef.current,
                    set: (token) => {
                        publicShareTokenRef.current = token;
                    },
                },
                generateTokenHex: () => {
                    // Generate random token (12 bytes = 24 hex chars)
                    const tokenBytes = getRandomBytes(12);
                    return Array.from(tokenBytes)
                        .map((b) => b.toString(16).padStart(2, '0'))
                        .join('');
                },
                getSessionDataKey: (sid) => sync.getSessionDataKey(sid),
                encryptDataKeyForPublicShare,
                api: { createPublicShare },
            });

            await loadSharingData();
            return created;
        } catch (error) {
            console.error('Failed to create public share:', error);
            if (error instanceof HappyError) throw error;
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData, session?.encryptionMode]);

    // Handle deleting public share
    const handleDeletePublicShare = useCallback(async () => {
        try {
            const credentials = sync.getCredentials();
            await deletePublicShare(credentials, sessionId);
            publicShareTokenRef.current = null;
            await loadSharingData();
        } catch (error) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    if (!session) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="trash" size={48} color={theme.colors.text.secondary} />
                <Text style={{
                    color: theme.colors.text.primary,
                    fontSize: 20,
                    marginTop: 16,
                    ...Typography.default('semiBold')
                }}>
                    {t('errors.sessionDeleted')}
                </Text>
            </View>
        );
    }

    const excludedUserIds = shares.map(share => share.sharedWithUser.id);
    const canManagePermissionDelegation = !session.accessLevel || (session.accessLevel === 'admin' && session.canApprovePermissions === true);

    const openFriendSelector = useCallback(() => {
        void openFriendSelectorModal({
            friends,
            excludedUserIds,
            onSelect: handleAddShare,
            canManagePermissionDelegation,
        });
    }, [canManagePermissionDelegation, excludedUserIds, friends, handleAddShare]);

    const openPublicLink = useCallback(() => {
        void openPublicLinkDialog({
            publicShare,
            onCreate: handleCreatePublicShare,
            onDelete: handleDeletePublicShare,
        });
    }, [handleCreatePublicShare, handleDeletePublicShare, publicShare]);

    const openShareDialog = useCallback(() => {
        void openSessionShareDialog({
            sessionId,
            shares,
            canManage,
            canManagePermissionDelegation,
            onAddShare: openFriendSelector,
            onUpdateShare: handleUpdateShare,
            onRemoveShare: handleRemoveShare,
            onManagePublicLink: openPublicLink,
        });
    }, [
        canManage,
        canManagePermissionDelegation,
        handleRemoveShare,
        handleUpdateShare,
        openFriendSelector,
        openPublicLink,
        sessionId,
        shares,
    ]);

    if (!canManage) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="lock" size={48} color={theme.colors.text.secondary} />
                <Text style={{
                    color: theme.colors.text.primary,
                    fontSize: 20,
                    marginTop: 16,
                    ...Typography.default('semiBold')
                }}>
                    {t('errors.permissionDenied')}
                </Text>
                <Text style={{
                    color: theme.colors.text.secondary,
                    fontSize: 15,
                    marginTop: 8,
                    paddingHorizontal: 24,
                    textAlign: 'center',
                    ...Typography.default()
                }}>
                    {t('session.sharing.manageSharingDenied')}
                </Text>
            </View>
        );
    }

    if (sharingDataState.data === null) {
        if (sharingDataState.loading) {
            return (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    <Text style={{
                        color: theme.colors.text.secondary,
                        fontSize: 17,
                        marginTop: 16,
                        ...Typography.default('semiBold')
                    }}>
                        {t('common.loading')}
                    </Text>
                </View>
            );
        }
        return (
            <ItemList>
                <ItemGroup>
                    <Item
                        testID="session-sharing-load-retry"
                        title={t('errors.operationFailed')}
                        subtitle={t('common.retry')}
                        icon={<Icon name="warning-circle" size={29} color={theme.colors.state.warning.foreground} />}
                        onPress={loadSharingData}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <>
            <ItemList>
                {sharingDataState.error ? (
                    <ItemGroup>
                        <Item
                            testID="session-sharing-refresh-retry"
                            title={t('errors.operationFailed')}
                            subtitle={t('common.retry')}
                            icon={<Icon name="warning-circle" size={29} color={theme.colors.state.warning.foreground} />}
                            onPress={loadSharingData}
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : null}
                {/* Current Shares */}
                <ItemGroup title={t('session.sharing.directSharing')}>
                    {shares.length > 0 ? (
                        shares.map(share => (
                            <Item
                                key={share.id}
                                title={share.sharedWithUser.username || [share.sharedWithUser.firstName, share.sharedWithUser.lastName].filter(Boolean).join(' ')}
                                subtitle={`@${share.sharedWithUser.username} • ${t(`session.sharing.${share.accessLevel === 'view' ? 'viewOnly' : share.accessLevel === 'edit' ? 'canEdit' : 'canManage'}`)}`}
                                icon={<Icon name="person" size={29} color={theme.colors.accent.blue} />}
                                onPress={openShareDialog}
                            />
                        ))
                    ) : (
                        <Item
                            title={t('session.sharing.noShares')}
                            icon={<Icon name="users" size={29} color={theme.colors.text.secondary} />}
                            showChevron={false}
                        />
                    )}
                    {canManage && (
                        <Item
                            title={t('session.sharing.addShare')}
                            icon={<Icon name="user-plus" size={29} color={theme.colors.state.success.foreground} />}
                            onPress={openFriendSelector}
                        />
                    )}
                </ItemGroup>

                {/* Public Link */}
                <ItemGroup title={t('session.sharing.publicLink')}>
                    {publicShare ? (
                        <Item
                            title={t('session.sharing.publicLinkActive')}
                            subtitle={publicShare.expiresAt
                                ? t('session.sharing.expiresOn') + ': ' + new Date(publicShare.expiresAt).toLocaleDateString()
                                : t('session.sharing.never')
                            }
                            icon={<Icon name="link" size={29} color={theme.colors.state.success.foreground} />}
                            onPress={openPublicLink}
                        />
                    ) : (
                        <Item
                            title={t('session.sharing.createPublicLink')}
                            subtitle={t('session.sharing.publicLinkDescription')}
                            icon={<Icon name="link" size={29} color={theme.colors.accent.blue} />}
                            onPress={openPublicLink}
                        />
                    )}
                </ItemGroup>
            </ItemList>
        </>
    );
}

export default memo(() => {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = useSessionRouteServerScope(params);
    const { id } = params;
    const isDataReady = useIsDataReady();
    const routeHydrationState = useHydrateSessionForRoute(
        String(id ?? '').trim(),
        'SessionSharingRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const sessionMissingAfterHydration = isSessionRouteHydrationMissing(routeHydrationState);
    const headerTitle = t('session.sharing.title');
    const screenOptions = React.useMemo(() => ({ headerTitle }), [headerTitle]);

    if (sessionMissingAfterHydration) {
        return <SessionInvalidLinkFallback />;
    }

    if (!isDataReady || !sessionHydrated) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                <Text style={{
                    color: theme.colors.text.secondary,
                    fontSize: 17,
                    marginTop: 16,
                    ...Typography.default('semiBold')
                }}>
                    {t('common.loading')}
                </Text>
            </View>
        );
    }

    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />
            <SharingManagementContent sessionId={id} />
        </>
    );
});
