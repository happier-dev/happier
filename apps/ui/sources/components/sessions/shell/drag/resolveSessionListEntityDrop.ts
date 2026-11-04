import { entityDragScopesEqualV1, type EntityDragItemV1, type EntityDropAdmissionV1,
    type EntityDropPreviewV1, type EntityDropReasonV1 } from '@happier-dev/protocol/plugins/ui';
import { SetSessionFolderAssignmentRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { resolveSessionListItemOrganizationEligibility } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveSessionSectionChoiceLabels } from '@/sync/domains/session/organization/sections';
import { t } from '@/text';
import { SessionOrganizationMoveInputSchema } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';
import { SessionSpaceMembershipSetInputV1Schema, type SessionSpaceMembershipSetInputV1 } from '@happier-dev/protocol/actions';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { resolveSessionListDragIntent, resolveSessionListDragTree, type CommitSessionListDragIntentContext,
    type SessionListDragAdmission } from './commitSessionListDragIntent';
import type { SessionListDragIntent } from './_types';
import { treeRowId } from '../drop-resolution/treeRowId';
import type { SessionListTreeRowMetadata } from '../drop-resolution/sessionListTreeTypes';
import type { EntityDropSemanticDestination, TreeDropResult } from '@/components/ui/treeDragDrop';
import { buildSessionListDragIntent } from './sessionListDragIntent';
import { resolveSessionListSectionBeforeId, resolveSessionListTreeDropDestination } from '../commit/applySessionListTreeDropOperation';
import { resolveSessionListDestinationFolderId } from '../drop-resolution/sessionListDestinationScope';

function sourceRowIdForItem(item: EntityDragItemV1): string | null {
    return item.kind === 'session' ? treeRowId.session(item.address.serverId, item.address.sessionId)
        : item.kind === 'session-folder' ? treeRowId.folder(item.scope.serverId, item.folderId)
            : item.kind === 'session-workspace' ? treeRowId.workspaceRoot(item.workspaceId) : null;
}

export function readSessionListFolderAssignmentDestination(value: unknown): Readonly<{ folderId: string | null }> | null {
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'folder-assignment') return null;
    const parsed = SetSessionFolderAssignmentRequestSchema.safeParse('folderId' in value ? { folderId: value.folderId } : {});
    return parsed.success ? parsed.data : null;
}

export function readSessionListSpaceMembershipDestination(value: unknown, sessionId: string): SessionSpaceMembershipSetInputV1 | null {
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'space-membership') return null;
    const { kind: _kind, ...input } = value;
    const parsed = SessionSpaceMembershipSetInputV1Schema.safeParse({ ...input, sessionId });
    return parsed.success ? parsed.data : null;
}

/** Semantic Space filing keeps hierarchy untouched and executes the shared membership Action. */
export function resolveSessionListSpaceMembershipDrop(params: Readonly<{
    item: EntityDragItemV1;
    input: SessionSpaceMembershipSetInputV1;
    context: CommitSessionListDragIntentContext;
    preview: (spaceName: string, operation: SessionSpaceMembershipSetInputV1['operation']) => EntityDropPreviewV1;
    reason: (code: string) => EntityDropReasonV1;
}>): EntityDropAdmissionV1 {
    const refuse = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: params.reason(code) });
    if (!params.context.scope || !entityDragScopesEqualV1(params.item.scope, params.context.scope)) return refuse('scope-mismatch');
    if (params.item.kind !== 'session' || params.item.address.serverId !== params.item.scope.serverId
        || params.item.address.sessionId !== params.input.sessionId) return refuse('unsupported-item');
    if (!params.context.latestItems.some(item => item.type === 'session' && item.serverId === params.item.scope.serverId
        && item.sessionId === params.input.sessionId)) return refuse('source-missing');
    const target = params.context.spaceMembershipTargets?.find(candidate => candidate.spaceId === params.input.spaceId
        && areAccountSettingsScopesEqual(candidate.spaceSettingsTarget, params.input.spaceSettingsTarget));
    if (!target) return refuse('unavailable');
    return { status: 'allowed', effect: { actionId: 'session.space_membership.set', input: params.input,
        preview: params.preview(target.name, params.input.operation) } };
}

