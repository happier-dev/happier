import { resolveSessionReadStateAction } from '@/sync/domains/session/readState/sessionReadState';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isSessionTerminalPermanentlyAbsent } from '@happier-dev/protocol';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
    canContinueSessionWithFreshSpawn,
    canResumeSessionWithOptions,
    type ResumeCapabilityOptions,
} from '@/agents/runtime/resumeCapabilities';

import type { SessionActionSession, SessionActionTarget, SessionAttentionStandingAction } from './sessionActionTypes';

/**
 * Standing is a placement floor, so it only means something while there is an attention band to
 * hold the session in; `enabled` carries that decision from the surface. A view-only participant
 * cannot write session organization, so they are offered neither direction.
 */
export function resolveSessionAttentionStandingAction(params: Readonly<{
    session: SessionActionSession;
    enabled: boolean;
    standing: boolean;
}>): SessionAttentionStandingAction {
    if (!params.enabled) {
        return { kind: 'none', visible: false };
    }
    if (params.session.accessLevel === 'view') {
        return { kind: 'none', visible: false };
    }
    return params.standing
        ? { kind: 'clear-standing', visible: true, targetStanding: false }
        : { kind: 'set-standing', visible: true, targetStanding: true };
}

export function createSessionActionTarget(params: Readonly<{
    session: SessionActionSession;
    serverId?: string | null;
    currentUserId?: string | null;
    isConnected?: boolean;
    isPinned?: boolean;
    attentionStandingEnabled?: boolean;
    attentionStanding?: boolean;
    resumeCapabilityOptions?: ResumeCapabilityOptions;
}>): SessionActionTarget {
    const session = params.session;
    const sessionOwnerId = typeof session.owner === 'string' ? session.owner : null;
    const currentUserOwnsSession = (
        typeof params.currentUserId === 'string'
        && params.currentUserId.length > 0
        && sessionOwnerId === params.currentUserId
    );
    const isOwnedByCurrentUser = currentUserOwnsSession || (
        session.accessLevel == null
        && !sessionOwnerId
    );
    const hasAdminAccess = isOwnedByCurrentUser || session.accessLevel === 'admin';
    const isActive = session.active === true;
    const isArchived = session.archivedAt != null;
    const terminalControlServiceability = 'agentState' in session
        ? readSessionOwnerMetadataView(session)?.terminal?.controlServiceabilityV1
        : (session.metadata as SessionListRenderableSession['metadata'])?.terminalControlServiceabilityV1;
    const hasRecoverableTerminalHost = (
        terminalControlServiceability?.v === 1
        && terminalControlServiceability.state === 'recoverable_unservable'
    );
    const canStop = isOwnedByCurrentUser;
    const canArchive = hasAdminAccess && !isArchived && (!isActive || canStop);
    const ownerMetadata = 'agentState' in session
        ? readSessionOwnerMetadataView(session)
        : null;
    const hasWriteAccess = !session.accessLevel || session.accessLevel === 'edit' || session.accessLevel === 'admin';
    const canResume = !isActive
        && hasWriteAccess
        && (
            canResumeSessionWithOptions(ownerMetadata, params.resumeCapabilityOptions)
            || canContinueSessionWithFreshSpawn(ownerMetadata, params.resumeCapabilityOptions)
        );

    return {
        session,
        sessionId: session.id,
        serverId: params.serverId ?? null,
        isActive,
        isArchived,
        isConnected: params.isConnected ?? isActive,
        hasRecoverableTerminalHost,
        isPinned: params.isPinned === true,
        isOwnedByCurrentUser,
        hasAdminAccess,
        canStop,
        canArchive,
        canRename: hasAdminAccess,
        canResume,
        canDelete:
            isOwnedByCurrentUser
            && !isActive
            && params.isConnected !== true
            && isSessionTerminalPermanentlyAbsent(terminalControlServiceability),
        readStateAction: isArchived
            ? { kind: 'none', visible: false }
            : resolveSessionReadStateAction(session),
        attentionStandingAction: isArchived
            ? { kind: 'none', visible: false }
            : resolveSessionAttentionStandingAction({
                session,
                enabled: params.attentionStandingEnabled === true,
                standing: params.attentionStanding === true,
            }),
    };
}
