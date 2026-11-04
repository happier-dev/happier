import { areMachineDisplaySemanticsEqual, type MachineDisplayRenderable } from '../machines/machineDisplayRenderable';
import type { SessionListViewItem } from '../session/listing/sessionListViewData';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionListFallbackGroupDisplay } from '../workspaces/projectGroupDisplay';
import type { CollectionGroupRollup } from '@happier-dev/plugin-ui/components';
import { getSessionStorageKind, type SessionStorageKind } from '../session/sessionStorageKind';
import type { SessionFolderWorkspaceRefV1 } from '../session/folders/types';
import type {
    SessionListAttentionPlacementReason,
    SessionListWorkingPlacementReason,
} from '../session/listing/sessionListAttentionPlacementTypes';
import { normalizeSessionListKeyParts, type NormalizedSessionListKeyParts } from '../session/listing/sessionListKeyNormalization';
import { areSessionListRowParentContextsEqual, type SessionListRowParentContextFacts } from '../session/listing/sessionListRowContext';

import { buildSessionListIndexNodeId, type SessionListOccurrenceRole } from './sessionListIndexIdentity';
export { buildSessionListIndexEntityId, buildSessionListIndexNodeId, isSessionListShortcutOccurrence, type SessionListOccurrenceRole } from './sessionListIndexIdentity';

export type SessionListIndexItem =
    | Readonly<{
        type: 'header';
        title: string;
        /** Current unique eligibility may differ from presented membership during a hold. */
        eligibleCount?: number;
        /** Admitted subject rollup before any local disclosure hides its members. */
        rollup?: CollectionGroupRollup;
        headerKind?: 'date' | 'server' | 'active' | 'inactive' | 'sessions' | 'project' | 'pinned' | 'loading' | 'folder' | 'attention' | 'working';
        groupKey?: string;
        /** Distinguishes a repeated presentation header without changing its logical group. */
        presentationAnchorGroupKey?: string;
        workspaceKey?: string;
        projectKey?: QualifiedProjectKeyV1;
        seedSessionId?: string | null;
        workspaceScopeHint?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
        serverId?: string;
        serverName?: string;
        subtitle?: string;
        machine?: MachineDisplayRenderable;
        folderId?: string;
        folderDepth?: number;
        workspace?: SessionFolderWorkspaceRefV1;
        displayState?: Readonly<
            | { status: 'available'; value: string }
            | {
                status: 'locked';
                reason:
                    | 'account_key_unavailable'
                    | 'content_unreadable'
                    | 'invalid_stored_display'
                    | 'storage_mode_mismatch';
            }
        >;
    }>
    | Readonly<{
        type: 'session';
        sessionId: string;
        projectKey?: QualifiedProjectKeyV1;
        /** Exact fallback display survives filing without becoming an accepted Project association. */
        fallbackGroupDisplay?: SessionListFallbackGroupDisplay;
        /** One entity can have its base row and one flat attention shortcut. */
        occurrenceRole?: SessionListOccurrenceRole;
        /** Admitted outside-space attention, retained only by the mounted presentation hold. */
        supplementalAttention?: true;
        /** Prepared by the index producer; survives non-address row updates. */
        keyParts?: NormalizedSessionListKeyParts;
        storageKind?: SessionStorageKind;
        section?: 'active' | 'inactive';
        groupKey?: string;
        groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'loading' | 'folder' | 'attention' | 'working';
        pinned?: boolean;
        variant?: 'default' | 'no-path';
        archivedAt?: number | null;
        keepVisibleWhenInactive?: boolean;
        attentionPlacementReason?: SessionListAttentionPlacementReason;
        workingPlacementReason?: SessionListWorkingPlacementReason;
        serverId?: string;
        serverName?: string;
        folderId?: string | null;
        folderDepth?: number;
        /**
         * Level under a lead in the same list group (the `manager` tree, ORC §3.8): 1 for a direct
         * report drawn under its lead. Absent for a row drawn at its own level.
         */
        reportsDepth?: number;
        /** Admitted facts of the visible Session lead; never the child's execution workspace. */
        reportsParentContext?: SessionListRowParentContextFacts;
        /** Presentation default from the admitted parent identity; local disclosure wins. */
        reportsDefaultCollapsed?: true;
        /** The row leads reports nested under it in this list, so it carries their disclosure. */
        reportsParent?: true;
        /** Its nested reports are folded away (local choice, else the presentation default). */
        reportsCollapsed?: true;
        workspace?: SessionFolderWorkspaceRefV1;
        /**
         * Host-derived provenance for a contextual session-list search row.
         * This stays on the ordinary session item so search cannot become a
         * second row/controller path.
         */
        contextualSearchReasons?: readonly SessionListContextualSearchReason[];
        contextualSearchSourceMachineId?: string | null;
    }>
    | Readonly<{
        type: 'workflow_run';
        runId: string;
        serverId: string;
        serverName?: string;
        groupKey?: string;
        groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'loading' | 'folder' | 'attention' | 'working';
        section?: 'active' | 'inactive';
        folderId?: string | null;
        folderDepth?: number;
        reportsDepth?: number;
        workspace?: SessionFolderWorkspaceRefV1;
    }>;

