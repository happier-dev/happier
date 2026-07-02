import type { MachineDisplayRenderable } from '../machines/machineDisplayRenderable';
import type { SessionListViewItem } from '../session/listing/sessionListViewData';
import { getSessionStorageKind, type SessionStorageKind } from '../session/sessionStorageKind';
import type { SessionFolderWorkspaceRefV1 } from '../session/folders';
import type { SessionListAttentionPlacementReason } from '../session/listing/sessionListAttentionPlacementTypes';

export type SessionListIndexItem =
    | Readonly<{
        type: 'header';
        title: string;
        headerKind?: 'date' | 'server' | 'active' | 'inactive' | 'sessions' | 'project' | 'pinned' | 'shared' | 'folder' | 'attention' | 'working';
        groupKey?: string;
        workspaceKey?: string;
        seedSessionId?: string | null;
        workspaceScopeHint?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        serverId?: string;
        serverName?: string;
        subtitle?: string;
        machine?: MachineDisplayRenderable;
        folderId?: string;
        folderDepth?: number;
        workspace?: SessionFolderWorkspaceRefV1;
    }>
    | Readonly<{
        type: 'session';
        sessionId: string;
        storageKind?: SessionStorageKind;
        section?: 'active' | 'inactive';
        groupKey?: string;
        groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'shared' | 'folder' | 'attention' | 'working';
        pinned?: boolean;
        variant?: 'default' | 'no-path';
        archivedAt?: number | null;
        keepVisibleWhenInactive?: boolean;
        attentionPlacementReason?: SessionListAttentionPlacementReason;
        workingPlacementReason?: 'working';
        serverId?: string;
        serverName?: string;
        folderId?: string | null;
        folderDepth?: number;
        workspace?: SessionFolderWorkspaceRefV1;
    }>;

export type SessionListIndexFolderDragEligibilityReason =
    | 'eligible'
    | 'feature-disabled'
    | 'direct-session'
    | 'unsupported-item';

export type SessionListIndexFolderDragEligibility = Readonly<{
    canUseSessionFolders: boolean;
    foldersFeatureEnabled: boolean;
    storageKind: SessionStorageKind | null;
    reason: SessionListIndexFolderDragEligibilityReason;
}>;

export type ResolveSessionListIndexFolderDragEligibilityOptions = Readonly<{
    foldersFeatureEnabled: boolean;
}>;

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

function areWorkspaceRefsEqual(
    previous: SessionFolderWorkspaceRefV1 | null | undefined,
    next: SessionFolderWorkspaceRefV1 | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;
    if (previous.t !== next.t) return false;
    if (previous.serverId !== next.serverId) return false;
    if (previous.t === 'workspaceRef') {
        return next.t === 'workspaceRef' && previous.workspaceRefId === next.workspaceRefId;
    }
    return next.t === 'workspaceScope'
        && previous.machineId === next.machineId
        && previous.rootPath === next.rootPath;
}

export function areSessionListIndexItemsEqual(
    previous: SessionListIndexItem | null | undefined,
    next: SessionListIndexItem | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;
    if (previous.type !== next.type) return false;

    if (previous.type === 'session') {
        if (next.type !== 'session') return false;
        return previous.sessionId === next.sessionId
            && (previous.storageKind ?? 'persisted') === (next.storageKind ?? 'persisted')
            && previous.section === next.section
            && previous.groupKey === next.groupKey
            && previous.groupKind === next.groupKind
            && (previous.pinned === true) === (next.pinned === true)
            && previous.variant === next.variant
            && (previous.archivedAt ?? null) === (next.archivedAt ?? null)
            && (previous.keepVisibleWhenInactive === true) === (next.keepVisibleWhenInactive === true)
            && (previous.attentionPlacementReason ?? null) === (next.attentionPlacementReason ?? null)
            && (previous.workingPlacementReason ?? null) === (next.workingPlacementReason ?? null)
            && previous.serverId === next.serverId
            && previous.serverName === next.serverName
            && (previous.folderId ?? null) === (next.folderId ?? null)
            && (previous.folderDepth ?? null) === (next.folderDepth ?? null)
            && areWorkspaceRefsEqual(previous.workspace ?? null, next.workspace ?? null);
    }

    if (next.type !== 'header') return false;
    const previousHint = previous.workspaceScopeHint ?? null;
    const nextHint = next.workspaceScopeHint ?? null;

    return previous.title === next.title
        && previous.headerKind === next.headerKind
        && previous.groupKey === next.groupKey
        && previous.workspaceKey === next.workspaceKey
        && (previous.seedSessionId ?? null) === (next.seedSessionId ?? null)
        && previous.serverId === next.serverId
        && previous.serverName === next.serverName
        && previous.subtitle === next.subtitle
        && (previous.folderId ?? null) === (next.folderId ?? null)
        && (previous.folderDepth ?? null) === (next.folderDepth ?? null)
        && (previousHint?.serverId ?? null) === (nextHint?.serverId ?? null)
        && (previousHint?.machineId ?? null) === (nextHint?.machineId ?? null)
        && (previousHint?.rootPath ?? null) === (nextHint?.rootPath ?? null)
        && areWorkspaceRefsEqual(previous.workspace ?? null, next.workspace ?? null)
        && areMachineDisplayRenderablesEqual(previous.machine ?? null, next.machine ?? null);
}

