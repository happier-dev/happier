import type { EntityDragItemV1, EntityDragKindV1, EntityDragScopeV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { entityDragScopesEqualV1 } from '@happier-dev/protocol/plugins/ui/entityDragDrop';
import { hrefForDestinationRef, resolveDestinationRefFromHref, type CompactAppDestination } from '../destinations/compactAppDestinationCatalog';
import type { SplitCanvasDropTarget } from '../splitCanvas/model/splitCanvasTypes';
import type { WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { createWorkspaceDestinationSplit } from './workspaceSplit';
import { resolveWorkspaceTabCanvasDrop, resolveWorkspaceTabStripDrop } from './workspaceDropOperations';
import { buildProjectRouteHref } from '@/components/projects/detail/projectRouteState';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import type { PaneDropAdmission } from '../splitCanvas/presentation/paneDropPresentation';

export const WORKSPACE_ENTITY_KINDS: readonly EntityDragKindV1[] = ['workspace-tab', 'session', 'destination', 'repository-file'];

/** Destination catalog and persisted WorkspaceRefs remain the only href authorities. */
export function resolveWorkspaceEntityHref(item: EntityDragItemV1, input: Readonly<{
    scope: EntityDragScopeV1;
    catalog: readonly CompactAppDestination[];
    workspaceRefs: readonly WorkspaceRefV1[];
}>): string | null {
    if (!entityDragScopesEqualV1(item.scope, input.scope)) return null;
    let href: string | null = null;
    if (item.kind === 'destination') href = item.href;
    if (item.kind === 'session') href = hrefForDestinationRef(input.catalog, {
        kind: 'session', params: { id: item.address.sessionId, serverId: item.address.serverId, accountId: item.scope.accountId },
    });
    if (item.kind === 'repository-file' && item.workspaceId) {
        const ref = input.workspaceRefs.find(candidate => candidate.id === item.workspaceId
            && candidate.serverId === item.scope.serverId && candidate.machineId === item.machineId);
        if (ref) href = buildProjectRouteHref({ workspaceRefId: ref.id, segment: 'details',
            activeRootPath: ref.rootPath, defaultRootPath: ref.rootPath, initialResource: { kind: 'file', path: item.path } });
    }
    if (!href) return null;
    const ref = resolveDestinationRefFromHref(input.catalog, href);
    if (!ref || (ref.params.serverId && ref.params.serverId !== input.scope.serverId)
        || (ref.params.accountId && ref.params.accountId !== input.scope.accountId)) return null;
    if (ref.kind === 'project') {
        const workspaceRef = input.workspaceRefs.find(candidate => candidate.id === ref.params.workspaceRefId);
        if (!workspaceRef || workspaceRef.serverId !== input.scope.serverId) return null;
    }
    return hrefForDestinationRef(input.catalog, ref);
}

export function resolveWorkspaceEntityDrop(input: Readonly<{
    workspace: WorkspaceNavigationContextValue;
    scope: EntityDragScopeV1;
    item: EntityDragItemV1;
    target: SplitCanvasDropTarget;
    beforeTabId?: string | null;
    availableSizePx?: number;
    minimumExistingSizePx?: number;
    catalog: readonly CompactAppDestination[];
    workspaceRefs: readonly WorkspaceRefV1[];
}>): PaneDropAdmission {
    const refuse = (code: string): PaneDropAdmission => ({ status: 'refused', reason: { code } });
    const { workspace, item, target, scope } = input;
    if (!workspace.active || workspace.phone || !entityDragScopesEqualV1(item.scope, scope)) return refuse('workspace_scope_unavailable');
    const group = workspace.state.groups[target.leafId];
    if (!group || (workspace.state.maximizedGroupId && workspace.state.maximizedGroupId !== group.id)) return refuse('workspace_group_unavailable');
    let effect: Omit<EntityDropEffectV1, 'preview'>;
    let previewIndex = 0;
    const previewId = () => {
        let id: string;
        do { id = `__drop-preview__:${++previewIndex}`; } while (workspace.state.tabs[id] || workspace.state.groups[id]);
        return id;
    };
    if (item.kind === 'workspace-tab') {
        const source = Object.values(workspace.state.groups).find(candidate => candidate.tabIds.includes(item.tabId));
        if (!source || !workspace.state.tabs[item.tabId]) return refuse('workspace_tab_not_found');
        if (target.placement === 'center') {
            const action = input.beforeTabId === undefined
                ? resolveWorkspaceTabCanvasDrop(workspace.state, { tabId: item.tabId, target, createId: previewId })
                : resolveWorkspaceTabStripDrop(workspace.state, { tabId: item.tabId, groupId: group.id, beforeTabId: input.beforeTabId })[0];
            if (!action) return refuse('workspace_tab_already_here');
            effect = { actionId: source.id === group.id ? 'workspace.tabs.reorder' : 'workspace.tabs.move',
                input: source.id === group.id ? { tabId: item.tabId, beforeTabId: input.beforeTabId ?? null }
                    : { tabId: item.tabId, targetGroupId: group.id, beforeTabId: input.beforeTabId ?? null } };
        } else {
            if (!resolveWorkspaceTabCanvasDrop(workspace.state, { target, tabId: item.tabId,
                    availableSizePx: input.availableSizePx, minimumExistingSizePx: input.minimumExistingSizePx,
                    createId: previewId })) return refuse(source.id === group.id && source.tabIds.length === 1
                        ? 'workspace_tab_cannot_split_own_pane' : 'workspace_split_unavailable');
            effect = { actionId: 'workspace.split', input: { tabId: item.tabId, groupId: group.id, direction: target.placement } };
        }
    } else {
        const href = resolveWorkspaceEntityHref(item, input);
        if (!href) return refuse('workspace_destination_unavailable');
        const existing = workspace.findOpenHref?.(href);
        if (existing) return { status: 'allowed', effect: { actionId: 'workspace.tabs.activate', input: { tabId: existing.tabId } } };
        if (target.placement !== 'center') {
            const destination = resolveDestinationRefFromHref(input.catalog, href);
            if (input.availableSizePx === undefined || input.minimumExistingSizePx === undefined
                || !destination || !createWorkspaceDestinationSplit(workspace.state, {
                    groupId: group.id, tab: { id: previewId(), target: destination, pinned: false, preview: false },
                    direction: target.placement, availableSizePx: input.availableSizePx,
                    minimumExistingSizePx: input.minimumExistingSizePx, createId: previewId,
                })) return refuse('workspace_split_unavailable');
        }
        const mode = target.placement === 'center' ? 'newTab'
            : ({ left: 'splitLeft', right: 'splitRight', up: 'splitUp', down: 'splitDown' } as const)[target.placement];
        effect = { actionId: 'workspace.tabs.open', input: { href, groupId: group.id, mode,
            beforeTabId: input.beforeTabId ?? null, reuseExisting: true } };
    }
    return { status: 'allowed', effect };
}

/** The UI Action executor retains Account custody, policy and the mounted workspace adapter. */
export async function executeWorkspaceEntityDrop(effect: EntityDropEffectV1, scope: EntityDragScopeV1): Promise<EntityDropOutcomeV1> {
    const { isWorkspaceActionId } = await import('@happier-dev/protocol');
    if (!isWorkspaceActionId(effect.actionId)) return { status: 'refused', reason: { code: 'unsupported_action', message: t('common.unavailable') } };
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    try {
        const result = await createDefaultActionExecutor().execute(effect.actionId, effect.input, {
            surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
            authority: 'present_user', actionCaller: { kind: 'host' },
        });
        if (result.ok) return { status: 'applied' };
        return { status: result.errorCode === 'outcome_unknown' || result.errorCode === 'approval_execution_outcome_unknown'
            || result.errorCode === 'server_unreachable' ? 'unknown' : 'refused',
            reason: { code: result.errorCode, message: result.error || t('common.unavailable') } };
    } catch {
        return { status: 'unknown', reason: { code: 'workspace_outcome_unknown', message: t('common.unavailable') } };
    }
}
