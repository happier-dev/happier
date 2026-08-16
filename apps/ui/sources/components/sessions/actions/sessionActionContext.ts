import { resolveSessionReadStateAction } from '@/sync/domains/session/readState/sessionReadState';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveTerminalControlServiceabilityPolicy } from '@happier-dev/protocol';
import {
    canContinueSessionWithFreshSpawn,
    canResumeSessionWithOptions,
    type ResumeCapabilityOptions,
    type SessionMetadata as ResumeSessionMetadata,
} from '@/agents/runtime/resumeCapabilities';

import type { SessionActionSession, SessionActionTarget } from './sessionActionTypes';

export function createSessionActionTarget(params: Readonly<{
    session: SessionActionSession;
    serverId?: string | null;
    currentUserId?: string | null;
    isConnected?: boolean;
    isPinned?: boolean;
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
    const terminalControlServiceability = 'terminalControlServiceabilityV1' in (session.metadata ?? {})
        ? (session.metadata as SessionListRenderableSession['metadata'])?.terminalControlServiceabilityV1
        : (session as Session).metadata?.terminal?.controlServiceabilityV1;
    const terminalControlPolicy = resolveTerminalControlServiceabilityPolicy(terminalControlServiceability);
    const hasPreservedTerminalHost = terminalControlPolicy.hostPresence === 'preserved';
    const hasStoppableTerminalHost = terminalControlPolicy.canRequestStop;
    const canStop = isOwnedByCurrentUser;
    const canArchive = hasAdminAccess && !isArchived && (!isActive || canStop);
    const hasWriteAccess = !session.accessLevel || session.accessLevel === 'edit' || session.accessLevel === 'admin';
    const resumeMetadata = session.metadata as ResumeSessionMetadata | null;
    const canResume = !isActive
        && hasWriteAccess
        && (
            canResumeSessionWithOptions(resumeMetadata, params.resumeCapabilityOptions)
            || canContinueSessionWithFreshSpawn(resumeMetadata, params.resumeCapabilityOptions)
        );

    return {
        session,
        sessionId: session.id,
        serverId: params.serverId ?? null,
        isActive,
        isArchived,
        isConnected: params.isConnected ?? isActive,
        hasStoppableTerminalHost,
        isPinned: params.isPinned === true,
        isOwnedByCurrentUser,
        hasAdminAccess,
        canStop,
        canArchive,
        canRename: hasAdminAccess,
        canResume,
        canDelete: isOwnedByCurrentUser && !isActive && !hasPreservedTerminalHost && params.isConnected !== true,
        readStateAction: isArchived
            ? { kind: 'none', visible: false }
            : resolveSessionReadStateAction(session),
    };
}
