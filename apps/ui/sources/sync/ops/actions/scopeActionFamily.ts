import { normalizeSessionListFilterHomeIds } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { ScopeActionInputSchemas, type ScopeActionId, type ScopeActionInputById, type ScopeActionOutputById, type ShellColumn, type FileViewMode, type SettingsColumnFilterColumn, type SettingsColumnFilterV1 } from '@happier-dev/protocol/actions/scopeActionFamily';
import type { FileChangesScope } from '@happier-dev/protocol/scm';
import type { SessionListViewFilterController } from '@/components/sessions/shell/search/useSessionListViewFilterController';
import { resolveSessionListViewContextDefaults } from '@/components/sessions/shell/search/sessionListViewFilters';
import { resolveSessionListFilterScopeAvailability } from '@/components/sessions/shell/search/sessionListFilterEditorModel';
import type { WorkflowLibraryViewController } from '@/components/workflows/library/useWorkflowLibraryView';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { UniversalSearchScopeSeed } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import type { WorkspaceSymbolSearchInput } from '@/components/appShell/search/workspaceSymbolSearchSource';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import type { SettingsCollectionFilter } from '@/components/settings/shell/settingsCollectionAdapter';
import type { DiscussionListFilterV1 } from '@happier-dev/protocol/discussions/listing/discussionListFilterV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

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
  tabs?: readonly string[];
  activeTab?: string;
  label?: string;
  items?: ScopeActionOutputById['shell.column.get']['items'];
  /** Presentation borrowed by the existing Navigation Settings operation. */
  openNavigationCustomizer?(): Promise<void>;
  arrangementAvailable?: boolean;
  selectTab?(tab: string): void;
  setVisible(visible: boolean): void;
}>;

const columnOwners = new Map<ShellColumn, () => ShellColumnActionOwner>();
// Always-mounted chrome (the title strip's arrangement toggle) re-reads the owners when they change.
const columnOwnerListeners = new Set<() => void>();

/** An owner's readable facts changed (registration, or a fact such as `arrangementAvailable`). */
export function notifyShellColumnActionOwnersChanged(): void {
  for (const listener of columnOwnerListeners) listener();
}

export function subscribeShellColumnActionOwners(listener: () => void): () => void {
  columnOwnerListeners.add(listener);
  return () => { columnOwnerListeners.delete(listener); };
}

export type FileEditorActionOwner = Readonly<{
  tabId: string;
  serverId: string | null;
  accountId: string | null;
  editing?: boolean;
  file?: Readonly<{
    scope: WorkspaceScopeBase;
    path: string;
    read(): Readonly<{ savedText: string | null; unsaved: boolean }>;
  }>;
  save(): Promise<ScopeActionOutputById['file.editor.save']>;
  resolve(resolution: ScopeActionInputById['file.editor.resolve']['resolution']): Promise<ScopeActionOutputById['file.editor.resolve']>;
}>;
const fileEditorOwners = new Set<Readonly<{ read: () => FileEditorActionOwner }>>();
const fileEditorOwnerListeners = new Set<() => void>();

export function notifyFileEditorActionOwnersChanged(): void {
  for (const listener of fileEditorOwnerListeners) listener();
}

export function subscribeFileEditorActionOwners(listener: () => void): () => void {
  fileEditorOwnerListeners.add(listener);
  return () => { fileEditorOwnerListeners.delete(listener); };
}

/** Resolve commands and text from the mounted P4 owner; no copied document store. */
export function readWorkspaceFileEditorHolder(scope: WorkspaceScopeBase, accountId: string, path: string): FileEditorActionOwner | null {
  return [...fileEditorOwners].map(owner => owner.read()).filter(owner => owner.accountId === accountId
    && owner.serverId === scope.serverId && owner.file?.scope.machineId === scope.machineId
    && owner.file.scope.rootPath === scope.rootPath && owner.file.path === path).at(-1) ?? null;
}

/** The registration exposes commands/readers only; the mounted hook owns the buffer and writes. */
export function registerFileEditorActionOwner(read: () => FileEditorActionOwner): () => void {
  // Tab ids are scope-local; the token gives each mounted registration its exact cleanup.
  const owner = { read };
  fileEditorOwners.add(owner);
  notifyFileEditorActionOwnersChanged();
  return () => { fileEditorOwners.delete(owner); notifyFileEditorActionOwnersChanged(); };
}

