import { areSessionListRenderablesEqual } from '../domains/session/listing/sessionListRenderable';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import type { ServerScopedSessionListCache } from '../domains/session/listing/serverScopedSessionListCache';
import type { SessionListViewItem } from '../domains/session/listing/sessionListViewData';
import { normalizeTrimmedString } from '../domains/session/listing/normalizeTrimmedString';

const EMPTY_SERVER_SCOPED_SESSION_LIST_CACHE: ServerScopedSessionListCache = {};

function areMachineDisplayRenderablesEqual(
    previous: MachineDisplayRenderable | null | undefined,
    next: MachineDisplayRenderable | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;

    return previous.id === next.id
        && previous.updatedAt === next.updatedAt
        && previous.active === next.active
        && previous.activeAt === next.activeAt
        && (previous.revokedAt ?? null) === (next.revokedAt ?? null)
        && previous.metadataVersion === next.metadataVersion
        && (previous.metadata?.displayName ?? null) === (next.metadata?.displayName ?? null)
        && (previous.metadata?.host ?? null) === (next.metadata?.host ?? null)
        && (previous.metadata?.homeDir ?? null) === (next.metadata?.homeDir ?? null);
}

export function areSessionListViewItemsEqual(previous: ReadonlyArray<SessionListViewItem> | null | undefined, next: ReadonlyArray<SessionListViewItem> | null | undefined): boolean {
    if (previous === next) return true;
    if (!Array.isArray(previous) || !Array.isArray(next)) return previous === next;
    if (previous.length !== next.length) return false;

    for (let index = 0; index < previous.length; index += 1) {
        const previousItem = previous[index];
        const nextItem = next[index];
        if (previousItem.type !== nextItem.type) return false;

        if (previousItem.type === 'session') {
            if (nextItem.type !== 'session') return false;
            if (
                previousItem.serverId !== nextItem.serverId
                || previousItem.serverName !== nextItem.serverName
                || previousItem.section !== nextItem.section
                || previousItem.groupKey !== nextItem.groupKey
                || previousItem.groupKind !== nextItem.groupKind
                || (previousItem.pinned === true) !== (nextItem.pinned === true)
                || previousItem.variant !== nextItem.variant
            ) {
                return false;
            }
            if (!areSessionListRenderablesEqual(previousItem.session, nextItem.session)) {
                return false;
            }
            continue;
        }

        if (nextItem.type !== 'header') return false;
        if (
            previousItem.title !== nextItem.title
            || previousItem.headerKind !== nextItem.headerKind
            || previousItem.groupKey !== nextItem.groupKey
            || previousItem.workspaceKey !== nextItem.workspaceKey
            || previousItem.serverId !== nextItem.serverId
            || previousItem.serverName !== nextItem.serverName
            || previousItem.subtitle !== nextItem.subtitle
        ) {
            return false;
        }

        const previousHint = previousItem.workspaceScopeHint ?? null;
        const nextHint = nextItem.workspaceScopeHint ?? null;
        if (
            (previousHint?.serverId ?? null) !== (nextHint?.serverId ?? null)
            || (previousHint?.machineId ?? null) !== (nextHint?.machineId ?? null)
            || (previousHint?.rootPath ?? null) !== (nextHint?.rootPath ?? null)
        ) {
            return false;
        }

        if (!areMachineDisplayRenderablesEqual(previousItem.machine ?? null, nextItem.machine ?? null)) {
            return false;
        }
    }

    return true;
}

export function setServerSessionListCache(
    current: ServerScopedSessionListCache,
    serverIdRaw: string,
    sessionListViewData: SessionListViewItem[] | null,
): ServerScopedSessionListCache {
    const serverId = normalizeTrimmedString(serverIdRaw);
    if (!serverId) {
        return current;
    }
    if (areSessionListViewItemsEqual(current[serverId], sessionListViewData)) {
        return current;
    }
    return {
        ...current,
        [serverId]: sessionListViewData,
    };
}

export function clearServerSessionListCache(
    current: ServerScopedSessionListCache | null | undefined,
    serverIdRaw: string,
): ServerScopedSessionListCache {
    const serverId = normalizeTrimmedString(serverIdRaw);
    const currentCache = current ?? EMPTY_SERVER_SCOPED_SESSION_LIST_CACHE;
    if (!serverId || !(serverId in currentCache)) {
        return currentCache;
    }

    const next = { ...currentCache };
    delete next[serverId];
    if (Object.keys(next).length === 0) {
        return EMPTY_SERVER_SCOPED_SESSION_LIST_CACHE;
    }
    return next;
}
