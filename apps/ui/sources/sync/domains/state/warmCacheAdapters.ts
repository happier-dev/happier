import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import type {
    MachineDisplayCacheEntryV1,
    SessionListCacheEntryV1,
} from './warmCachePersistence';

const EMPTY_WARM_CACHE_ENTRIES: Record<string, never> = {};
const EMPTY_SESSION_LIST_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<string, SessionListCacheEntryV1>;
const EMPTY_MACHINE_DISPLAY_CACHE_ENTRIES = EMPTY_WARM_CACHE_ENTRIES as Record<string, MachineDisplayCacheEntryV1>;

function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function normalizeBoolean(value: boolean | undefined): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function hasNonEmptyString(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

export function isSessionListCacheEntryMetadataUsable(entry: SessionListCacheEntryV1 | undefined): entry is SessionListCacheEntryV1 {
    if (!entry) return false;
    return hasNonEmptyString(entry.name)
        || hasNonEmptyString(entry.path)
        || hasNonEmptyString(entry.host)
        || hasNonEmptyString(entry.machineId)
        || hasNonEmptyString(entry.flavor)
        || entry.directSessionV1 != null
        || entry.hiddenSystemSession === true;
}

function areDirectSessionCacheEntriesEqual(
    next: SessionListCacheEntryV1['directSessionV1'],
    previous: SessionListCacheEntryV1['directSessionV1'],
): boolean {
    if (next === previous) return true;
    if (!next || !previous) return (next ?? null) === (previous ?? null);
    return next.v === previous.v && next.providerId === previous.providerId;
}

function areSessionListCacheEntriesEqual(
    nextEntry: SessionListCacheEntryV1,
    previousEntry: SessionListCacheEntryV1,
): boolean {
    return (
        nextEntry.seq === previousEntry.seq
        && nextEntry.metadataVersion === previousEntry.metadataVersion
        && nextEntry.agentStateVersion === previousEntry.agentStateVersion
        && nextEntry.updatedAt === previousEntry.updatedAt
        && nextEntry.createdAt === previousEntry.createdAt
        && nextEntry.active === previousEntry.active
        && nextEntry.activeAt === previousEntry.activeAt
        && nextEntry.archivedAt === previousEntry.archivedAt
        && nextEntry.lastViewedSessionSeq === previousEntry.lastViewedSessionSeq
        && nextEntry.pendingCount === previousEntry.pendingCount
        && nextEntry.pendingVersion === previousEntry.pendingVersion
        && nextEntry.accessLevel === previousEntry.accessLevel
        && nextEntry.canApprovePermissions === previousEntry.canApprovePermissions
        && nextEntry.name === previousEntry.name
        && nextEntry.summaryText === previousEntry.summaryText
        && nextEntry.path === previousEntry.path
        && nextEntry.homeDir === previousEntry.homeDir
        && nextEntry.host === previousEntry.host
        && nextEntry.machineId === previousEntry.machineId
        && nextEntry.flavor === previousEntry.flavor
        && areDirectSessionCacheEntriesEqual(nextEntry.directSessionV1, previousEntry.directSessionV1)
        && nextEntry.hiddenSystemSession === previousEntry.hiddenSystemSession
        && nextEntry.keepVisibleWhenInactive === previousEntry.keepVisibleWhenInactive
        && nextEntry.hasPendingPermissionRequests === previousEntry.hasPendingPermissionRequests
        && nextEntry.hasPendingUserActionRequests === previousEntry.hasPendingUserActionRequests
        && nextEntry.hasUnreadMessages === previousEntry.hasUnreadMessages
    );
}

function areMachineDisplayCacheEntriesEqual(
    nextEntry: MachineDisplayCacheEntryV1,
    previousEntry: MachineDisplayCacheEntryV1,
): boolean {
    return (
        nextEntry.metadataVersion === previousEntry.metadataVersion
        && nextEntry.updatedAt === previousEntry.updatedAt
        && nextEntry.active === previousEntry.active
        && nextEntry.activeAt === previousEntry.activeAt
        && nextEntry.revokedAt === previousEntry.revokedAt
        && nextEntry.displayName === previousEntry.displayName
        && nextEntry.host === previousEntry.host
        && nextEntry.homeDir === previousEntry.homeDir
    );
}

function countOwnEntries(record: Readonly<Record<string, unknown>> | null | undefined): number {
    let count = 0;
    const source = record ?? {};
    for (const key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            count += 1;
        }
    }
    return count;
}

