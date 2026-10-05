/**
 * Commit-time rebase of a session-list drag intent onto the latest live state.
 *
 * Phase 4 of the session-list drag geometry & performance unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * sections 1.5 and 3.5).
 *
 * The drag snapshot freezes tree TOPOLOGY at drag start and the visual phase
 * resolves a `SessionListDragIntent` (stable ids only — no pixel geometry, no
 * frozen order arrays). The session list keeps mutating in the background while
 * the user drags. This module takes that stable intent plus the latest live
 * state and:
 *
 * 1. uses current tree metadata or rebuilds ONCE from the latest session-list index
 *    (no measured geometry — only `rowMetadataById`/`containerMetadataById` are
 *    needed, and `buildSessionListTreeRows` yields those without bounds);
 * 2. resolves source/target/container by stable ids in the latest metadata;
 * 3. applies the section 1.5 conflict rules (source/target/container missing,
 *    scope mismatch, folder cycle, blocked intent, no real change), with a safe
 *    container-edge degrade when only the target row vanished;
 * 4. when valid, reconstructs a fully-resolved latest-tree `TreeDropResult` and
 *    delegates to `applySessionListTreeDropOperation`, which builds the minimal
 *    latest-state order update from the current maps.
 *
 * It never feeds `applySessionListTreeDropOperation` stale frozen tree metadata
 * and never commits stale full-snapshot order arrays.
 *
 * `../dev` note: `../dev`'s `TreeInstruction` has no `move-to-root.placement` —
 * root placement is carried by the `result.visual.edge` line visual. A rebased
 * `move-to-root` (or an edge-degraded reorder) therefore reconstructs a
 * `move-to-root` instruction PLUS a `{ kind: 'line', edge }` visual, which
 * `resolveSessionListTreeDropDestination` / `applySessionListTreeDropOperation`
 * read to resolve the container edge. Folder-sort behaviour is handled inside
 * `applyGroupOrderUpdate` via `SessionListGroupOrderChildKind`, so no
 * `resolveSessionListFolderSortModeDropResult` rewrite happens here.
 */