function folderAssignmentTargets(item: EntityDragItemV1, context: CommitSessionListDragIntentContext) {
    if (item.kind !== 'session' || item.address.serverId !== item.scope.serverId || !context.scope || !entityDragScopesEqualV1(item.scope, context.scope)) return [];
    const source = context.latestItems.find(candidate => candidate.type === 'session'
        && candidate.serverId === item.address.serverId && candidate.sessionId === item.address.sessionId);
    if (!source || source.type !== 'session'
        || !resolveSessionListItemOrganizationEligibility(source, {
            foldersFeatureEnabled: context.isFolderOrganizationEnabled?.(source.serverId ?? null) === true,
        }).canUseSessionFolders) return [];
    const sections = (context.sessionSections ?? []).filter(section => section.address.serverId === item.scope.serverId
        && section.display.status === 'available');
    // The same names Move to section shows: plain unless two sections share one.
    const labels = resolveSessionSectionChoiceLabels(sections, { unavailableLabel: t('common.unavailable') });
    return [{ id: 'session-section-project', folderId: null, title: '', depth: 0,
        disabled: (source.folderId ?? null) === null },
    ...sections.map(section => ({ id: section.address.sectionId, folderId: section.address.sectionId,
        title: labels.get(section.address.sectionId) ?? section.address.sectionId,
        depth: 0, disabled: source.folderId === section.address.sectionId }))];
}

/** Session assignment is semantic inventory; it does not add invisible tree geometry. */
export function resolveSessionListFolderAssignmentDrop(params: Readonly<{
    item: EntityDragItemV1;
    folderId: string | null;
    context: CommitSessionListDragIntentContext;
    preview: (folderName: string | null) => EntityDropPreviewV1;
    reason: (code: string) => EntityDropReasonV1;
}>): EntityDropAdmissionV1 {
    const refuse = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: params.reason(code) });
    if (!params.context.scope || !entityDragScopesEqualV1(params.item.scope, params.context.scope)) return refuse('scope-mismatch');
    if (params.item.kind !== 'session') return refuse('unsupported-item');
    const target = folderAssignmentTargets(params.item, params.context).find(candidate => candidate.folderId === params.folderId);
    if (!target) return refuse('unavailable');
    if (target.disabled) return refuse('no-change');
    return { status: 'allowed', effect: { actionId: 'session.section.set', input: {
        sessionId: params.item.address.sessionId, sectionId: target.folderId,
    }, preview: params.preview(target.folderId === null ? null : target.title) } };
}