export function buildSessionListRenderableFromCacheEntry(entry: SessionListCacheEntryV1): SessionListRenderableSession {
    const metadataUsable = isSessionListCacheEntryMetadataUsable(entry);
    return {
        id: entry.sessionId,
        seq: normalizeNonNegativeInteger(entry.seq) ?? 0,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        active: entry.active,
        activeAt: entry.activeAt,
        archivedAt: entry.archivedAt,
        pendingCount: entry.pendingCount,
        pendingVersion: entry.pendingVersion,
        lastViewedSessionSeq: normalizeNonNegativeInteger(entry.lastViewedSessionSeq),
        metadataVersion: entry.metadataVersion,
        agentStateVersion: entry.agentStateVersion,
        metadata: metadataUsable ? {
            name: entry.name,
            summaryText: entry.summaryText ?? null,
            path: entry.path,
            homeDir: entry.homeDir ?? null,
            host: entry.host ?? null,
            machineId: entry.machineId ?? null,
            flavor: entry.flavor ?? null,
            directSessionV1: entry.directSessionV1 ?? null,
            hiddenSystemSession: entry.hiddenSystemSession === true,
        } : null,
        thinking: false,
        thinkingAt: 0,
        presence: entry.active ? 'online' : entry.activeAt,
        accessLevel: entry.accessLevel,
        canApprovePermissions: entry.canApprovePermissions,
        keepVisibleWhenInactive: entry.keepVisibleWhenInactive === true,
        hasPendingPermissionRequests: entry.hasPendingPermissionRequests === true,
        hasPendingUserActionRequests: entry.hasPendingUserActionRequests === true,
        hasUnreadMessages: normalizeBoolean(entry.hasUnreadMessages),
        metadataUnavailable: !metadataUsable,
    };
}