function buildSessionListIndexHeaderNodeId(item: Extract<SessionListIndexItem, { type: 'header' }>): string {
    const headerKind = String(item.headerKind ?? '').trim() || 'header';
    const groupKey = String(item.groupKey ?? '').trim();
    const serverId = String(item.serverId ?? '').trim();
    const workspaceKey = String(item.workspaceKey ?? '').trim();
    const folderId = String(item.folderId ?? '').trim();
    const machineId = String(item.machine?.id ?? '').trim();
    const workspaceScopeHint = item.workspaceScopeHint ?? null;
    const hintServerId = String(workspaceScopeHint?.serverId ?? '').trim();
    const hintMachineId = String(workspaceScopeHint?.machineId ?? '').trim();
    const hintRootPath = String(workspaceScopeHint?.rootPath ?? '').trim();

    if (groupKey) return `header:${headerKind}:${groupKey}${folderId ? `:${folderId}` : ''}`;

    const parts = [
        `header:${headerKind}`,
        serverId ? `server:${serverId}` : null,
        workspaceKey ? `workspace:${workspaceKey}` : null,
        folderId ? `folder:${folderId}` : null,
        machineId ? `machine:${machineId}` : null,
        hintServerId ? `hintServer:${hintServerId}` : null,
        hintMachineId ? `hintMachine:${hintMachineId}` : null,
        hintRootPath ? `hintRootPath:${hintRootPath}` : null,
    ].filter((part): part is string => Boolean(part));

    return parts.join('|');
}

export function buildSessionListIndexNodeId(item: SessionListIndexItem): string {
    if (item.type === 'header') {
        return buildSessionListIndexHeaderNodeId(item);
    }

    const serverId = String(item.serverId ?? '').trim();
    const sessionId = String(item.sessionId ?? '').trim();
    if (serverId && sessionId) return `session:${serverId}:${sessionId}`;
    return `session:${sessionId}`;
}

export function resolveSessionListIndexFolderDragEligibility(
    item: SessionListIndexItem,
    options: ResolveSessionListIndexFolderDragEligibilityOptions,
): SessionListIndexFolderDragEligibility {
    const foldersFeatureEnabled = options.foldersFeatureEnabled === true;
    if (!foldersFeatureEnabled) {
        return {
            canUseSessionFolders: false,
            foldersFeatureEnabled,
            storageKind: item.type === 'session' ? item.storageKind ?? 'persisted' : null,
            reason: 'feature-disabled',
        };
    }

    if (item.type === 'header') {
        return {
            canUseSessionFolders: item.headerKind === 'folder',
            foldersFeatureEnabled,
            storageKind: null,
            reason: item.headerKind === 'folder' ? 'eligible' : 'unsupported-item',
        };
    }

    const storageKind = item.storageKind ?? 'persisted';
    if (storageKind !== 'persisted') {
        return {
            canUseSessionFolders: false,
            foldersFeatureEnabled,
            storageKind,
            reason: 'direct-session',
        };
    }

    return {
        canUseSessionFolders: true,
        foldersFeatureEnabled,
        storageKind,
        reason: 'eligible',
    };
}

export function buildSessionListIndexFromViewData(
    items: ReadonlyArray<SessionListViewItem> | null | undefined,
    previousIndex?: ReadonlyArray<SessionListIndexItem> | null | undefined,
): SessionListIndexItem[] | null {
    if (!Array.isArray(items)) {
        return null;
    }

    const previousByKey = Array.isArray(previousIndex)
        ? (() => {
            const map = new Map<string, SessionListIndexItem>();
            for (let index = 0; index < previousIndex.length; index += 1) {
                const item = previousIndex[index];
                map.set(buildSessionListIndexNodeId(item), item);
            }
            return map;
        })()
        : null;

    let didChange = false;
    const next = items.map((item, index) => {
        if (item.type === 'header') {
            const nextItem: SessionListIndexItem = {
                type: 'header',
                title: item.title,
                headerKind: item.headerKind,
                groupKey: item.groupKey,
                workspaceKey: item.workspaceKey,
                seedSessionId: item.seedSessionId ?? null,
                workspaceScopeHint: item.workspaceScopeHint ?? null,
                serverId: item.serverId,
                serverName: item.serverName,
                subtitle: item.subtitle,
                machine: item.machine,
                folderId: item.folderId,
                folderDepth: item.folderDepth,
                workspace: item.workspace,
            };
            const key = buildSessionListIndexNodeId(nextItem);
            const previousItem = previousByKey?.get(key) ?? null;
            if (previousItem && areSessionListIndexItemsEqual(previousItem, nextItem)) {
                return previousItem;
            }
            didChange = true;
            return nextItem;
        }

        const nextItem: SessionListIndexItem = {
            type: 'session',
            sessionId: item.session.id,
            storageKind: getSessionStorageKind(item.session),
            section: item.section,
            groupKey: item.groupKey,
            groupKind: item.groupKind,
            pinned: item.pinned,
            variant: item.variant,
            archivedAt: item.session.archivedAt ?? null,
            keepVisibleWhenInactive: item.session.keepVisibleWhenInactive === true,
            serverId: item.serverId,
            serverName: item.serverName,
            folderId: item.folderId,
            folderDepth: item.folderDepth,
            workspace: item.workspace,
        };
        const key = buildSessionListIndexNodeId(nextItem);
        const previousItem = previousByKey?.get(key) ?? null;
        if (previousItem && areSessionListIndexItemsEqual(previousItem, nextItem)) {
            return previousItem;
        }
        didChange = true;
        return nextItem;
    });

    if (!didChange && Array.isArray(previousIndex) && previousIndex.length === next.length) {
        let allSame = true;
        for (let index = 0; index < next.length; index += 1) {
            if (next[index] !== previousIndex[index]) {
                allSame = false;
                break;
            }
        }
        if (allSame) {
            return previousIndex as SessionListIndexItem[];
        }
    }

    return next;
}
