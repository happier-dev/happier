import * as React from 'react';
import { useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';

import { executeSessionBulkAction } from '@/components/sessions/actions/sessionBulkActionExecution';
import { useSessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';
import {
    SESSION_BULK_ACTION_IDS,
    type SessionBulkActionTarget,
} from '@/components/sessions/actions/sessionBulkActionTypes';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useInboxFriendRequests } from '@/hooks/inbox/useInboxFriendRequests';
import { useInboxSessionState } from '@/hooks/inbox/useInboxSessionState';
import { resolveInboxHasContent } from '@/hooks/inbox/useInboxSummary';
import { Modal } from '@/modal';
import { sessionSetManualReadStateWithServerScope } from '@/sync/ops';
import { useArtifacts, useFriendsLoaded, useMachineDisplayById } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionOrganizationProjection } from '@/sync/domains/session/organization';
import { normalizeSessionListKeyParts } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { isOpenApprovalInboxArtifact, readApprovalServerId } from '@/sync/domains/artifacts/approvalArtifacts';
import { t } from '@/text';
import { trackFriendsProfileView } from '@/track';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';

import { openActionOperationDetail } from './actionOperations/openActionOperationDetail';
import { useActionOperationActivityModel } from './actionOperations/useActionOperationActivityModel';
import { buildInboxSessionContextByKey } from './inboxSessionContextPresentation';

const EMPTY_RECORD: Readonly<Record<string, never>> = {};

function readOrganizationSnapshot(state: ReturnType<typeof storage.getState>) {
    return {
        schemaVersionByServerId: state.sessionOrganizationSchemaVersionByServerId ?? EMPTY_RECORD,
        snapshotVersionByServerId: state.sessionOrganizationSnapshotVersionByServerId ?? EMPTY_RECORD,
        pinsBySessionKey: state.sessionOrganizationPinsBySessionKey ?? EMPTY_RECORD,
        foldersByFolderKey: state.sessionOrganizationFoldersByFolderKey ?? EMPTY_RECORD,
        folderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey ?? EMPTY_RECORD,
        tagsByTagKey: state.sessionOrganizationTagsByTagKey ?? EMPTY_RECORD,
        tagAssignmentsBySessionKey: state.sessionOrganizationTagAssignmentsBySessionKey ?? EMPTY_RECORD,
        attentionStandingsBySessionKey: state.sessionOrganizationAttentionStandingsBySessionKey ?? EMPTY_RECORD,
        appearancesBySessionKey: state.sessionOrganizationAppearancesBySessionKey ?? EMPTY_RECORD,
        sessionAppearancesSupportedByServerId: state.sessionOrganizationSessionAppearancesSupportedByServerId ?? EMPTY_RECORD,
        orderEntriesByScopeKey: state.sessionOrganizationOrderEntriesByScopeKey ?? EMPTY_RECORD,
        labelsByLabelKey: state.sessionOrganizationLabelsByLabelKey ?? EMPTY_RECORD,
    };
}

