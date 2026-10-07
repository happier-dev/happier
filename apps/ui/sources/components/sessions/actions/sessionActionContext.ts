import { resolveSessionReadStateAction } from '@/sync/domains/session/readState/sessionReadState';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isSessionTerminalPermanentlyAbsent } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
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
    if (params.session.access?.capabilities.editSessionRecords !== true) {
        return { kind: 'none', visible: false };
    }
    return params.standing
        ? { kind: 'clear-standing', visible: true, targetStanding: false }
        : { kind: 'set-standing', visible: true, targetStanding: true };
}

export function createSessionActionTarget(params: Readonly<{
    session: SessionActionSession;
    /** Exact same-Home Session whose owner metadata is not carried by a lightweight row. */
    ownerSession?: Session;
    serverId?: string | null;
    currentUserId?: string | null;
    isConnected?: boolean;
    isPinned?: boolean;
    attentionStandingEnabled?: boolean;
    attentionStanding?: boolean;
    followEnabled?: boolean;
    resumeCapabilityOptions?: ResumeCapabilityOptions;
}>): SessionActionTarget {
    const session = params.session;
    const serverId = typeof params.serverId === 'string' && params.serverId.trim()
        ? params.serverId.trim()
        : null;
    const isOwnedByCurrentUser = session.access?.role === 'owner';
    const canUnarchive = session.access?.capabilities.archiveSession === true;
    const isActive = session.active === true;
    const isArchived = session.archivedAt != null;
    const ownerSession = params.ownerSession ?? ('agentState' in session ? session : null);
    const ownerMetadata = ownerSession ? readSessionOwnerMetadataView(ownerSession) : null;
    const terminalControlServiceability = ownerSession
        ? ownerMetadata?.terminal?.controlServiceabilityV1
        : (session.metadata as SessionListRenderableSession['metadata'])?.terminalControlServiceabilityV1;
    const hasRecoverableTerminalHost = (
        terminalControlServiceability?.v === 1
        && terminalControlServiceability.state === 'recoverable_unservable'
    );
    const canStop = session.access?.capabilities.stopSession === true;
    const canArchive = session.access?.capabilities.archiveSession === true && !isArchived && (!isActive || canStop);
    const hasWriteAccess = session.access?.capabilities.submitAgentInput === true;
    const canResume = !isActive
        && hasWriteAccess
        && (
            canResumeSessionWithOptions(ownerMetadata, params.resumeCapabilityOptions)
            || canContinueSessionWithFreshSpawn(ownerMetadata, params.resumeCapabilityOptions)
        );
    const canUsePersonalReminder = serverId !== null
        && session.access?.capabilities.readTranscript === true;

    return {
        session,
        sessionId: session.id,
        serverId,
        isActive,
        isArchived,
        isConnected: params.isConnected ?? isActive,
        hasRecoverableTerminalHost,
        isPinned: params.isPinned === true,
        isOwnedByCurrentUser,
        canUnarchive,
        canStop,
        followEnabled: params.followEnabled === true,
        canArchive,
        canRename: session.access?.capabilities.renameSession === true,
        canResume,
        canDelete:
            session.access?.capabilities.deleteSession === true
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
        reminderAction: {
            canSchedule: canUsePersonalReminder && !isArchived,
            canClear: canUsePersonalReminder,
        },
    };
}
