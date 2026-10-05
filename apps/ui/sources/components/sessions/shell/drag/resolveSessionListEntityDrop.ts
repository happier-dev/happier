import { entityDragScopesEqualV1, type EntityDragItemV1, type EntityDropAdmissionV1,
    type EntityDropPreviewV1, type EntityDropReasonV1 } from '@happier-dev/protocol/plugins/ui';
import { SessionOrganizationMoveInputSchema } from '@happier-dev/protocol';
import { resolveSessionListDragIntent, resolveSessionListDragTree, type CommitSessionListDragIntentContext,
    type SessionListDragAdmission } from './commitSessionListDragIntent';
import type { SessionListDragIntent } from './_types';
import { treeRowId } from '../drop-resolution/treeRowId';
import type { SessionListTreeRowMetadata } from '../drop-resolution/sessionListTreeTypes';
import type { EntityDropSemanticDestination, TreeDropResult } from '@/components/ui/treeDragDrop';
import { buildSessionListDragIntent } from './sessionListDragIntent';

function sourceRowIdForItem(item: EntityDragItemV1): string | null {
    return item.kind === 'session' ? treeRowId.session(item.address.serverId, item.address.sessionId)
        : item.kind === 'session-folder' ? treeRowId.folder(item.scope.serverId, item.folderId)
            : item.kind === 'session-workspace' ? treeRowId.workspaceRoot(item.workspaceId) : null;
}

/** Current semantic places, including denied applicable rows. The resolver alone admits them. */
export function listSessionListEntityDropDestinations(params: Readonly<{
    item: EntityDragItemV1;
    context: CommitSessionListDragIntentContext;
    preview: (intent: SessionListDragIntent, target: SessionListTreeRowMetadata | null) => EntityDropPreviewV1;
}>): readonly EntityDropSemanticDestination[] {
    const { item, context } = params;
    if (!context.scope || !entityDragScopesEqualV1(item.scope, context.scope)) return [];
    const tree = resolveSessionListDragTree(context);
    const sourceRowId = sourceRowIdForItem(item);
    const source = sourceRowId ? tree.rowMetadataById.get(sourceRowId) : null;
    if (!source || source.serverId !== item.scope.serverId) return [];
    const destinations: EntityDropSemanticDestination[] = [];
    const append = (result: TreeDropResult, target: SessionListTreeRowMetadata | null) => {
        const intent = buildSessionListDragIntent({ result, sourceRowId: source.rowId,
            sourceKind: source.kind === 'session' ? 'leaf' : 'container', snapshotSignature: '' });
        const { scope: _scope, sourceSnapshotSignature: _signature, ...destination } = intent;
        destinations.push({ destination, label: params.preview(intent, target).verb });
    };
    for (const target of tree.rowMetadataById.values()) {
        if (target.rowId === source.rowId || target.serverId !== item.scope.serverId) continue;
        const sameOrganization = source.kind === 'workspace-root'
            ? target.kind === 'workspace-root' && target.containerId === source.containerId
            : target.kind !== 'workspace-root' && target.rootId === source.rootId;
        if (sameOrganization) {
            for (const edge of ['top', 'bottom'] as const) {
                append({ instruction: { kind: edge === 'top' ? 'reorder-before' : 'reorder-after',
                    targetId: target.rowId, containerId: target.containerId, parentId: target.parentRowId,
                    depth: target.folderDepth },
                    visual: { kind: 'line', targetId: target.rowId, edge, depth: target.folderDepth } }, target);
            }
        }
        if ((source.kind !== 'workspace-root' && target.kind === 'folder' && target.rootId === source.rootId)
            || (source.kind === 'session' && target.kind === 'session')) {
            append({ instruction: { kind: 'nest-into', targetId: target.rowId,
                containerId: target.childContainerId ?? target.containerId,
                parentId: target.rowId, depth: target.folderDepth + 1 },
                visual: { kind: 'outline', targetId: target.rowId } }, target);
        }
    }
    const root = source.kind !== 'workspace-root' ? tree.containerMetadataById.get(source.rootId) : null;
    if (root) append({ instruction: { kind: 'move-to-root', containerId: root.containerId,
        rootId: root.rootId, depth: root.depth }, visual: { kind: 'none' } }, tree.rowMetadataById.get(root.rootId) ?? null);
    return destinations;
}

/** Qualified item admission for pointer, chooser and keyboard targets. Presentation localizes the verdict. */
export function resolveSessionListEntityDrop(params: Readonly<{
    item: EntityDragItemV1;
    intent: SessionListDragIntent;
    context: CommitSessionListDragIntentContext;
    preview: (admission: Extract<SessionListDragAdmission, { ok: true }>) => EntityDropPreviewV1;
    refusedPreview?: (input: Readonly<{ intent: SessionListDragIntent; target: SessionListTreeRowMetadata | null;
        reason: EntityDropReasonV1 }>) => EntityDropPreviewV1 | undefined;
    reason: (code: string) => EntityDropReasonV1;
}>): EntityDropAdmissionV1 {
    const { item, context } = params;
    const refuse = (code: string, target: SessionListTreeRowMetadata | null = null): EntityDropAdmissionV1 => {
        const reason = params.reason(code);
        const preview = params.refusedPreview?.({ intent: params.intent, target, reason });
        return { status: 'refused', reason, ...(preview ? { preview } : {}) };
    };
    if (!context.scope || !entityDragScopesEqualV1(item.scope, context.scope)) return refuse('scope-mismatch');
    const sourceRowId = sourceRowIdForItem(item);
    if (!sourceRowId || params.intent.sourceRowId !== sourceRowId) return refuse('unsupported-item');
    const intent = { ...params.intent, scope: item.scope };
    const tree = resolveSessionListDragTree(context);
    const currentContext = { ...context, latestTree: tree };
    const admission = resolveSessionListDragIntent({ intent, context: currentContext });
    if (!admission.ok) return refuse(admission.relationReason ?? admission.reason,
        intent.targetRowId ? tree.rowMetadataById.get(intent.targetRowId) ?? null : null);
    if (admission.effect === 'reports-to') {
        if (!context.resolvePutSessionUnder || admission.expectedLeadSessionId === undefined) return refuse('unavailable');
        return { status: 'allowed', effect: { actionId: 'session.reports_to.set', input: {
            sessionId: admission.source.sessionId!, leadSessionId: admission.lead.sessionId!,
            expectedLeadSessionId: admission.expectedLeadSessionId,
        }, preview: params.preview(admission) } };
    }
    const { sourceSnapshotSignature: _signature, ...semanticInput } = intent;
    const parsed = SessionOrganizationMoveInputSchema.safeParse(semanticInput);
    if (!parsed.success) return refuse('invalid_parameters');
    return { status: 'allowed', effect: { actionId: 'session.organization.move', input: parsed.data,
        preview: params.preview(admission) } };
}