/** Current semantic places, including denied applicable rows. The resolver alone admits them. */
export function listSessionListEntityDropDestinations(params: Readonly<{
    item: EntityDragItemV1;
    context: CommitSessionListDragIntentContext;
    preview: (intent: SessionListDragIntent, target: SessionListTreeRowMetadata | null) => EntityDropPreviewV1;
    folderPreview: (folderName: string | null) => EntityDropPreviewV1;
    spacePreview?: (spaceName: string, operation: SessionSpaceMembershipSetInputV1['operation']) => EntityDropPreviewV1;
}>): readonly EntityDropSemanticDestination[] {
    const { item, context } = params;
    if (!context.scope || !entityDragScopesEqualV1(item.scope, context.scope)) return [];
    const destinations: EntityDropSemanticDestination[] = folderAssignmentTargets(item, context).map(target => ({
        destination: { kind: 'folder-assignment', folderId: target.folderId },
        label: params.folderPreview(target.folderId === null ? null : target.title).verb,
    }));
    if (item.kind === 'session' && item.address.serverId === item.scope.serverId) {
        for (const target of context.spaceMembershipTargets ?? []) {
            destinations.push({ destination: { kind: 'space-membership', operation: 'add',
                spaceId: target.spaceId, spaceSettingsTarget: target.spaceSettingsTarget },
            label: params.spacePreview?.(target.name, 'add').verb ?? target.name });
            const sourceSpaceId = context.spaceMembershipSourceSpaceId;
            if (sourceSpaceId && sourceSpaceId !== target.spaceId) {
                destinations.push({ destination: { kind: 'space-membership', operation: 'move', sourceSpaceId,
                    spaceId: target.spaceId, spaceSettingsTarget: target.spaceSettingsTarget },
                label: params.spacePreview?.(target.name, 'move').verb ?? target.name });
            }
        }
    }
    const tree = resolveSessionListDragTree(context);
    const sourceRowId = sourceRowIdForItem(item);
    const source = (sourceRowId ? tree.rowMetadataById.get(sourceRowId) : null)
        ?? (item.kind === 'session' ? [...tree.rowMetadataById.values()].find(row => row.kind === 'session'
            && row.serverId === item.address.serverId && row.sessionId === item.address.sessionId) : null);
    if (!source || source.serverId !== item.scope.serverId) return destinations;
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
            : target.kind !== 'workspace-root';
        if (sameOrganization) {
            for (const edge of ['top', 'bottom'] as const) {
                append({ instruction: { kind: edge === 'top' ? 'reorder-before' : 'reorder-after',
                    targetId: target.rowId, containerId: target.containerId, parentId: target.parentRowId,
                    depth: target.folderDepth },
                    visual: { kind: 'line', targetId: target.rowId, edge, depth: target.folderDepth } }, target);
            }
        }
        if (source.kind === 'session' && (target.kind === 'folder' || target.kind === 'session' || target.kind === 'workspace-root')) {
            append({ instruction: { kind: 'nest-into', targetId: target.rowId,
                containerId: target.childContainerId ?? target.containerId,
                parentId: target.rowId, depth: target.folderDepth + 1 },
                visual: { kind: 'outline', targetId: target.rowId } }, target);
        }
    }
    const root = source.kind !== 'workspace-root' ? tree.containerMetadataById.get(source.rootId) : null;
    if (root && source.kind !== 'session') append({ instruction: { kind: 'move-to-root', containerId: root.containerId,
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
    const tree = resolveSessionListDragTree(context);
    const sourceRowId = sourceRowIdForItem(item);
    const source = tree.rowMetadataById.get(params.intent.sourceRowId);
    if (!sourceRowId || (params.intent.sourceRowId !== sourceRowId && !(item.kind === 'session'
        && source?.kind === 'session' && source.serverId === item.address.serverId && source.sessionId === item.address.sessionId))) return refuse('unsupported-item');
    if (params.intent.instructionKind === 'blocked') return refuse(params.intent.blockedReason ?? 'blocked-intent');
    const intent = { ...params.intent, scope: item.scope };
    const currentContext = { ...context, latestTree: tree };
    const admission = resolveSessionListDragIntent({ intent, context: currentContext });
    if (!admission.ok) return refuse(admission.relationReason ?? admission.reason,
        intent.targetRowId ? tree.rowMetadataById.get(intent.targetRowId) ?? null : null);
    if (admission.effect === 'manager') {
        if (!context.resolvePutSessionUnder || admission.expectedManagerSessionId === undefined) return refuse('unavailable');
        return { status: 'allowed', effect: { actionId: 'session.manager.set', input: {
            sessionId: admission.source.sessionId!, managerSessionId: admission.lead.sessionId!,
            expectedManagerSessionId: admission.expectedManagerSessionId,
        }, preview: params.preview(admission) } };
    }
    const destination = resolveSessionListTreeDropDestination(admission);
    if (!destination) return refuse('unavailable');
    if (admission.source.metadata.kind === 'folder') {
        return { status: 'allowed', effect: { actionId: 'session.sections.reorder', input: {
            sectionId: admission.source.metadata.folderId!, beforeSectionId: resolveSessionListSectionBeforeId({ ...admission, destination, context }),
        }, preview: params.preview(admission) } };
    }
    const destinationFolderId = resolveSessionListDestinationFolderId(admission.source.metadata, destination.container);
    if (admission.source.metadata.kind === 'session' && admission.source.metadata.folderId !== destinationFolderId) {
        return { status: 'allowed', effect: { actionId: 'session.section.set', input: {
            sessionId: admission.source.metadata.sessionId!, sectionId: destinationFolderId,
        }, preview: params.preview(admission) } };
    }
    const { sourceSnapshotSignature: _signature, ...semanticInput } = intent;
    const parsed = SessionOrganizationMoveInputSchema.safeParse(semanticInput);
    if (!parsed.success) return refuse('invalid_parameters');
    return { status: 'allowed', effect: { actionId: 'session.organization.move', input: parsed.data,
        preview: params.preview(admission) } };
}
