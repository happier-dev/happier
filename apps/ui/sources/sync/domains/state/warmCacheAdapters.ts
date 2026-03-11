import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import type {
    MachineDisplayCacheEntryV1,
    SessionListCacheEntryV1,
} from './warmCachePersistence';

export function buildSessionListRenderableFromCacheEntry(entry: SessionListCacheEntryV1): SessionListRenderableSession {
    return {
        id: entry.sessionId,
        seq: 0,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        active: entry.active,
        activeAt: entry.activeAt,
        archivedAt: entry.archivedAt,
        pendingCount: entry.pendingCount,
        pendingVersion: entry.pendingVersion,
        metadataVersion: entry.metadataVersion,
        agentStateVersion: entry.agentStateVersion,
        metadata: {
            name: entry.name,
            summaryText: entry.summaryText ?? null,
            path: entry.path,
            homeDir: entry.homeDir ?? null,
            host: entry.host ?? null,
            machineId: entry.machineId ?? null,
            flavor: entry.flavor ?? null,
            directSessionV1: entry.directSessionV1 ?? null,
            hiddenSystemSession: entry.hiddenSystemSession === true,
        },
        thinking: false,
        thinkingAt: 0,
        presence: entry.active ? 'online' : entry.activeAt,
        accessLevel: entry.accessLevel,
        canApprovePermissions: entry.canApprovePermissions,
        hasPendingPermissionRequests: entry.hasPendingPermissionRequests === true,
        hasPendingUserActionRequests: entry.hasPendingUserActionRequests === true,
    };
}

function shouldPreserveSessionMetadataFromPreviousEntry(
    session: SessionListRenderableSession,
    previousEntry: SessionListCacheEntryV1 | undefined,
): previousEntry is SessionListCacheEntryV1 {
    return session.metadata == null && Boolean(previousEntry);
}

function shouldPreserveSessionAgentStateFromPreviousEntry(
    session: SessionListRenderableSession,
    previousEntry: SessionListCacheEntryV1 | undefined,
): previousEntry is SessionListCacheEntryV1 {
    return (
        typeof session.hasPendingPermissionRequests !== 'boolean'
        && typeof session.hasPendingUserActionRequests !== 'boolean'
        && Boolean(previousEntry)
    );
}

export function buildSessionListCacheEntryFromRenderable(
    session: SessionListRenderableSession,
    previousEntry?: SessionListCacheEntryV1,
): SessionListCacheEntryV1 {
    const preserveMetadata = shouldPreserveSessionMetadataFromPreviousEntry(session, previousEntry);
    const preserveAgentState = shouldPreserveSessionAgentStateFromPreviousEntry(session, previousEntry);

    return {
        sessionId: session.id,
        metadataVersion: preserveMetadata ? previousEntry.metadataVersion : session.metadataVersion,
        agentStateVersion: preserveAgentState ? previousEntry.agentStateVersion : session.agentStateVersion,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        pendingCount: session.pendingCount,
        pendingVersion: session.pendingVersion,
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        name: preserveMetadata ? previousEntry.name : session.metadata?.name,
        summaryText: preserveMetadata ? previousEntry.summaryText ?? null : session.metadata?.summaryText ?? null,
        path: preserveMetadata ? previousEntry.path : session.metadata?.path ?? '',
        homeDir: preserveMetadata ? previousEntry.homeDir ?? null : session.metadata?.homeDir ?? null,
        host: preserveMetadata ? previousEntry.host ?? null : session.metadata?.host ?? null,
        machineId: preserveMetadata ? previousEntry.machineId ?? null : session.metadata?.machineId ?? null,
        flavor: preserveMetadata ? previousEntry.flavor ?? null : session.metadata?.flavor ?? null,
        directSessionV1: preserveMetadata ? previousEntry.directSessionV1 ?? null : session.metadata?.directSessionV1 ?? null,
        hiddenSystemSession: preserveMetadata
            ? previousEntry.hiddenSystemSession === true
            : session.metadata?.hiddenSystemSession === true,
        hasPendingPermissionRequests: preserveAgentState
            ? previousEntry.hasPendingPermissionRequests === true
            : typeof session.hasPendingPermissionRequests === 'boolean'
                ? session.hasPendingPermissionRequests
                : undefined,
        hasPendingUserActionRequests: preserveAgentState
            ? previousEntry.hasPendingUserActionRequests === true
            : typeof session.hasPendingUserActionRequests === 'boolean'
                ? session.hasPendingUserActionRequests
                : undefined,
    };
}

export function buildSessionListCacheEntriesFromRenderables(
    sessions: Record<string, SessionListRenderableSession>,
    previousEntries?: Record<string, SessionListCacheEntryV1>,
): Record<string, SessionListCacheEntryV1> {
    return Object.fromEntries(
        Object.values(sessions).map((session) => [
            session.id,
            buildSessionListCacheEntryFromRenderable(session, previousEntries?.[session.id]),
        ]),
    );
}

export function buildMachineDisplayRenderableFromCacheEntry(entry: MachineDisplayCacheEntryV1): MachineDisplayRenderable {
    return {
        id: entry.machineId,
        updatedAt: entry.updatedAt,
        active: entry.active,
        activeAt: entry.activeAt,
        revokedAt: entry.revokedAt,
        metadataVersion: entry.metadataVersion,
        metadata: {
            displayName: entry.displayName ?? null,
            host: entry.host ?? null,
            homeDir: entry.homeDir ?? null,
        },
    };
}

function shouldPreserveMachineDisplayMetadataFromPreviousEntry(
    machine: MachineDisplayRenderable,
    previousEntry: MachineDisplayCacheEntryV1 | undefined,
): previousEntry is MachineDisplayCacheEntryV1 {
    return machine.metadata == null && Boolean(previousEntry);
}

export function buildMachineDisplayCacheEntryFromRenderable(
    machine: MachineDisplayRenderable,
    previousEntry?: MachineDisplayCacheEntryV1,
): MachineDisplayCacheEntryV1 {
    const preserveMetadata = shouldPreserveMachineDisplayMetadataFromPreviousEntry(machine, previousEntry);

    return {
        machineId: machine.id,
        metadataVersion: preserveMetadata ? previousEntry.metadataVersion : machine.metadataVersion,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        displayName: preserveMetadata ? previousEntry.displayName ?? null : machine.metadata?.displayName ?? null,
        host: preserveMetadata ? previousEntry.host ?? null : machine.metadata?.host ?? null,
        homeDir: preserveMetadata ? previousEntry.homeDir ?? null : machine.metadata?.homeDir ?? null,
    };
}

export function buildMachineDisplayCacheEntriesFromRenderables(
    machines: Record<string, MachineDisplayRenderable>,
    previousEntries?: Record<string, MachineDisplayCacheEntryV1>,
): Record<string, MachineDisplayCacheEntryV1> {
    return Object.fromEntries(
        Object.values(machines).map((machine) => [
            machine.id,
            buildMachineDisplayCacheEntryFromRenderable(machine, previousEntries?.[machine.id]),
        ]),
    );
}