export type FileViewActionOwner = Readonly<{
  tabId: string;
  active: boolean;
  serverId: string | null;
  accountId: string | null;
  mode: FileViewMode;
  changesScope?: FileChangesScope;
  blame: boolean;
  availableModes: readonly FileViewMode[];
  blameAvailable: boolean;
  changesScopeAvailable: boolean;
  /** Presented page facts, independent of DOM focus; the page retains the document holder. */
  search?: Readonly<{ scope: UniversalSearchScopeSeed; symbols?: WorkspaceSymbolSearchInput }>;
  set(patch: Omit<ScopeActionInputById['file.view.set'], 'tabId'>): boolean | Promise<boolean>;
}>;
const fileViewOwners = new Map<string, () => FileViewActionOwner>();

/** Private mounted target retained by one UI invocation through Inbox approval. No copied view state. */
export type MountedScopeActionOwner =
  Readonly<{ kind: 'shell.column'; column: ShellColumn; read: () => ShellColumnActionOwner }>;

/** Mounted controller bridge only: the pane tab remains the sole view-state owner. */
export function registerFileViewActionOwner(key: string, read: () => FileViewActionOwner): () => void {
  fileViewOwners.set(key, read);
  return () => { if (fileViewOwners.get(key) === read) fileViewOwners.delete(key); };
}
function selectFileViewActionOwner(tabId: string | undefined,
  context?: Pick<ActionExecutorContext, 'serverId' | 'runtimeAccountId'>): FileViewActionOwner | null {
  const owners = [...fileViewOwners.values()].map(read => read()).filter(owner =>
    (tabId ? owner.tabId === tabId : owner.active)
    && (!context?.serverId || owner.serverId === context.serverId)
    && (!context?.runtimeAccountId || owner.accountId === context.runtimeAccountId));
  // Ambiguous unaddressed surfaces cannot choose another page's state.
  return owners.length === 1 ? owners[0]! : null;
}

/** The File page `file.view.get/set` would address with no tab id; the palette reads it to offer its commands. */
export function readActiveFileViewActionOwner(): FileViewActionOwner | null {
  return selectFileViewActionOwner(undefined);
}
export type DiscussionListScopeActionController = Readonly<{
  lifetime: ServerAccountScopeLifetime;
  focused: boolean;
  filters: DiscussionListFilterV1;
  searchQuery: string;
  selectedSpaceId: string;
  coverage: 'complete' | 'partial' | 'unavailable';
  update(patch: Readonly<{ filters?: Partial<DiscussionListFilterV1>; searchQuery?: string }>): boolean;
  reset(): boolean;
}>;
const discussionListOwners = new Set<() => DiscussionListScopeActionController>();

export function registerDiscussionListScopeActionOwner(read: () => DiscussionListScopeActionController): () => void {
  discussionListOwners.add(read);
  return () => { discussionListOwners.delete(read); };
}

export type SettingsColumnFilterScopeActionController = Readonly<{
  column: SettingsColumnFilterColumn;
  lifetime: ServerAccountScopeLifetime;
  presented: boolean;
  filters: SettingsCollectionFilter;
  searchQuery?: string;
  setSearchQuery?: (query: string) => void;
  result: EntityListFilterResultV1;
  set(filters: SettingsColumnFilterV1): boolean;
  clear(): void;
}>;
const settingsColumnFilterOwners = new Set<() => SettingsColumnFilterScopeActionController | null>();

/** Readers and commands only: the mounted column keeps the sole transient filter draft. */
export function registerSettingsColumnFilterScopeActionOwner(read: () => SettingsColumnFilterScopeActionController | null): () => void {
  settingsColumnFilterOwners.add(read);
  return () => { settingsColumnFilterOwners.delete(read); };
}

let readLibraryOwner: (() => WorkflowLibraryViewController) | null = null;

/** The focused Library joins the same client-local view-control bridge as Sessions and shell chrome. */
export function registerWorkflowLibraryScopeActionOwner(read: () => WorkflowLibraryViewController): () => void {
  readLibraryOwner = read;
  return () => { if (readLibraryOwner === read) readLibraryOwner = null; };
}