export type SessionListContextualSearchReason =
    | 'transcript'
    | 'hidden-by-filters'
    | 'archived'
    | 'external'
    | 'another-machine';

export type SessionListItemOrganizationEligibilityReason =
    | 'eligible'
    | 'feature-disabled'
    | 'destination-scope-mismatch'
    | 'scope-unavailable'
    | 'unsupported-item';

export type SessionListItemOrganizationEligibility = Readonly<{
    canUseSessionFolders: boolean;
    foldersFeatureEnabled: boolean;
    storageKind: SessionStorageKind | null;
    reason: SessionListItemOrganizationEligibilityReason;
}>;

export type ResolveSessionListItemOrganizationEligibilityOptions = Readonly<{
    foldersFeatureEnabled: boolean;
    destinationServerId?: string | null;
}>;

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
    if (previous.t === 'managedSessions') {
        return next.t === 'managedSessions' && previous.machineId === next.machineId;
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

    if (previous.type === 'workflow_run') {
        return next.type === 'workflow_run'
            && previous.runId === next.runId && previous.serverId === next.serverId
            && previous.serverName === next.serverName && previous.groupKey === next.groupKey
            && previous.groupKind === next.groupKind && previous.section === next.section
            && previous.folderId === next.folderId && previous.folderDepth === next.folderDepth
            && (previous.reportsDepth ?? 0) === (next.reportsDepth ?? 0)
            && areWorkspaceRefsEqual(previous.workspace, next.workspace);
    }

    if (previous.type === 'session') {
        if (next.type !== 'session') return false;
        return previous.sessionId === next.sessionId
            && (previous.occurrenceRole ?? 'base') === (next.occurrenceRole ?? 'base')
            && previous.supplementalAttention === next.supplementalAttention
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
            && (previous.reportsDepth ?? 0) === (next.reportsDepth ?? 0)
            && (previous.reportsParent === true) === (next.reportsParent === true)
            && areSessionListRowParentContextsEqual(previous.reportsParentContext, next.reportsParentContext)
            && (previous.reportsCollapsed === true) === (next.reportsCollapsed === true)
            && (previous.contextualSearchSourceMachineId ?? null) === (next.contextualSearchSourceMachineId ?? null)
            && (previous.contextualSearchReasons ?? []).join('\u0001') === (next.contextualSearchReasons ?? []).join('\u0001')
            && previous.projectKey?.serverId === next.projectKey?.serverId
            && previous.projectKey?.projectKey === next.projectKey?.projectKey
            && previous.fallbackGroupDisplay?.groupKey === next.fallbackGroupDisplay?.groupKey
            && previous.fallbackGroupDisplay?.title === next.fallbackGroupDisplay?.title
            && areWorkspaceRefsEqual(previous.workspace ?? null, next.workspace ?? null);
    }

    if (next.type !== 'header') return false;
    const previousHint = previous.workspaceScopeHint ?? null;
    const nextHint = next.workspaceScopeHint ?? null;

    return previous.title === next.title
        && previous.eligibleCount === next.eligibleCount
        && areSessionListGroupRollupsEqual(previous.rollup, next.rollup)
        && previous.headerKind === next.headerKind
        && previous.groupKey === next.groupKey
        && previous.presentationAnchorGroupKey === next.presentationAnchorGroupKey
        && previous.workspaceKey === next.workspaceKey
        && previous.projectKey?.serverId === next.projectKey?.serverId
        && previous.projectKey?.projectKey === next.projectKey?.projectKey
        && (previous.seedSessionId ?? null) === (next.seedSessionId ?? null)
        && previous.serverId === next.serverId
        && previous.serverName === next.serverName
        && JSON.stringify(previous.displayState ?? null)
            === JSON.stringify(next.displayState ?? null)
        && previous.subtitle === next.subtitle
        && (previous.folderId ?? null) === (next.folderId ?? null)
        && (previous.folderDepth ?? null) === (next.folderDepth ?? null)
        && (previousHint?.serverId ?? null) === (nextHint?.serverId ?? null)
        && (previousHint?.machineId ?? null) === (nextHint?.machineId ?? null)
        && (previousHint?.rootPath ?? null) === (nextHint?.rootPath ?? null)
        && areWorkspaceRefsEqual(previous.workspace ?? null, next.workspace ?? null)
        && areMachineDisplaySemanticsEqual(previous.machine ?? null, next.machine ?? null);
}

