import React, { memo, useState, useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useMachine, useSession } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { openFriendSelectorModal } from '@/components/sessions/sharing/openFriendSelectorModal';
import { openPublicLinkDialog } from '@/components/sessions/sharing/openPublicLinkDialog';
import { openSessionShareDialog } from '@/components/sessions/sharing/openSessionShareDialog';
import { SessionShare, PublicSessionShare, ShareAccessLevel } from '@/sync/domains/social/sharingTypes';
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
import { getFriendsList } from '@/sync/api/social/apiFriends';
import { UserProfile } from '@/sync/domains/social/friendTypes';
import { encryptDataKeyForPublicShare } from '@/sync/encryption/publicShareEncryption';
import { getRandomBytes } from 'expo-crypto';
import { encryptDataKeyForRecipientV0, verifyRecipientContentPublicKeyBinding } from '@/sync/encryption/directShareEncryption';
import { buildCreateSessionShareRequest } from '@/sync/domains/social/sharingRequests/buildCreateSessionShareRequest';
import { Text } from '@/components/ui/text/Text';
import { mergePublicShareWithCachedToken } from '@/sync/domains/social/mergePublicShareWithCachedToken';
import { createPublicShareWithClientToken } from '@/sync/domains/social/createPublicShareWithClientToken';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SessionInvalidLinkFallback } from '@/components/sessions/shell/SessionInvalidLinkFallback';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { resolveExternalSessionSharingPresentation } from '@/components/sessions/sharing/externalSessionSharingPresentation';
import { useSessionListRuntimeNowMs } from '@/hooks/session/sessionListRuntimeClock';
import {
    createExternalSessionTranscriptLiveSourceKeyFromLink,
    resolveExternalSessionTranscriptAuthorityState,
} from '@/sync/runtime/external/externalSessionTranscriptAuthority';
import { assertCurrentSessionSharingMutationAuthority } from '@/components/sessions/sharing/sessionSharingMutationAuthority';
import { Modal } from '@/modal';
import { machineExternalSessionMaterializeStart } from '@/sync/ops/machineExternalSessions';
import {
    presentExternalSessionOperationActionError,
} from '@/components/sessions/external/progress/externalSessionOperationActionErrorPresentation';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