export function useInboxContentModel() {
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const friends = useInboxFriendRequests();
    const artifacts = useArtifacts();
    const friendsLoaded = useFriendsLoaded();
    const machines = useMachineDisplayById();
    const organizationSnapshot = storage(useShallow(readOrganizationSnapshot));
    const actionOperationModel = useActionOperationActivityModel();
    const sessionState = useInboxSessionState();
    const sessionListIdentityDisplay = useSessionListIdentityDisplay();
    const [pendingReadKeys, setPendingReadKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const pendingReadKeysRef = React.useRef<ReadonlySet<string>>(pendingReadKeys);

    const openApprovals = React.useMemo(
        () => artifacts.filter(isOpenApprovalInboxArtifact),
        [artifacts],
    );
    const appearanceContext = React.useMemo(() => {
        const serverIds = new Set<string>();
        for (const entry of sessionState.sessionByKey.values()) {
            if (entry.serverId) serverIds.add(entry.serverId);
        }
        const sessionColorsByKey = new Map<string, SessionAppearanceColor>();
        for (const serverId of serverIds) {
            const projection = buildSessionOrganizationProjection(organizationSnapshot, serverId);
            for (const [sessionId, color] of Object.entries(projection.appearancesBySessionId ?? {})) sessionColorsByKey.set(`${serverId}:${sessionId}`, color);
        }
        return { workspaceLabelsByLabelKey: organizationSnapshot.labelsByLabelKey, sessionColorsByKey };
    }, [organizationSnapshot, sessionState.sessionByKey]);
    const sessionContextByKey = React.useMemo(() => buildInboxSessionContextByKey({
        sessionByKey: sessionState.sessionByKey,
        machines,
        ...appearanceContext,
    }), [machines, sessionState.sessionByKey, appearanceContext]);
    const approvalContextByArtifactId = React.useMemo(() => {
        const result = new Map<string, Readonly<{
            sessionTitle: string;
            machineLabel: string | null;
            workspaceName: string | null;
            appearanceColor: SessionAppearanceColor | null;
        }>>();
        for (const artifact of openApprovals) {
            const sessionId = typeof artifact.header?.sessionId === 'string' ? artifact.header.sessionId.trim() : '';
            const serverId = readApprovalServerId(artifact) || null;
            const key = normalizeSessionListKeyParts(serverId, sessionId).sessionKey ?? sessionId;
            const entry = key ? sessionState.sessionByKey.get(key) : null;
            const context = key ? sessionContextByKey.get(key) : null;
            if (!entry) continue;
            result.set(artifact.id, {
                sessionTitle: getSessionName(entry.session),
                machineLabel: context?.machineLabel ?? null,
                workspaceName: context?.workspaceName ?? null,
                appearanceColor: context?.appearanceColor ?? null,
            });
        }
        return result;
    }, [openApprovals, sessionContextByKey, sessionState.sessionByKey]);
    const targetBySessionKey = React.useMemo(
        () => new Map(sessionState.markAllReadTargets.map((target) => [target.key, target] as const)),
        [sessionState.markAllReadTargets],
    );
    const showFriendsActivity = friends.visible;
    const friendRequests = friends.requests;
    const isFriendsLoading = showFriendsActivity && !friendsLoaded;
    const hasPrimaryAttention = resolveInboxHasContent({
        hasOpenApprovals: openApprovals.length > 0,
        hasSessionContent: sessionState.sessionsNeedingAttention.length > 0
            || sessionState.reviewSessions.length > 0,
        hasVisibleFriendRequests: showFriendsActivity && friendRequests.length > 0,
        hasActionOperationAttention: actionOperationModel.inboxEntries.length > 0,
    });
    const showCaughtUp = !isFriendsLoading && !hasPrimaryAttention;
    const markAllPending = sessionState.markAllReadTargets.length > 0
        && sessionState.markAllReadTargets.every((target) => pendingReadKeys.has(target.key));

    const applyPendingReadKeys = React.useCallback((next: ReadonlySet<string>) => {
        pendingReadKeysRef.current = next;
        setPendingReadKeys(next);
    }, []);
    const markRead = React.useCallback(async (requested: readonly SessionBulkActionTarget[]) => {
        const targets = requested.filter((target) => !pendingReadKeysRef.current.has(target.key));
        if (targets.length === 0) return;
        const requestedKeys = new Set(targets.map((target) => target.key));
        applyPendingReadKeys(new Set([...pendingReadKeysRef.current, ...requestedKeys]));
        try {
            const result = await executeSessionBulkAction({
                action: { id: SESSION_BULK_ACTION_IDS.markRead },
                targets,
                context: {
                    setManualReadState: async (target, readState) => (
                        await sessionSetManualReadStateWithServerScope(target.sessionId, readState, {
                            serverId: target.serverId,
                        })
                    ),
                },
            });
            if (result.failed.length > 0) {
                Modal.alert(t('common.error'), t('sessionInfo.failedToMarkSessionRead'));
            }
        } catch {
            Modal.alert(t('common.error'), t('sessionInfo.failedToMarkSessionRead'));
        } finally {
            const next = new Set(pendingReadKeysRef.current);
            for (const key of requestedKeys) next.delete(key);
            applyPendingReadKeys(next);
        }
    }, [applyPendingReadKeys]);

    const openSession = React.useCallback((sessionId: string, serverId: string | null) => {
        void navigateToSession(sessionId, { serverId });
    }, [navigateToSession]);
    const openApproval = React.useCallback((artifactId: string) => {
        router.push(`/inbox/approvals/${artifactId}`);
    }, [router]);
    const openFriend = React.useCallback((friendId: string) => {
        trackFriendsProfileView();
        router.push(`/user/${friendId}`);
    }, [router]);
    const openOperation = React.useCallback((operationId: string) => {
        openActionOperationDetail(operationId);
    }, []);
    const openInbox = React.useCallback(() => {
        router.push('/(app)/inbox');
    }, [router]);

    return React.useMemo(() => ({
        ...sessionState,
        actionOperationModel,
        friendRequests,
        hasContent: hasPrimaryAttention,
        isFriendsLoading,
        markAllPending,
        openApprovals,
        approvalContextByArtifactId,
        pendingReadKeys,
        sessionContextByKey,
        sessionListIdentityDisplay,
        showCaughtUp,
        showFriendsActivity,
        targetBySessionKey,
        markRead,
        openApproval,
        openFriend,
        openInbox,
        openOperation,
        openSession,
    }), [
        actionOperationModel,
        friendRequests,
        hasPrimaryAttention,
        isFriendsLoading,
        markAllPending,
        markRead,
        openApproval,
        openApprovals,
        approvalContextByArtifactId,
        openFriend,
        openInbox,
        openOperation,
        openSession,
        pendingReadKeys,
        sessionContextByKey,
        sessionListIdentityDisplay,
        sessionState,
        showCaughtUp,
        showFriendsActivity,
        targetBySessionKey,
    ]);
}

export type InboxContentModel = ReturnType<typeof useInboxContentModel>;