export function resolveSessionListItemOrganizationEligibility(
    item: SessionListIndexItem,
    options: ResolveSessionListItemOrganizationEligibilityOptions,
): SessionListItemOrganizationEligibility {
    const foldersFeatureEnabled = options.foldersFeatureEnabled === true;
    if (item.type === 'workflow_run') {
        return { canUseSessionFolders: false, foldersFeatureEnabled, storageKind: null, reason: 'unsupported-item' };
    }
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
    if (!item.serverId?.trim()) {
        return {
            canUseSessionFolders: false,
            foldersFeatureEnabled,
            storageKind,
            reason: 'scope-unavailable',
        };
    }

    if (
        options.destinationServerId
        && item.serverId !== options.destinationServerId
    ) {
        return {
            canUseSessionFolders: false,
            foldersFeatureEnabled,
            storageKind,
            reason: 'destination-scope-mismatch',
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

    const previousSessionsByHome = new Map<string, Map<SessionListOccurrenceRole, Map<string, Extract<SessionListIndexItem, { type: 'session' }>>>>();
    const previousByKey = Array.isArray(previousIndex)
        ? (() => {
            const map = new Map<string, SessionListIndexItem>();
            for (let index = 0; index < previousIndex.length; index += 1) {
                const item = previousIndex[index];
                if (item.type === 'session') {
                    const serverId = String(item.serverId ?? '').trim();
                    const sessionId = String(item.sessionId ?? '').trim();
                    let byRole = previousSessionsByHome.get(serverId);
                    if (!byRole) previousSessionsByHome.set(serverId, byRole = new Map());
                    const role = item.occurrenceRole ?? 'base';
                    let bySession = byRole.get(role);
                    if (!bySession) byRole.set(role, bySession = new Map());
                    bySession.set(sessionId, item);
                } else map.set(buildSessionListIndexNodeId(item), item);
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
                eligibleCount: item.eligibleCount,
                headerKind: item.headerKind,
                groupKey: item.groupKey,
                presentationAnchorGroupKey: item.presentationAnchorGroupKey,
                workspaceKey: item.workspaceKey,
                projectKey: item.projectKey,
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

        const serverId = String(item.serverId ?? '').trim();
        const sessionId = String(item.session.id ?? '').trim();
        const previousItem = previousSessionsByHome.get(serverId)?.get(item.occurrenceRole ?? 'base')?.get(sessionId);
        const keyParts = normalizeSessionListKeyParts(serverId, sessionId, previousItem?.keyParts);
        const nextItem: SessionListIndexItem = {
            type: 'session',
            sessionId: item.session.id,
            projectKey: item.projectKey,
            occurrenceRole: item.occurrenceRole,
            fallbackGroupDisplay: item.fallbackGroupDisplay,
            supplementalAttention: item.supplementalAttention,
            keyParts,
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
        if (previousItem && previousItem.keyParts === keyParts
            && areSessionListIndexItemsEqual(previousItem, nextItem)) {
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

export function areSessionListGroupRollupsEqual(left: CollectionGroupRollup | undefined, right: CollectionGroupRollup | undefined): boolean {
    if (left === right) return true;
    if (!left || !right || left.coverage !== right.coverage || left.needsYouCount !== right.needsYouCount) return false;
    const a = left.status;
    const b = right.status;
    return a === b || Boolean(a && b && a.state === b.state && a.bucket === b.bucket && a.tone === b.tone
        && a.attentionType === b.attentionType && a.word === b.word && a.glyph === b.glyph);
}