import type { TreeDropResult, TreeInstruction } from '@/components/ui/treeDragDrop';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionFoldersV1 } from '@/sync/domains/session/folders';
import { buildSessionFolderWorkspaceRefKey } from '@/sync/domains/session/folders';
import {
    normalizeSessionListFolderSortModeV1,
    normalizeSessionListOrderingModeV1,
    resolveEffectiveSessionListFolderSortMode,
    type SessionListOrderingModeV1,
    type SessionListOrderingSectionMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import {
    isSessionListSessionSiblingReorder,
    normalizeSessionListSectionModeV1,
    resolveSessionListSessionRowDragPolicy,
} from '@/sync/domains/session/listing/sessionListLayout';

import type {
    SessionListDragCommitNoOpReason,
    SessionListDragCommitResult,
    SessionListDragIntent,
} from './_types';
import {
    applySessionListTreeDropOperation,
    resolveSessionListTreeDropDestination,
    type ApplySessionListTreeDropOperationContext,
    type SessionListTreeDropDestination,
} from '../commit/applySessionListTreeDropOperation';
import { buildSessionListGroupOrderAfterTreeDrop, resolveSessionListGroupOrderChildKind } from '../commit/applyGroupOrderUpdate';
import { buildSessionWorkspaceOrderAfterTreeDrop } from '../commit/applyWorkspaceOrderUpdate';
import { buildSessionListDragSource } from '../drop-resolution/buildSessionListDragSource';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { isSessionTreeRowId, isWorkspaceRootTreeRowId } from '../drop-resolution/treeRowId';
import type {
    SessionListTreeContainerMetadata,
    SessionListTreeDragSource,
    SessionListTreeDropResult,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from '../drop-resolution/sessionListTreeTypes';

type SessionListGroupOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type SessionWorkspaceOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;
type SessionListFolderSortModeV1 = 'foldersFirst' | 'mixed';
type SessionListSessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

function isSessionListSessionIndexItem(item: SessionListIndexItem): item is SessionListSessionIndexItem {
    return item.type === 'session';
}

/**
 * Latest live state required to commit a drag intent.
 *
 * `latestItems` is the latest session-list index; `latestTree` may supply its
 * already-indexed projection. A stale projection is rebuilt once. The folder/order maps are the latest live maps the
 * minimal order update is built against.
 */
export type CommitSessionListDragIntentContext = Readonly<{
    scope?: SessionListDragIntent['scope'];
    /** Current canonical relation verdict, preloaded by the relation read owner. */
    resolvePutSessionUnder?: (input: Readonly<{ serverId: string; sessionId: string; leadSessionId: string }>) =>
        Readonly<{ allowed: true; expectedLeadSessionId: string | null }> | Readonly<{ allowed: false; reason: string }>;
    /** Latest session-list index — the latest tree metadata is built from it. */
    latestItems: ReadonlyArray<SessionListIndexItem>;
    /** Mounted list's existing indexed projection; reused only for the exact current item array. */
    latestTree?: SessionListTreeModel;
    sessionFoldersV1: SessionFoldersV1;
    sessionListGroupOrderV1: SessionListGroupOrderV1;
    sessionWorkspaceOrderV1?: SessionWorkspaceOrderV1;
    sessionListFolderSortModeV1?: SessionListFolderSortModeV1;
    sessionListOrderingModeV1?: SessionListOrderingModeV1;
    sessionListSectionModeV1?: SessionListOrderingSectionMode;
    manualSessionOrderingEnabled?: boolean;
    isFolderOrganizationEnabled?: (serverId: string | null) => boolean;
    now: () => number;
    setSessionFoldersV1: (next: SessionFoldersV1) => Promise<void>;
    setSessionListGroupOrderV1: (next: Record<string, string[]>) => Promise<void>;
    setSessionWorkspaceOrderV1?: (next: Record<string, string[]>) => Promise<void>;
    setSessionFolderAssignment: (assignment: Readonly<{
        serverId: string;
        sessionId: string;
        folderId: string | null;
    }>) => Promise<void>;
    /**
     * Puts the dragged Session under the target Session (`reportsTo`, R-03). The owner re-checks the
     * drop against the latest Sessions, asks the server, and says a refusal itself. Omitted, a drop
     * on a Session row never commits.
     */
    putSessionUnder?: (input: Readonly<{
        serverId: string;
        sessionId: string;
        leadSessionId: string;
    }>) => Promise<'applied' | 'not-eligible' | 'refused' | 'unknown'>;
}>;

function noOp(reason: SessionListDragCommitNoOpReason): Readonly<{ ok: false; reason: SessionListDragCommitNoOpReason }> {
    return { ok: false, reason };
}

/**
 * Re-derives the descendant set of a folder source from the LATEST tree, so a
 * cycle check uses the current parent/child links rather than the frozen ones.
 */
function collectLatestDescendantRowIds(
    tree: SessionListTreeModel,
    sourceRowId: string,
): Set<string> {
    const descendants = new Set<string>([sourceRowId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const metadata of tree.rowMetadataById.values()) {
            if (!metadata.parentRowId || descendants.has(metadata.rowId)) continue;
            if (descendants.has(metadata.parentRowId)) {
                descendants.add(metadata.rowId);
                changed = true;
            }
        }
    }
    return descendants;
}

/**
 * True when source and destination container no longer share a compatible
 * scope. Sessions/folders may only move within their own workspace root; a
 * workspace-root may only move inside its own workspace-order container.
 */
function isScopeMismatch(params: Readonly<{
    source: SessionListTreeRowMetadata;
    container: SessionListTreeContainerMetadata;
}>): boolean {
    const { source, container } = params;
    if (source.kind === 'workspace-root') {
        return container.kind !== 'workspace-order' || container.containerId !== source.containerId;
    }
    if (container.kind !== 'children') return true;
    if (container.rootId !== source.rootId) return true;
    const sourceWorkspace = source.workspace;
    const containerWorkspace = container.workspace;
    if (sourceWorkspace && containerWorkspace) {
        return buildSessionFolderWorkspaceRefKey(sourceWorkspace)
            !== buildSessionFolderWorkspaceRefKey(containerWorkspace);
    }
    return false;
}

/**
 * The fully-resolved latest-tree `TreeDropResult` (instruction + visual) to
 * commit, or a stable no-op reason. The visual `edge` carries the root-placement
 * information `../dev`'s commit helpers need (no `move-to-root.placement` field).
 */
type RebasedResult = TreeDropResult;

/**
 * Rebuilds the `TreeDropResult` from the stable intent against the latest tree.
 *
 * A `reorder-before`/`reorder-after` whose target row vanished but whose
 * container survives is safely degraded to a `move-to-root` on the container
 * edge — re-expressed for `../dev` as a `move-to-root` instruction plus a
 * `{ kind: 'line', edge }` visual (`top` for `reorder-before`, `bottom` for
 * `reorder-after`). Returns a stable no-op reason instead when the move can no
 * longer apply.
 */
function resolveLatestResult(params: Readonly<{
    intent: SessionListDragIntent;
    tree: SessionListTreeModel;
    container: SessionListTreeContainerMetadata;
}>): RebasedResult | SessionListDragCommitNoOpReason {
    const { intent, tree, container } = params;
    const target = intent.targetRowId ? tree.rowMetadataById.get(intent.targetRowId) : null;
    const targetExists = target != null;

    if (intent.instructionKind === 'reorder-before' || intent.instructionKind === 'reorder-after') {
        if (intent.targetRowId && target?.containerId === container.containerId) {
            const edge: 'top' | 'bottom' = intent.instructionKind === 'reorder-before' ? 'top' : 'bottom';
            const instruction: TreeInstruction = {
                kind: intent.instructionKind,
                targetId: intent.targetRowId,
                containerId: container.containerId,
                parentId: container.parentRowId,
                depth: container.depth,
            };
            return {
                instruction,
                visual: { kind: 'line', targetId: intent.targetRowId, edge, depth: container.depth },
            };
        }
        // Target row deleted mid-drag, container survives: degrade to a
        // container-edge placement so the move still lands coherently.
        const edge: 'top' | 'bottom' = intent.instructionKind === 'reorder-before' ? 'top' : 'bottom';
        return {
            instruction: {
                kind: 'move-to-root',
                containerId: container.containerId,
                rootId: container.rootId,
                depth: container.depth,
            },
            visual: { kind: 'line', targetId: container.containerId, edge, depth: container.depth },
        };
    }

    if (intent.instructionKind === 'nest-into') {
        // The child container belongs to the target; its parentRowId names the folder's own parent.
        if (!intent.targetRowId || !targetExists || target?.childContainerId !== container.containerId) return 'target-missing';
        return {
            instruction: {
                kind: 'nest-into',
                targetId: intent.targetRowId,
                containerId: container.containerId,
                parentId: intent.targetRowId,
                depth: container.depth,
            },
            visual: { kind: 'outline', targetId: intent.targetRowId },
        };
    }

    if (intent.instructionKind === 'move-to-root') {
        // `../dev` has no `move-to-root.placement`: the visual `edge` carries the
        // root placement. The intent's `edge` is the resolved line edge; default
        // to `bottom` (after-last) when the intent had no line edge.
        const edge: 'top' | 'bottom' = intent.edge ?? 'bottom';
        return {
            instruction: {
                kind: 'move-to-root',
                containerId: container.containerId,
                rootId: container.rootId,
                depth: container.depth,
            },
            visual: { kind: 'line', targetId: container.containerId, edge, depth: container.depth },
        };
    }

    return 'blocked-intent';
}

/**
 * True when applying the resolved instruction against the latest maps yields no
 * real change to the order maps and would not change the source's folder
 * assignment — i.e. the intent rebased onto latest state is a genuine no-op.
 */
function isNoChangeCommit(params: Readonly<{
    tree: SessionListTreeModel;
    source: SessionListTreeDragSource;
    context: CommitSessionListDragIntentContext;
    destination: SessionListTreeDropDestination;
}>): boolean {
    const { tree, source, context, destination } = params;
    const folderAssignmentChanges = source.metadata.kind === 'session'
        && (source.metadata.folderId ?? null) !== destination.container.folderId;
    if (folderAssignmentChanges) return false;

    if (source.metadata.kind === 'workspace-root') {
        const next = buildSessionWorkspaceOrderAfterTreeDrop({
            tree,
            currentMap: context.sessionWorkspaceOrderV1 ?? {},
            movedRowId: source.metadata.rowId,
            containerId: destination.container.containerId,
            beforeRowId: destination.beforeRowId,
            afterRowId: destination.afterRowId,
        });
        return next != null && isOrderMapScopeUnchanged({
            currentMap: context.sessionWorkspaceOrderV1 ?? {},
            next,
        });
    }

    const childKind = resolveSessionListGroupOrderChildKind(
        source.metadata.kind === 'folder' ? 'folder' : 'session',
        resolveEffectiveFolderSortModeForDragContext(context),
    );
    const next = buildSessionListGroupOrderAfterTreeDrop({
        tree,
        currentMap: context.sessionListGroupOrderV1,
        movedRowId: source.metadata.rowId,
        containerId: destination.container.containerId,
        beforeRowId: destination.beforeRowId,
        afterRowId: destination.afterRowId,
        childKind,
    });
    return next != null && isOrderMapScopeUnchanged({
        currentMap: context.sessionListGroupOrderV1,
        next,
    });
}

function resolveEffectiveFolderSortModeForDragContext(
    context: CommitSessionListDragIntentContext,
): SessionListFolderSortModeV1 {
    return resolveEffectiveSessionListFolderSortMode({
        orderingMode: normalizeSessionListOrderingModeV1(context.sessionListOrderingModeV1),
        folderSortMode: normalizeSessionListFolderSortModeV1(context.sessionListFolderSortModeV1),
    });
}

function isOrderMapScopeUnchanged(params: Readonly<{
    currentMap: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
    next: Readonly<Record<string, ReadonlyArray<string>>>;
}>): boolean {
    for (const [scopeKey, nextKeys] of Object.entries(params.next)) {
        const currentKeys = params.currentMap[scopeKey] ?? [];
        if (currentKeys.length !== nextKeys.length) return false;
        for (let index = 0; index < nextKeys.length; index += 1) {
            if (currentKeys[index] !== nextKeys[index]) return false;
        }
    }
    return true;
}

function isSessionSiblingReorderBlockedByOrderingMode(params: Readonly<{
    source: SessionListTreeDragSource;
    context: CommitSessionListDragIntentContext;
    destination: SessionListTreeDropDestination;
}>): boolean {
    const { source, context, destination } = params;
    if (source.metadata.kind !== 'session') return false;
    if (!isSessionListSessionSiblingReorder({
        sourceFolderId: source.metadata.folderId,
        destinationFolderId: destination.container.folderId,
    })) return false;

    const item = source.metadata.item;
    if (!isSessionListSessionIndexItem(item)) return false;
    const sectionMode = normalizeSessionListSectionModeV1(context.sessionListSectionModeV1);
    return !resolveSessionListSessionRowDragPolicy({
        manualSessionOrderingEnabled: context.manualSessionOrderingEnabled !== false,
        folderContainmentEnabled: false,
        item,
        sectionModeV1: sectionMode,
        orderingModeV1: normalizeSessionListOrderingModeV1(context.sessionListOrderingModeV1),
    }).canReorderSiblings;
}

export type SessionListDragAdmission =
    | Readonly<{ ok: false; reason: SessionListDragCommitNoOpReason; relationReason?: string }>
    | Readonly<{ ok: true; effect: 'reports-to'; source: SessionListTreeRowMetadata; lead: SessionListTreeRowMetadata; expectedLeadSessionId: string | null }>
    | Readonly<{ ok: true; effect: 'organization'; tree: SessionListTreeModel; source: SessionListTreeDragSource; result: SessionListTreeDropResult }>;

/** Admission and semantic destination projection share the mounted list's current index. */
export function resolveSessionListDragTree(context: Pick<CommitSessionListDragIntentContext, 'latestTree' | 'latestItems'>): SessionListTreeModel {
    return context.latestTree?.items === context.latestItems
        ? context.latestTree
        : buildSessionListTreeRows({ items: context.latestItems });
}

/** The shared semantic admission owner. Geometry, menus and Actions submit the same stable intent. */
export function resolveSessionListDragIntent(params: Readonly<{
    intent: SessionListDragIntent;
    context: CommitSessionListDragIntentContext;
}>): SessionListDragAdmission {
    const { intent, context } = params;
    if (intent.scope && (!context.scope || intent.scope.serverId !== context.scope.serverId
        || intent.scope.accountId !== context.scope.accountId)) return noOp('scope-mismatch');

    // Blocked / idle intents never commit.
    if (intent.instructionKind === 'blocked' || intent.instructionKind === 'idle') {
        return noOp('blocked-intent');
    }

    // Reuse the mounted list's current index for pointer admission. Release
    // re-reads this context, and rejects a projection from an older item array.
    const tree = resolveSessionListDragTree(context);

    // Resolve the source by stable id in the latest tree.
    const sourceMetadata = tree.rowMetadataById.get(intent.sourceRowId);
    if (!sourceMetadata || sourceMetadata.kind !== intentSourceKindToTreeKind(intent)) {
        return noOp('source-missing');
    }
    if (intent.scope && sourceMetadata.serverId !== intent.scope.serverId) return noOp('scope-mismatch');

    // A drop on a Session row puts the source under that Session: a `reportsTo` change, not a
    // folder or order change, so none of the container rebase below applies.
    if (intent.instructionKind === 'nest-into' && intent.targetRowId && isSessionTreeRowId(intent.targetRowId)) {
        const lead = tree.rowMetadataById.get(intent.targetRowId);
        if (!lead || lead.kind !== 'session' || !lead.sessionId) return noOp('target-missing');
        if (sourceMetadata.kind !== 'session' || !sourceMetadata.sessionId || !sourceMetadata.serverId) return noOp('blocked-intent');
        if (lead.serverId !== sourceMetadata.serverId) return noOp('scope-mismatch');
        if (!context.putSessionUnder) return noOp('blocked-intent');
        const eligibility = context.resolvePutSessionUnder?.({ serverId: sourceMetadata.serverId,
            sessionId: sourceMetadata.sessionId, leadSessionId: lead.sessionId });
        if (!eligibility) return { ok: false, reason: 'blocked-intent', relationReason: 'unavailable' };
        if (eligibility?.allowed === false) return { ok: false, reason: 'blocked-intent', relationReason: eligibility.reason };
        return { ok: true, effect: 'reports-to', source: sourceMetadata, lead,
            expectedLeadSessionId: eligibility.expectedLeadSessionId };
    }

    // Resolve the destination container by stable id in the latest tree.
    if (!intent.containerId) return noOp('container-missing');
    const container = tree.containerMetadataById.get(intent.containerId);
    if (!container) return noOp('container-missing');

    // Incompatible workspace / server / scope between source and destination.
    if (isScopeMismatch({ source: sourceMetadata, container })) {
        return noOp('scope-mismatch');
    }

    // Folder-move cycle guard against the LATEST descendant set.
    if (sourceMetadata.kind === 'folder') {
        const descendants = collectLatestDescendantRowIds(tree, sourceMetadata.rowId);
        if (descendants.has(container.containerId) || (container.parentRowId && descendants.has(container.parentRowId))) {
            return noOp('descendant-cycle');
        }
    }

    // Rebuild the result against the latest tree (with safe edge degrade).
    const rebasedResult = resolveLatestResult({ intent, tree, container });
    if (typeof rebasedResult === 'string') return noOp(rebasedResult);

    const source = buildSessionListDragSource({ tree, sourceRowId: intent.sourceRowId });
    const result: SessionListTreeDropResult = rebasedResult;

    // No real change once rebased onto latest state.
    const destination = resolveSessionListTreeDropDestination({
        tree,
        source,
        result,
    });
    if (destination && isSessionSiblingReorderBlockedByOrderingMode({ source, context, destination })) {
        return noOp('date-ordering-mode');
    }
    if (destination && isNoChangeCommit({ tree, source, context, destination })) {
        return noOp('no-change');
    }
    if (context.isFolderOrganizationEnabled?.(source.metadata.serverId) === false && (source.metadata.kind === 'folder'
        || (source.metadata.kind === 'session' && source.metadata.folderId !== destination?.container.folderId))) {
        return noOp('feature-disabled');
    }
    return { ok: true, effect: 'organization', tree, source, result };
}

export async function commitSessionListDragIntent(params: Readonly<{
    intent: SessionListDragIntent;
    context: CommitSessionListDragIntentContext;
}>): Promise<SessionListDragCommitResult> {
    const { context } = params;
    const admission = resolveSessionListDragIntent(params);
    if (!admission.ok) return noOp(admission.reason);
    if (admission.effect === 'reports-to') {
        return commitPutSessionUnder({ source: admission.source, lead: admission.lead, context });
    }
    const { tree, source, result } = admission;

    const applyContext: ApplySessionListTreeDropOperationContext = {
        sessionFoldersV1: context.sessionFoldersV1,
        sessionListGroupOrderV1: context.sessionListGroupOrderV1,
        sessionWorkspaceOrderV1: context.sessionWorkspaceOrderV1,
        sessionListFolderSortModeV1: context.sessionListFolderSortModeV1,
        sessionListOrderingModeV1: context.sessionListOrderingModeV1,
        sessionListSectionModeV1: context.sessionListSectionModeV1,
        manualSessionOrderingEnabled: context.manualSessionOrderingEnabled,
        isFolderOrganizationEnabled: context.isFolderOrganizationEnabled,
        now: context.now,
        setSessionFoldersV1: context.setSessionFoldersV1,
        setSessionListGroupOrderV1: context.setSessionListGroupOrderV1,
        setSessionWorkspaceOrderV1: context.setSessionWorkspaceOrderV1,
        setSessionFolderAssignment: context.setSessionFolderAssignment,
    };

    const applied = await applySessionListTreeDropOperation({
        tree,
        source,
        result,
        context: applyContext,
    });

    if (applied.ok) return { ok: true };
    if (applied.reason === 'date-ordering-mode') return noOp('date-ordering-mode');
    if (applied.reason === 'feature-disabled') return noOp('feature-disabled');
    return noOp('no-change');
}

async function commitPutSessionUnder(params: Readonly<{
    source: SessionListTreeRowMetadata;
    lead: SessionListTreeRowMetadata;
    context: CommitSessionListDragIntentContext;
}>): Promise<SessionListDragCommitResult> {
    const { source, context } = params;
    const lead = params.lead;
    if (!lead || lead.kind !== 'session' || !lead.sessionId) return noOp('target-missing');
    if (source.kind !== 'session' || !source.sessionId || !source.serverId) return noOp('blocked-intent');
    if (lead.serverId !== source.serverId) return noOp('scope-mismatch');
    if (!context.putSessionUnder) return noOp('blocked-intent');
    const outcome = await context.putSessionUnder({
        serverId: source.serverId,
        sessionId: source.sessionId,
        leadSessionId: lead.sessionId,
    });
    if (outcome === 'applied') return { ok: true };
    if (outcome === 'unknown') return noOp('outcome-unknown');
    return noOp(outcome === 'refused' ? 'refused' : 'blocked-intent');
}

function intentSourceKindToTreeKind(intent: SessionListDragIntent): SessionListTreeRowMetadata['kind'] {
    if (intent.sourceKind === 'leaf') return 'session';
    return isWorkspaceRootTreeRowId(intent.sourceRowId) ? 'workspace-root' : 'folder';
}
