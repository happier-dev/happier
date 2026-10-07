import { normalizeSessionListFilterHomeIds } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { ScopeActionInputSchemas, type ScopeActionId, type ScopeActionInputById } from '@happier-dev/protocol/actions/scopeActionFamily';
import type { SessionListViewFilterController } from '@/components/sessions/shell/search/useSessionListViewFilterController';
import { resolveSessionListViewContextDefaults } from '@/components/sessions/shell/search/sessionListViewFilters';
import { resolveSessionListFilterScopeAvailability } from '@/components/sessions/shell/search/sessionListFilterEditorModel';

export type SessionListScopeActionController = Pick<SessionListViewFilterController,
  'filters' | 'updateFilters' | 'resetFilters' | 'viewContext' | 'viewContextKey' | 'corpusStorage'
  | 'retentionScopeKey'
  | 'includeInactive' | 'setIncludeInactive' | 'setSource' | 'queryEnabled' | 'followingAvailable'
  | 'sourceAvailable' | 'homeOptions' | 'fixedHomeServerIds'>;

type SessionListActionOwner = Readonly<{
  read: () => SessionListScopeActionController;
  retentionScopeKey: string;
}>;
const sessionListOwners = new Map<string, SessionListActionOwner>();
function sessionListOwnerKey(storage: string, contextKey: string): string {
  return JSON.stringify([storage, contextKey]);
}

export function registerSessionListScopeActionOwner(read: () => SessionListScopeActionController): () => void {
  const controller = read();
  const key = sessionListOwnerKey(controller.corpusStorage, controller.viewContextKey);
  const owner = { read, retentionScopeKey: controller.retentionScopeKey };
  sessionListOwners.set(key, owner);
  return () => { if (sessionListOwners.get(key) === owner) sessionListOwners.delete(key); };
}

export type ShellColumnActionOwner = Readonly<{
  present: boolean;
  visible: boolean;
  available: boolean;
  setVisible(visible: boolean): void;
}>;

let readColumnOwner: (() => ShellColumnActionOwner) | null = null;

export function registerShellColumnActionOwner(read: () => ShellColumnActionOwner): () => void {
  readColumnOwner = read;
  return () => { if (readColumnOwner === read) readColumnOwner = null; };
}

function unavailable(errorCode: 'client_surface_unavailable' | 'client_control_unavailable') {
  return { ok: false, errorCode, error: errorCode };
}

function readSessionListOwner(input: ScopeActionInputById['session.list.view.get']): SessionListScopeActionController | null {
  const view = input.view ?? { kind: 'global' };
  const viewContext = view.kind === 'global' ? view : { kind: 'team' as const, team: { serverId: view.serverId, teamId: view.teamId } };
  const context = resolveSessionListViewContextDefaults(viewContext, [], 'all');
  const storage = input.storage ?? 'active';
  const owner = sessionListOwners.get(sessionListOwnerKey(storage, context.contextKey));
  const controller = owner?.read();
  return controller?.viewContextKey === context.contextKey && controller.corpusStorage === storage
    && controller.retentionScopeKey === owner?.retentionScopeKey ? controller : null;
}

export async function invokeScopeAction(actionId: ScopeActionId, rawInput: unknown): Promise<unknown> {
  if (actionId === 'shell.column.get' || actionId === 'shell.column.set') {
    const column = readColumnOwner?.();
    if (!column) return unavailable('client_surface_unavailable');
    if (actionId === 'shell.column.get') return { present: column.present, visible: column.visible, available: column.available };
    const input = ScopeActionInputSchemas[actionId].parse(rawInput);
    if (!column.present || !column.available) return unavailable('client_control_unavailable');
    column.setVisible(input.visible);
    return { ok: true };
  }
  const input = ScopeActionInputSchemas[actionId].parse(rawInput);
  const controller = readSessionListOwner(input);
  if (!controller) return unavailable('client_surface_unavailable');
  if (actionId === 'session.list.view.get') return {
    view: controller.viewContext.kind === 'global' ? { kind: 'global' } : { kind: 'team', ...controller.viewContext.team },
    storage: controller.corpusStorage,
    filters: controller.filters,
    includeInactive: controller.includeInactive,
    queryEnabled: controller.queryEnabled,
    followingAvailable: controller.followingAvailable,
    sourceAvailable: controller.sourceAvailable,
    homes: controller.homeOptions,
  };
  if (actionId === 'session.list.view.reset') {
    controller.resetFilters();
    return { ok: true };
  }
  const update = ScopeActionInputSchemas['session.list.view.set'].parse(rawInput);
  const patch = update.filters ?? {};
  const requestedHomes = patch.homeServerIds === undefined ? undefined : normalizeSessionListFilterHomeIds(patch.homeServerIds);
  const scopeAvailability = resolveSessionListFilterScopeAvailability(controller);
  if ((patch.scope !== undefined && !scopeAvailability[patch.scope])
    || (patch.attention !== undefined && !controller.queryEnabled)
    || (patch.audiences !== undefined && !controller.queryEnabled)
    || (patch.source !== undefined && !controller.sourceAvailable)
    || (update.includeInactive !== undefined && controller.corpusStorage === 'archived')
    || (requestedHomes?.some((id) => !controller.homeOptions.some((home) => home.serverId === id)))
    || (controller.fixedHomeServerIds && requestedHomes !== undefined
      && (requestedHomes.some((id) => !controller.fixedHomeServerIds?.has(id))
        || [...controller.fixedHomeServerIds].some((id) => !requestedHomes.includes(id))))) {
    return unavailable('client_control_unavailable');
  }
  const { source, ...filterPatch } = patch;
  if (Object.keys(filterPatch).length > 0) controller.updateFilters((current) => ({ ...current, ...filterPatch }));
  // The existing device preference writer remains authoritative for these facets.
  if (source !== undefined) controller.setSource(source);
  if (update.includeInactive !== undefined) controller.setIncludeInactive(update.includeInactive);
  return { ok: true };
}