export function registerShellColumnActionOwner(column: ShellColumn, read: () => ShellColumnActionOwner): () => void {
  columnOwners.set(column, read);
  notifyShellColumnActionOwnersChanged();
  return () => {
    if (columnOwners.get(column) !== read) return;
    columnOwners.delete(column);
    notifyShellColumnActionOwnersChanged();
  };
}

export function readShellColumnActionOwner(column: ShellColumn): ShellColumnActionOwner | null {
  return columnOwners.get(column)?.() ?? null;
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

export async function invokeScopeAction(actionId: ScopeActionId, rawInput: unknown,
  context?: Pick<ActionExecutorContext, 'serverId' | 'runtimeAccountId'>,
  mountedOwner?: MountedScopeActionOwner): Promise<unknown> {
  // Persisted viewer intent belongs to the captured Account adapter, never a mounted view owner.
  if (actionId === 'file.view.preference.set') return unavailable('client_control_unavailable');
  if (actionId === 'settings.column.filter.get' || actionId === 'settings.column.filter.set' || actionId === 'settings.column.filter.clear') {
    const input = ScopeActionInputSchemas[actionId].parse(rawInput);
    const owners = [...settingsColumnFilterOwners].map(read => read()).filter(owner => owner !== null
      && owner.column === input.column && owner.presented && owner.lifetime.isCurrent()
      && areServerProfileIdentifiersEquivalent(owner.lifetime.scope.serverId, input.serverId)
      && owner.lifetime.scope.accountId === input.accountId
      && (!context?.serverId || areServerProfileIdentifiersEquivalent(owner.lifetime.scope.serverId, context.serverId))
      && (!context?.runtimeAccountId || owner.lifetime.scope.accountId === context.runtimeAccountId));
    // A hidden, retired or ambiguous surface cannot be picked by registration order.
    if (owners.length !== 1 || !owners[0]) return unavailable('client_surface_unavailable');
    const owner = owners[0];
    if (actionId === 'settings.column.filter.get') return {
      column: owner.column, serverId: owner.lifetime.scope.serverId, accountId: owner.lifetime.scope.accountId,
      filters: owner.filters, ...owner.result,
      ...(owner.searchQuery !== undefined ? { searchQuery: owner.searchQuery } : {}),
    };
    if (actionId === 'settings.column.filter.clear') {
      owner.clear();
      return { ok: true };
    }
    const next = ScopeActionInputSchemas['settings.column.filter.set'].parse(rawInput);
    // Refuse an unsupported query before changing any conditions.
    if (next.searchQuery !== undefined && !owner.setSearchQuery) return unavailable('client_control_unavailable');
    if (!owner.set(next.filters)) return unavailable('client_control_unavailable');
    if (next.searchQuery !== undefined) owner.setSearchQuery!(next.searchQuery);
    return { ok: true };
  }
  if (actionId === 'file.editor.save' || actionId === 'file.editor.resolve') {
    const input = ScopeActionInputSchemas[actionId].parse(rawInput);
    const owners = [...fileEditorOwners].map(owner => owner.read()).filter(owner =>
      owner.editing !== false && (!input.tabId || owner.tabId === input.tabId)
      && (!context?.serverId || owner.serverId === context.serverId)
      && (!context?.runtimeAccountId || owner.accountId === context.runtimeAccountId));
    const owner = owners.at(-1);
    if (!owner) return { status: 'unavailable' };
    return actionId === 'file.editor.save' ? owner.save()
      : owner.resolve(ScopeActionInputSchemas['file.editor.resolve'].parse(rawInput).resolution);
  }
  if (actionId === 'file.view.get' || actionId === 'file.view.set') {
    const input = ScopeActionInputSchemas[actionId].parse(rawInput);
    const owner = selectFileViewActionOwner(input.tabId, context);
    if (!owner) return unavailable('client_surface_unavailable');
    if (actionId === 'file.view.get') return { tabId: owner.tabId, mode: owner.mode, blame: owner.blame,
      ...(owner.changesScope ? { changesScope: owner.changesScope } : {}) };
    const { tabId: _tabId, ...patch } = ScopeActionInputSchemas['file.view.set'].parse(rawInput);
    if ((patch.mode !== undefined && !owner.availableModes.includes(patch.mode))
      || (patch.blame !== undefined && !owner.blameAvailable)
      || (patch.changesScope !== undefined && !owner.changesScopeAvailable)) return unavailable('client_control_unavailable');
    return await owner.set(patch) ? { ok: true } : unavailable('client_control_unavailable');
  }
  if (actionId === 'workflow.library.view.get' || actionId === 'workflow.library.view.set' || actionId === 'workflow.library.view.reset') {
    const controller = readLibraryOwner?.();
    if (!controller?.focused || !controller.lifetime?.isCurrent()
      || (context?.serverId && !selectActiveServerAccountScopeForServer(controller.lifetime.scope, context.serverId))
      || (context?.runtimeAccountId && context.runtimeAccountId !== controller.lifetime.scope.accountId)) {
      return unavailable('client_surface_unavailable');
    }
    ScopeActionInputSchemas[actionId].parse(rawInput);
    if (actionId === 'workflow.library.view.get') return {
      view: controller.view, searchQuery: controller.searchQuery,
      offeredViews: controller.offeredViews, visibleKeys: controller.visibleKeys,
    };
    const patch = actionId === 'workflow.library.view.reset' ? { view: 'all' as const, searchQuery: '' }
      : ScopeActionInputSchemas['workflow.library.view.set'].parse(rawInput);
    return controller.update(patch) ? { ok: true } : unavailable('client_control_unavailable');
  }
  if (actionId === 'discussion.list.view.get' || actionId === 'discussion.list.view.set' || actionId === 'discussion.list.view.reset') {
    const input = ScopeActionInputSchemas[actionId].parse(rawInput);
    const owners = [...discussionListOwners].map(read => read()).filter(owner => owner.focused && owner.lifetime.isCurrent()
      && areServerProfileIdentifiersEquivalent(owner.lifetime.scope.serverId, input.serverId)
      && owner.lifetime.scope.accountId === input.accountId
      && (!context?.serverId || areServerProfileIdentifiersEquivalent(owner.lifetime.scope.serverId, context.serverId))
      && (!context?.runtimeAccountId || owner.lifetime.scope.accountId === context.runtimeAccountId));
    if (owners.length !== 1) return unavailable('client_surface_unavailable');
    const controller = owners[0]!;
    if (actionId === 'discussion.list.view.get') return {
      serverId: controller.lifetime.scope.serverId,
      accountId: controller.lifetime.scope.accountId,
      filters: controller.filters, searchQuery: controller.searchQuery, selectedSpaceId: controller.selectedSpaceId, coverage: controller.coverage,
    };
    const accepted = actionId === 'discussion.list.view.reset' ? controller.reset()
      : controller.update(ScopeActionInputSchemas['discussion.list.view.set'].parse(rawInput));
    return accepted ? { ok: true } : unavailable('client_control_unavailable');
  }
  if (actionId === 'shell.column.get' || actionId === 'shell.column.set') {
    const input = ScopeActionInputSchemas[actionId].parse(rawInput);
    const columnId = input.column ?? 'navigation';
    const column = mountedOwner?.kind === 'shell.column'
      ? mountedOwner.column === columnId ? mountedOwner.read() : null
      : readShellColumnActionOwner(columnId);
    if (!column) return unavailable('client_surface_unavailable');
    if (actionId === 'shell.column.get') return { present: column.present, visible: column.visible, available: column.available,
      ...(column.tabs ? { tabs: column.tabs } : {}), ...(column.activeTab === undefined ? {} : { activeTab: column.activeTab }),
      ...(column.label === undefined ? {} : { label: column.label }), ...(column.items === undefined ? {} : { items: column.items }) };
    const update = ScopeActionInputSchemas['shell.column.set'].parse(rawInput);
    if (!column.present || !column.available) return unavailable('client_control_unavailable');
    if (update.tab !== undefined) {
      if (!column.selectTab || !column.tabs?.includes(update.tab)
        || column.items?.some(item => item.id === update.tab && !item.available)) return unavailable('client_control_unavailable');
      column.selectTab(update.tab);
    } else {
      column.setVisible(update.visible);
    }
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
