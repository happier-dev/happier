import React, { memo, useState, useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import {
    useActiveServerAccountScope,
    useMachineListByServerId,
    useMachineListStatusByServerId,
    useServerScopedMachine,
    useSession,
} from '@/sync/domains/state/storage';
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
import {
    machineExternalSessionMaterializeStart,
    machineExternalSessionOperationResume,
} from '@/sync/ops/machineExternalSessions';
import {
    presentExternalSessionOperationActionError,
} from '@/components/sessions/external/progress/externalSessionOperationActionErrorPresentation';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { readExternalSessionOperationPresentationFromMetadata } from '@/components/sessions/transcript/items/externalSessionOperationMetadata';
import { useExternalSessionOperationOwnerHydration } from '@/components/sessions/transcript/items/useExternalSessionOperationOwnerHydration';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { presentExternalSessionOperationProgress } from '@/components/sessions/external/progress/externalSessionOperationProgressPresentation';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

type SharingData = Readonly<{
    shares: SessionShare[];
    publicShare: PublicSessionShare | null;
    friends: UserProfile[];
}>;

type SharingDataState = Readonly<{
    scopeKey: string;
    data: SharingData | null;
    loading: boolean;
    error: boolean;
}>;

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
    const activeServerAccountScope = useActiveServerAccountScope();
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const externalSessionLink = React.useMemo(
        () => readExternalSessionLink(ownerMetadata),
        [ownerMetadata],
    );
    const machineScopeServerId = serverId ?? activeServerAccountScope?.serverId ?? null;
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const scopedMachineList = machineScopeServerId
        ? machineListByServerId[machineScopeServerId]
        : undefined;
    const sourceMachineListStatus = machineScopeServerId
        ? machineListStatusByServerId[machineScopeServerId]
        : undefined;
    const machineScopeSettled = machineScopeServerId === null
        || (sourceMachineListStatus === 'idle' && Array.isArray(scopedMachineList));
    const machine = useServerScopedMachine(
        machineScopeServerId,
        externalSessionLink?.machineId ?? '',
    );
    const sourceMachineReachability = !machineScopeSettled || machine === null
        ? null
        : isMachineOnline(machine);
    const operationPresentation = React.useMemo(
        () => readExternalSessionOperationPresentationFromMetadata(session?.metadata),
        [session?.metadata],
    );
    const operationMachineId = React.useMemo(
        () => resolveSessionMachineId(ownerMetadata),
        [ownerMetadata],
    );
    const operationMachine = useServerScopedMachine(
        machineScopeServerId,
        operationMachineId ?? '',
    );
    const isExactOwner = React.useMemo(() => session
        ? createSessionActionTarget({
            session,
            currentUserId: activeServerAccountScope?.accountId ?? null,
        }).isOwnedByCurrentUser
        : false, [activeServerAccountScope?.accountId, session]);
    const operationOwnerHydration = useExternalSessionOperationOwnerHydration({
        isExactOwner,
        machineId: operationMachineId,
        machineOnline: machineScopeSettled
            && operationMachine !== null
            && isMachineOnline(operationMachine),
        ownerScopeKey: activeServerAccountScope
            ? serverAccountScopeKeySuffix(activeServerAccountScope)
            : null,
        presentation: operationPresentation,
        serverId: machineScopeServerId,
        sessionId,
    });
    const transcriptAuthorityState = resolveExternalSessionTranscriptAuthorityState({
        linked: externalSessionLink !== null,
        agentReachable: externalSessionLink === null
            ? false
            : sourceMachineReachability,
        liveSourceKey: externalSessionLink
            ? createExternalSessionTranscriptLiveSourceKeyFromLink(externalSessionLink)
            : null,
        currentStorageState: session?.currentStorageState
            ?? (externalSessionLink ? 'legacy_external_unknown' : 'hosted'),
        acceptedThroughServerSeq: session?.acceptedThroughServerSeq ?? null,
        publishedThroughServerSeq: session?.publishedThroughServerSeq ?? null,
        materializedThroughSourceAt: session?.materializedThroughSourceAt ?? null,
        transcriptShareable: session?.transcriptShareable ?? null,
        operationPresentation,
        operationProgress: operationOwnerHydration.progress,
    });
    const sharingPresentation = resolveExternalSessionSharingPresentation({
        machineName: getMachineDisplayName(machine) ?? externalSessionLink?.machineId ?? null,
        sharing: transcriptAuthorityState.sharing,
    });
    const sharingPresentationNowMs = useSessionListRuntimeNowMs(
        sharingPresentation.state === 'shared_snapshot_stale',
    );
    const sourceMachineOnline = sourceMachineReachability === true;
    const sourceMachineUnavailableReason = sourceMachineOnline
        ? null
        : sourceMachineReachability === false
            ? t('externalSessions.sharingSourceMachineOffline')
            : machineScopeSettled && machineScopeServerId !== null
                ? t('externalSessions.sharingSourceMachineMissing')
                : t('externalSessions.sharingActionAwaitingAvailability');
    const updateSharedCopySubtitle = sourceMachineUnavailableReason
        ?? t('externalSessions.sharingUpdateSharedCopyDescription');
    const canManage = !session?.accessLevel || session.accessLevel === 'admin';

    const publicShareTokenRef = useRef<string | null>(null);
    const activeServerAccountScopeKey = activeServerAccountScope
        ? serverAccountScopeKeySuffix(activeServerAccountScope)
        : null;
    const sharingDataScopeKey = JSON.stringify([
        serverId,
        activeServerAccountScopeKey,
        sessionId,
    ]);
    const publicShareTokenScopeRef = useRef(sharingDataScopeKey);
    const currentSharingDataScopeRef = useRef(sharingDataScopeKey);
    currentSharingDataScopeRef.current = sharingDataScopeKey;
    const sharingDataRequestRevisionRef = useRef(0);
    const [sharingDataState, setSharingDataState] = useState<SharingDataState>({
        scopeKey: sharingDataScopeKey,
        data: null,
        loading: true,
        error: false,
    });
    const effectiveSharingDataState = sharingDataState.scopeKey === sharingDataScopeKey
        ? sharingDataState
        : {
            scopeKey: sharingDataScopeKey,
            data: null,
            loading: true,
            error: false,
        };
    const shares = effectiveSharingDataState.data?.shares ?? [];
    const publicShare = effectiveSharingDataState.data?.publicShare ?? null;
    const friends = effectiveSharingDataState.data?.friends ?? [];
    const materializeIdempotencyKeyRef = useRef<string | null>(null);
    const sharingMutationAllowed = canManage && sharingPresentation.shareable;
    const sharingMutationAllowedRef = useRef(sharingMutationAllowed);
    sharingMutationAllowedRef.current = sharingMutationAllowed;
    const openSharingModalIdsRef = useRef(new Set<string>());
    const trackSharingModal = useCallback(async (open: Promise<string>) => {
        const modalId = await open;
        if (
            !sharingMutationAllowedRef.current
            || currentSharingDataScopeRef.current !== sharingDataScopeKey
        ) {
            Modal.hide(modalId);
            return;
        }
        openSharingModalIdsRef.current.add(modalId);
    }, [sharingDataScopeKey]);
    const assertCurrentSharingDataScope = useCallback(() => {
        if (currentSharingDataScopeRef.current !== sharingDataScopeKey) {
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [sharingDataScopeKey]);
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
    const operationProgressPresentation = React.useMemo(() => (
        operationOwnerHydration.progress
            ? presentExternalSessionOperationProgress(operationOwnerHydration.progress, {
                observationContext: 'hydrated',
                originAvailability:
                    operationMachine !== null && isMachineOnline(operationMachine)
                        ? 'online'
                        : 'offline',
            })
            : null
    ), [operationMachine, operationOwnerHydration.progress]);
    const canResumePartialImport = sharingPresentation.action === 'resume_awaiting_action_owner'
        && operationPresentation !== null
        && operationOwnerHydration.progress !== null
        && operationOwnerHydration.progress.operationId === operationPresentation.operationId
        && operationOwnerHydration.progress.revision === operationPresentation.revision
        && operationProgressPresentation?.actions.some(
            (action) => action.kind === 'resume' && action.enabled,
        ) === true
        && operationMachineId !== null;
    const [resumeInFlight, resumePartialImport] = useHappyAction(
        useCallback(async () => {
            const progress = operationOwnerHydration.progress;
            if (!canResumePartialImport || !progress || !operationMachineId) {
                throw new HappyError(
                    t('externalSessions.operationActionErrorUnavailable'),
                    false,
                );
            }
            const result = await machineExternalSessionOperationResume({
                machineId: operationMachineId,
                sessionId,
                operationId: progress.operationId,
                revision: progress.revision,
            }, serverId ? { serverId } : undefined);
            if (!result.ok) {
                throw new HappyError(
                    t(presentExternalSessionOperationActionError(result.error.code)),
                    false,
                );
            }
            if (result.progress.operationId !== progress.operationId) {
                throw new HappyError(
                    t('externalSessions.operationActionErrorUnavailable'),
                    false,
                );
            }
            operationOwnerHydration.onActionResult(result.progress);
        }, [
            canResumePartialImport,
            operationMachineId,
            operationOwnerHydration,
            serverId,
            sessionId,
        ]),
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
        const requestRevision = ++sharingDataRequestRevisionRef.current;
        setSharingDataState((current) => current.scopeKey === sharingDataScopeKey
            ? { ...current, loading: true, error: false }
            : {
                scopeKey: sharingDataScopeKey,
                data: null,
                loading: true,
                error: false,
            });
        const credentials = sync.getCredentials();
        try {
            const [sharesData, publicShareData, friendsData] = await Promise.all([
                getSessionShares(credentials, sessionId),
                getPublicShare(credentials, sessionId),
                getFriendsList(credentials),
            ]);
            if (
                currentSharingDataScopeRef.current !== sharingDataScopeKey
                || sharingDataRequestRevisionRef.current !== requestRevision
            ) {
                return;
            }
            setSharingDataState((current) => {
                if (current.scopeKey !== sharingDataScopeKey) return current;
                const merged = mergePublicShareWithCachedToken({
                    previousPublicShare: current.data?.publicShare ?? null,
                    cachedToken: publicShareTokenRef.current,
                    outcome: { ok: true, publicShare: publicShareData },
                });
                publicShareTokenRef.current = merged.cachedToken;
                return {
                    scopeKey: sharingDataScopeKey,
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
            if (
                currentSharingDataScopeRef.current !== sharingDataScopeKey
                || sharingDataRequestRevisionRef.current !== requestRevision
            ) {
                return;
            }
            console.error('Failed to load sharing data:', error);
            setSharingDataState((current) => current.scopeKey === sharingDataScopeKey
                ? { ...current, loading: false, error: true }
                : current);
        }
    }, [
        canManage,
        sessionId,
        sharingDataScopeKey,
        sharingPresentation.shareable,
    ]);

    useEffect(() => {
        if (publicShareTokenScopeRef.current !== sharingDataScopeKey) {
            publicShareTokenScopeRef.current = sharingDataScopeKey;
            publicShareTokenRef.current = null;
            for (const modalId of openSharingModalIdsRef.current) {
                Modal.hide(modalId);
            }
            openSharingModalIdsRef.current.clear();
        }
        void loadSharingData();
        return () => {
            sharingDataRequestRevisionRef.current += 1;
        };
    }, [loadSharingData, sharingDataScopeKey]);

    // Handle adding a new share
    const handleAddShare = useCallback(async (userId: string, accessLevel: ShareAccessLevel, canApprovePermissions?: boolean) => {
        try {
            assertCurrentSharingDataScope();
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

            assertCurrentSharingDataScope();
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
    }, [assertCurrentSharingDataScope, friends, sessionId, loadSharingData]);

    // Handle updating share access level
    const handleUpdateShare = useCallback(async (shareId: string, patch: { accessLevel?: ShareAccessLevel; canApprovePermissions?: boolean }) => {
        try {
            assertCurrentSharingDataScope();
            assertCurrentSessionSharingMutationAuthority(sessionId);
            const credentials = sync.getCredentials();
            await updateSessionShare(credentials, sessionId, shareId, patch);
            await loadSharingData();
        } catch (error) {
            if (error instanceof HappyError) throw error;
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [assertCurrentSharingDataScope, sessionId, loadSharingData]);

    // Handle removing a share
    const handleRemoveShare = useCallback(async (shareId: string) => {
        try {
            assertCurrentSharingDataScope();
            assertCurrentSessionSharingMutationAuthority(sessionId);
            const credentials = sync.getCredentials();
            await deleteSessionShare(credentials, sessionId, shareId);
            await loadSharingData();
        } catch (error) {
            if (error instanceof HappyError) throw error;
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [assertCurrentSharingDataScope, sessionId, loadSharingData]);

    // Handle creating public share
    const handleCreatePublicShare = useCallback(async (options: {
        expiresInDays?: number;
        maxUses?: number;
        isConsentRequired: boolean;
    }): Promise<PublicSessionShare> => {
        try {
            assertCurrentSharingDataScope();
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
                        if (currentSharingDataScopeRef.current === sharingDataScopeKey) {
                            publicShareTokenRef.current = token;
                        }
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
                        assertCurrentSharingDataScope();
                        assertCurrentSessionSharingMutationAuthority(sessionId);
                        return await createPublicShare(...args);
                    },
                },
            });

            await loadSharingData();
            return created;
        } catch (error) {
            if (error instanceof HappyError) throw error;
            console.error('Failed to create public share:', error);
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [assertCurrentSharingDataScope, sessionId, loadSharingData, sharingDataScopeKey]);

    // Handle deleting public share
    const handleDeletePublicShare = useCallback(async () => {
        try {
            assertCurrentSharingDataScope();
            assertCurrentSessionSharingMutationAuthority(sessionId);
            const credentials = sync.getCredentials();
            await deletePublicShare(credentials, sessionId);
            if (currentSharingDataScopeRef.current === sharingDataScopeKey) {
                publicShareTokenRef.current = null;
            }
            await loadSharingData();
        } catch (error) {
            if (error instanceof HappyError) throw error;
            throw new HappyError(t('errors.operationFailed'), false);
        }
    }, [assertCurrentSharingDataScope, sessionId, loadSharingData, sharingDataScopeKey]);

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

    if (!sharingPresentation.shareable) {
        const machineName = sharingPresentation.machineName ?? t('status.unknown');
        const reason = sharingPresentation.state === 'requires_persisted_import'
            ? t('externalSessions.sharingTranscriptOnMachine', { machine: machineName })
            : sharingPresentation.state === 'import_incomplete'
                ? t('externalSessions.sharingImportIncomplete')
                : t('externalSessions.sharingTranscriptUnavailable');
        const actionTitle = sharingPresentation.action === 'import_awaiting_action_owner'
                ? t('externalSessions.operationTitleMaterialize')
                : null;
        const actionSubtitle = sourceMachineUnavailableReason ?? reason;

        return (
            <ItemList>
                <ItemGroup title={t('session.sharing.directSharing')}>
                    <Item
                        title={t('session.sharing.addShare')}
                        subtitle={reason}
                        icon={<Icon name="users" size={29} color={theme.colors.text.secondary} />}
                        disabled
                        showChevron={false}
                        accessibilityLabel={`${t('session.sharing.addShare')}. ${reason}`}
                    />
                </ItemGroup>
                <ItemGroup title={t('session.sharing.publicLink')}>
                    <Item
                        title={t('session.sharing.createPublicLink')}
                        subtitle={reason}
                        icon={<Icon name="link" size={29} color={theme.colors.text.secondary} />}
                        disabled
                        showChevron={false}
                        accessibilityLabel={`${t('session.sharing.createPublicLink')}. ${reason}`}
                    />
                </ItemGroup>
                {actionTitle ? (
                    <ItemGroup>
                        <Item
                            title={actionTitle}
                            subtitle={actionSubtitle}
                            icon={<Icon name="cloud-arrow-up" size={29} color={theme.colors.text.secondary} />}
                            disabled={
                                materializeInFlight
                                || sharingPresentation.action !== 'import_awaiting_action_owner'
                                || !sourceMachineOnline
                            }
                            onPress={sharingPresentation.action === 'import_awaiting_action_owner'
                                ? startMaterialization
                                : undefined}
                            showChevron={sharingPresentation.action === 'import_awaiting_action_owner'}
                            accessibilityLabel={`${actionTitle}. ${actionSubtitle}`}
                        />
                    </ItemGroup>
                ) : sharingPresentation.action === 'resume_awaiting_action_owner' ? (
                    <ItemGroup>
                        <Item
                            title={canResumePartialImport
                                ? t('externalSessions.operationActionResume')
                                : t('externalSessions.sharingImportIncomplete')}
                            subtitle={canResumePartialImport
                                ? reason
                                : t('externalSessions.sharingActionAwaitingAvailability')}
                            icon={<Icon name="cloud-arrow-up" size={29} color={theme.colors.text.secondary} />}
                            disabled={canResumePartialImport ? resumeInFlight : undefined}
                            onPress={canResumePartialImport ? resumePartialImport : undefined}
                            showChevron={canResumePartialImport}
                            mode={canResumePartialImport ? undefined : 'info'}
                        />
                    </ItemGroup>
                ) : null}
            </ItemList>
        );
    }

    if (effectiveSharingDataState.data === null) {
        return effectiveSharingDataState.loading ? (
            <SurfaceStateCard
                testID="session-sharing-load-state"
                kind="loading"
                accessibilitySemantics="status"
                title={t('common.loading')}
            />
        ) : (
            <SurfaceStateCard
                testID="session-sharing-load-state"
                kind="error"
                accessibilitySemantics="alert"
                title={t('errors.operationFailed')}
                action={{
                    label: t('common.retry'),
                    onPress: loadSharingData,
                }}
            />
        );
    }

    return (
        <>
            <ItemList>
                {effectiveSharingDataState.error ? (
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
                    {sharingPresentation.state === 'shared_snapshot_stale'
                        && sharingPresentation.materializedThroughSourceAt !== null ? (
                        <Item
                            title={t('externalSessions.sharingSharedUpTo', {
                                time: formatShortRelativeTimeAt(
                                    sharingPresentation.materializedThroughSourceAt,
                                    sharingPresentationNowMs,
                                ),
                            })}
                            icon={<Icon name="clock" size={29} color={theme.colors.text.secondary} />}
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
                    {sharingPresentation.state === 'shared_snapshot_stale' ? (
                        <Item
                            title={t('externalSessions.sharingUpdateSharedCopy')}
                            subtitle={updateSharedCopySubtitle}
                            icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.text.secondary} />}
                            disabled={materializeInFlight || !sourceMachineOnline}
                            onPress={startMaterialization}
                            accessibilityLabel={`${t('externalSessions.sharingUpdateSharedCopy')}. ${updateSharedCopySubtitle}`}
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