function createMaterializeIdempotencyKey(): string {
    return Array.from(getRandomBytes(16))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function SharingManagementContent({
    sessionId,
    serverId,
}: {
    sessionId: string;
    serverId: string | null;
}) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const externalSessionLink = React.useMemo(
        () => readExternalSessionLink(ownerMetadata),
        [ownerMetadata],
    );
    const machine = useMachine(externalSessionLink?.machineId ?? '');
    const transcriptAuthorityState = resolveExternalSessionTranscriptAuthorityState({
        linked: externalSessionLink !== null,
        agentReachable: externalSessionLink === null
            ? false
            : machine === null
                ? null
                : isMachineOnline(machine),
        liveSourceKey: externalSessionLink
            ? createExternalSessionTranscriptLiveSourceKeyFromLink(externalSessionLink)
            : null,
        currentStorageState: session?.currentStorageState
            ?? (externalSessionLink ? 'legacy_external_unknown' : 'hosted'),
        acceptedThroughServerSeq: session?.acceptedThroughServerSeq ?? null,
        publishedThroughServerSeq: session?.publishedThroughServerSeq ?? null,
        materializedThroughSourceAt: session?.materializedThroughSourceAt ?? null,
        operationProgress: null,
    });
    const sharingPresentation = resolveExternalSessionSharingPresentation({
        machineName: getMachineDisplayName(machine) ?? externalSessionLink?.machineId ?? null,
        sharing: transcriptAuthorityState.sharing,
    });
    const sharingPresentationNowMs = useSessionListRuntimeNowMs(
        sharingPresentation.state === 'shared_snapshot_stale',
    );
    const canManage = !session?.accessLevel || session.accessLevel === 'admin';

    const [shares, setShares] = useState<SessionShare[]>([]);
    const [publicShare, setPublicShare] = useState<PublicSessionShare | null>(null);
    const publicShareTokenRef = useRef<string | null>(null);
    const [friends, setFriends] = useState<UserProfile[]>([]);
    const materializeIdempotencyKeyRef = useRef<string | null>(null);
    const sharingMutationAllowed = canManage && sharingPresentation.shareable;
    const sharingMutationAllowedRef = useRef(sharingMutationAllowed);
    sharingMutationAllowedRef.current = sharingMutationAllowed;
    const openSharingModalIdsRef = useRef(new Set<string>());
    const trackSharingModal = useCallback(async (open: Promise<string>) => {
        const modalId = await open;
        if (!sharingMutationAllowedRef.current) {
            Modal.hide(modalId);
            return;
        }
        openSharingModalIdsRef.current.add(modalId);
    }, []);
    const [materializeInFlight, startMaterialization] = useHappyAction(
        useCallback(async () => {
            if (!externalSessionLink) {
                throw new HappyError(t('externalSessions.sharingTranscriptUnavailable'), false);
            }
            const idempotencyKey = materializeIdempotencyKeyRef.current
                ?? createMaterializeIdempotencyKey();
            materializeIdempotencyKeyRef.current = idempotencyKey;
            const result = await machineExternalSessionMaterializeStart({
                machineId: externalSessionLink.machineId,
                request: {
                    v: 1,
                    idempotencyKey,
                    sessionId,
                    plan: 'materialize',
                    targetStorageMode: 'external-linked',
                    targetRuntimeMode: null,
                },
            }, { serverId });
            if (!result.ok) {
                throw new HappyError(
                    t(presentExternalSessionOperationActionError(result.error.code)),
                    false,
                );
            }
            materializeIdempotencyKeyRef.current = null;
        }, [externalSessionLink, serverId, sessionId]),
    );

    useEffect(() => {
        if (sharingMutationAllowed) return;
        for (const modalId of openSharingModalIdsRef.current) {
            Modal.hide(modalId);
        }
        openSharingModalIdsRef.current.clear();
    }, [sharingMutationAllowed]);

    // Load sharing data
    const loadSharingData = useCallback(async () => {
        // Non-admin collaborators can view the session, but must not see or manage sharing settings.
        // Avoiding these calls prevents noisy 403 spam and misleading "Not shared" UI states.
        if (!canManage || !sharingPresentation.shareable) return;
        const credentials = sync.getCredentials();

        // Load shares
        try {
            const sharesData = await getSessionShares(credentials, sessionId);
            setShares(sharesData);
        } catch (error) {
            console.error('Failed to load session shares:', error);
        }

        // Load public share
        try {
            const publicShareData = await getPublicShare(credentials, sessionId);
            setPublicShare((prev) => {
                const merged = mergePublicShareWithCachedToken({
                    previousPublicShare: prev,
                    cachedToken: publicShareTokenRef.current,
                    outcome: { ok: true, publicShare: publicShareData },
                });
                publicShareTokenRef.current = merged.cachedToken;
                return merged.publicShare;
            });
        } catch (error) {
            console.error('Failed to load public share:', error);
        }

        // Load friends list
        try {
            const friendsData = await getFriendsList(credentials);
            setFriends(friendsData);
        } catch (error) {
            console.error('Failed to load friends list:', error);
        }
    }, [canManage, sessionId, sharingPresentation.shareable]);

    useEffect(() => {
        loadSharingData();
    }, [loadSharingData]);

    // Handle adding a new share
    const handleAddShare = useCallback(async (userId: string, accessLevel: ShareAccessLevel, canApprovePermissions?: boolean) => {
        try {
            const currentSession = assertCurrentSessionSharingMutationAuthority(sessionId);
            const credentials = sync.getCredentials();

            const friend = friends.find(f => f.id === userId);
            if (!friend) {
                throw new HappyError(t('errors.operationFailed'), false);
            }
            const sessionEncryptionMode = currentSession.encryptionMode === 'plain' ? 'plain' : 'e2ee';

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

            assertCurrentSessionSharingMutationAuthority(sessionId);
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
            if (error instanceof HappyError) throw error;
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [friends, sessionId, loadSharingData]);

    // Handle updating share access level
    const handleUpdateShare = useCallback(async (shareId: string, patch: { accessLevel?: ShareAccessLevel; canApprovePermissions?: boolean }) => {
        try {
            assertCurrentSessionSharingMutationAuthority(sessionId);
            const credentials = sync.getCredentials();
            await updateSessionShare(credentials, sessionId, shareId, patch);
            await loadSharingData();
        } catch (error) {
            if (error instanceof HappyError) throw error;
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    // Handle removing a share
    const handleRemoveShare = useCallback(async (shareId: string) => {
        try {
            assertCurrentSessionSharingMutationAuthority(sessionId);
            const credentials = sync.getCredentials();
            await deleteSessionShare(credentials, sessionId, shareId);
            await loadSharingData();
        } catch (error) {
            if (error instanceof HappyError) throw error;
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
            const currentSession = assertCurrentSessionSharingMutationAuthority(sessionId);
            const credentials = sync.getCredentials();

            const sessionEncryptionMode = currentSession.encryptionMode === 'plain' ? 'plain' : 'e2ee';

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
                api: {
                    createPublicShare: async (...args) => {
                        assertCurrentSessionSharingMutationAuthority(sessionId);
                        return await createPublicShare(...args);
                    },
                },
            });

            setPublicShare(created);
            await loadSharingData();
            return created;
        } catch (error) {
            if (error instanceof HappyError) throw error;
            console.error('Failed to create public share:', error);
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    // Handle deleting public share
    const handleDeletePublicShare = useCallback(async () => {
        try {
            assertCurrentSessionSharingMutationAuthority(sessionId);
            const credentials = sync.getCredentials();
            await deletePublicShare(credentials, sessionId);
            publicShareTokenRef.current = null;
            await loadSharingData();
        } catch (error) {
            if (error instanceof HappyError) throw error;
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sessionId, loadSharingData]);

    if (!session) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="trash-outline" size={48} color={theme.colors.text.secondary} />
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
        void trackSharingModal(openFriendSelectorModal({
            friends,
            excludedUserIds,
            onSelect: handleAddShare,
            canManagePermissionDelegation,
        }));
    }, [canManagePermissionDelegation, excludedUserIds, friends, handleAddShare, trackSharingModal]);

    const openPublicLink = useCallback(() => {
        void trackSharingModal(openPublicLinkDialog({
            publicShare,
            onCreate: handleCreatePublicShare,
            onDelete: handleDeletePublicShare,
        }));
    }, [handleCreatePublicShare, handleDeletePublicShare, publicShare, trackSharingModal]);

    const openShareDialog = useCallback(() => {
        void trackSharingModal(openSessionShareDialog({
            sessionId,
            shares,
            canManage,
            canManagePermissionDelegation,
            onAddShare: openFriendSelector,
            onUpdateShare: handleUpdateShare,
            onRemoveShare: handleRemoveShare,
            onManagePublicLink: openPublicLink,
        }));
    }, [
        canManage,
        canManagePermissionDelegation,
        handleRemoveShare,
        handleUpdateShare,
        openFriendSelector,
        openPublicLink,
        sessionId,
        shares,
        trackSharingModal,
    ]);

    if (!canManage) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="lock-closed-outline" size={48} color={theme.colors.text.secondary} />
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

    if (!sharingPresentation.shareable) {
        const machineName = sharingPresentation.machineName ?? t('status.unknown');
        const reason = sharingPresentation.state === 'requires_persisted_import'
            ? t('externalSessions.sharingTranscriptOnMachine', { machine: machineName })
            : sharingPresentation.state === 'import_incomplete'
                ? t('externalSessions.sharingImportIncomplete')
                : t('externalSessions.sharingTranscriptUnavailable');
        const actionTitle = sharingPresentation.action === 'resume_awaiting_action_owner'
            ? t('externalSessions.operationActionResume')
            : sharingPresentation.action === 'import_awaiting_action_owner'
                ? t('externalSessions.operationTitleMaterialize')
                : null;

        return (
            <ItemList>
                <ItemGroup title={t('session.sharing.directSharing')}>
                    <Item
                        title={t('session.sharing.addShare')}
                        subtitle={reason}
                        icon={<Ionicons name="people-outline" size={29} color={theme.colors.text.secondary} />}
                        disabled
                        showChevron={false}
                        accessibilityLabel={`${t('session.sharing.addShare')}. ${reason}`}
                    />
                </ItemGroup>
                <ItemGroup title={t('session.sharing.publicLink')}>
                    <Item
                        title={t('session.sharing.createPublicLink')}
                        subtitle={reason}
                        icon={<Ionicons name="link-outline" size={29} color={theme.colors.text.secondary} />}
                        disabled
                        showChevron={false}
                        accessibilityLabel={`${t('session.sharing.createPublicLink')}. ${reason}`}
                    />
                </ItemGroup>
                {actionTitle ? (
                    <ItemGroup>
                        <Item
                            title={actionTitle}
                            subtitle={reason}
                            icon={<Ionicons name="cloud-upload-outline" size={29} color={theme.colors.text.secondary} />}
                            disabled={
                                materializeInFlight
                                || sharingPresentation.action !== 'import_awaiting_action_owner'
                                || !machine
                                || !isMachineOnline(machine)
                            }
                            onPress={sharingPresentation.action === 'import_awaiting_action_owner'
                                ? startMaterialization
                                : undefined}
                            showChevron={sharingPresentation.action === 'import_awaiting_action_owner'}
                        />
                    </ItemGroup>
                ) : null}
            </ItemList>
        );
    }

    return (
        <>
            <ItemList>
                {/* Current Shares */}
                <ItemGroup title={t('session.sharing.directSharing')}>
                    {shares.length > 0 ? (
                        shares.map(share => (
                            <Item
                                key={share.id}
                                title={share.sharedWithUser.username || [share.sharedWithUser.firstName, share.sharedWithUser.lastName].filter(Boolean).join(' ')}
                                subtitle={`@${share.sharedWithUser.username} • ${t(`session.sharing.${share.accessLevel === 'view' ? 'viewOnly' : share.accessLevel === 'edit' ? 'canEdit' : 'canManage'}`)}`}
                                icon={<Ionicons name="person-outline" size={29} color={theme.colors.accent.blue} />}
                                onPress={openShareDialog}
                            />
                        ))
                    ) : (
                        <Item
                            title={t('session.sharing.noShares')}
                            icon={<Ionicons name="people-outline" size={29} color={theme.colors.text.secondary} />}
                            showChevron={false}
                        />
                    )}
                    {canManage && (
                        <Item
                            title={t('session.sharing.addShare')}
                            icon={<Ionicons name="person-add-outline" size={29} color={theme.colors.state.success.foreground} />}
                            onPress={openFriendSelector}
                        />
                    )}
                </ItemGroup>

                {/* Public Link */}
                <ItemGroup title={t('session.sharing.publicLink')}>
                    {sharingPresentation.state === 'shared_snapshot_stale'
                        && sharingPresentation.materializedThroughSourceAt !== null ? (
                        <Item
                            title={t('externalSessions.sharingSharedUpTo', {
                                time: formatShortRelativeTimeAt(
                                    sharingPresentation.materializedThroughSourceAt,
                                    sharingPresentationNowMs,
                                ),
                            })}
                            subtitle={t('externalSessions.sharingActionAwaitingAvailability')}
                            icon={<Ionicons name="time-outline" size={29} color={theme.colors.text.secondary} />}
                            mode="info"
                            showChevron={false}
                        />
                    ) : null}
                    {publicShare ? (
                        <Item
                            title={t('session.sharing.publicLinkActive')}
                            subtitle={publicShare.expiresAt
                                ? t('session.sharing.expiresOn') + ': ' + new Date(publicShare.expiresAt).toLocaleDateString()
                                : t('session.sharing.never')
                            }
                            icon={<Ionicons name="link-outline" size={29} color={theme.colors.state.success.foreground} />}
                            onPress={openPublicLink}
                        />
                    ) : (
                        <Item
                            title={t('session.sharing.createPublicLink')}
                            subtitle={t('session.sharing.publicLinkDescription')}
                            icon={<Ionicons name="link-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={openPublicLink}
                        />
                    )}
                    {sharingPresentation.state === 'shared_snapshot_stale' ? (
                        <Item
                            title={t('externalSessions.sharingUpdateSharedCopy')}
                            icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.text.secondary} />}
                            disabled={materializeInFlight || !machine || !isMachineOnline(machine)}
                            onPress={startMaterialization}
                        />
                    ) : null}
                </ItemGroup>
            </ItemList>
        </>
    );
}

export default memo(() => {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params), [params]);
    const { id } = params;
    const sessionId = normalizeSessionId(id);
    const routeHydrationState = useHydrateSessionForRoute(
        sessionId,
        'SessionSharingRoute.ensureSessionVisible',
        routeScope.hydrationOptions,
    );
    const sessionHydrated = isSessionRouteHydrationAvailable(routeHydrationState);
    const headerTitle = t('session.sharing.title');
    const screenOptions = React.useMemo(() => ({ headerTitle }), [headerTitle]);

    if (!sessionId || isSessionRouteHydrationMissing(routeHydrationState)) {
        return <SessionInvalidLinkFallback />;
    }

    if (!sessionHydrated) {
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
            <SharingManagementContent
                sessionId={sessionId}
                serverId={routeScope.serverId}
            />
        </>
    );
});