function shouldPreserveSessionMetadataFromPreviousEntry(
    session: SessionListRenderableSession,
    previousEntry: SessionListCacheEntryV1 | undefined,
): previousEntry is SessionListCacheEntryV1 {
    return session.metadata == null
        && session.metadataUnavailable !== true
        && isSessionListCacheEntryMetadataUsable(previousEntry);
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

function shouldPreserveSessionReadStateFromPreviousEntry(
    session: SessionListRenderableSession,
    previousEntry: SessionListCacheEntryV1 | undefined,
): previousEntry is SessionListCacheEntryV1 {
    return (
        typeof session.lastViewedSessionSeq !== 'number'
        && typeof session.hasUnreadMessages !== 'boolean'
        && Boolean(previousEntry)
    );
}

export function buildSessionListCacheEntryFromRenderable(
    session: SessionListRenderableSession,
    previousEntry?: SessionListCacheEntryV1,
): SessionListCacheEntryV1 {
    const preserveMetadata = shouldPreserveSessionMetadataFromPreviousEntry(session, previousEntry);
    const preserveAgentState = shouldPreserveSessionAgentStateFromPreviousEntry(session, previousEntry);
    const preserveReadState = shouldPreserveSessionReadStateFromPreviousEntry(session, previousEntry);

    const nextEntry: SessionListCacheEntryV1 = {
        sessionId: session.id,
        seq: preserveReadState ? previousEntry.seq : normalizeNonNegativeInteger(session.seq) ?? 0,
        metadataVersion: preserveMetadata ? previousEntry.metadataVersion : session.metadataVersion,
        agentStateVersion: preserveAgentState ? previousEntry.agentStateVersion : session.agentStateVersion,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        lastViewedSessionSeq: preserveReadState
            ? previousEntry.lastViewedSessionSeq ?? null
            : normalizeNonNegativeInteger(session.lastViewedSessionSeq),
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
        keepVisibleWhenInactive: session.keepVisibleWhenInactive === true,
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
        hasUnreadMessages: preserveReadState
            ? normalizeBoolean(previousEntry.hasUnreadMessages)
            : normalizeBoolean(session.hasUnreadMessages),
    };

    return previousEntry && areSessionListCacheEntriesEqual(nextEntry, previousEntry) ? previousEntry : nextEntry;
}

export function buildSessionListCacheEntriesFromRenderables(
    sessions: Record<string, SessionListRenderableSession>,
    previousEntries?: Record<string, SessionListCacheEntryV1>,
): Record<string, SessionListCacheEntryV1> {
    const sessionIds = Object.keys(sessions);
    if (sessionIds.length === 0) {
        return previousEntries && countOwnEntries(previousEntries) === 0 ? previousEntries : EMPTY_SESSION_LIST_CACHE_ENTRIES;
    }

    if (!previousEntries) {
        const nextEntries: Record<string, SessionListCacheEntryV1> = {};
        for (const sessionId of sessionIds) {
            const session = sessions[sessionId];
            nextEntries[sessionId] = buildSessionListCacheEntryFromRenderable(session);
        }
        return nextEntries;
    }

    let nextEntries = previousEntries;
    let didChange = false;

    for (const sessionId of sessionIds) {
        const session = sessions[sessionId];
        const previousEntry = previousEntries[sessionId];
        const nextEntry = buildSessionListCacheEntryFromRenderable(session, previousEntry);
        if (!previousEntry || nextEntry !== previousEntry) {
            if (!didChange) {
                nextEntries = { ...previousEntries };
                didChange = true;
            }
            nextEntries[sessionId] = nextEntry;
        }
    }

    if (countOwnEntries(previousEntries) !== sessionIds.length) {
        if (!didChange) {
            nextEntries = { ...previousEntries };
            didChange = true;
        }

        for (const previousSessionId in previousEntries) {
            if (
                Object.prototype.hasOwnProperty.call(previousEntries, previousSessionId)
                && sessions[previousSessionId] === undefined
            ) {
                delete nextEntries[previousSessionId];
            }
        }
    }

    return didChange ? nextEntries : previousEntries;
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

    const nextEntry: MachineDisplayCacheEntryV1 = {
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

    return previousEntry && areMachineDisplayCacheEntriesEqual(nextEntry, previousEntry) ? previousEntry : nextEntry;
}

export function buildMachineDisplayCacheEntriesFromRenderables(
    machines: Record<string, MachineDisplayRenderable>,
    previousEntries?: Record<string, MachineDisplayCacheEntryV1>,
): Record<string, MachineDisplayCacheEntryV1> {
    const machineIds = Object.keys(machines);
    if (machineIds.length === 0) {
        return previousEntries && countOwnEntries(previousEntries) === 0 ? previousEntries : EMPTY_MACHINE_DISPLAY_CACHE_ENTRIES;
    }

    if (!previousEntries) {
        const nextEntries: Record<string, MachineDisplayCacheEntryV1> = {};
        for (const machineId of machineIds) {
            const machine = machines[machineId];
            nextEntries[machineId] = buildMachineDisplayCacheEntryFromRenderable(machine);
        }
        return nextEntries;
    }

    let nextEntries = previousEntries;
    let didChange = false;

    for (const machineId of machineIds) {
        const machine = machines[machineId];
        const previousEntry = previousEntries[machineId];
        const nextEntry = buildMachineDisplayCacheEntryFromRenderable(machine, previousEntry);
        if (!previousEntry || nextEntry !== previousEntry) {
            if (!didChange) {
                nextEntries = { ...previousEntries };
                didChange = true;
            }
            nextEntries[machineId] = nextEntry;
        }
    }

    if (countOwnEntries(previousEntries) !== machineIds.length) {
        if (!didChange) {
            nextEntries = { ...previousEntries };
            didChange = true;
        }

        for (const previousMachineId in previousEntries) {
            if (
                Object.prototype.hasOwnProperty.call(previousEntries, previousMachineId)
                && machines[previousMachineId] === undefined
            ) {
                delete nextEntries[previousMachineId];
            }
        }
    }

    return didChange ? nextEntries : previousEntries;
}
