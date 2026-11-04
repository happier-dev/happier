import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveWorkspaceDisplayPresentation } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { LruMap } from '@/utils/cache/lruMap';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { machineCollectionValues, type MachineCollection } from '@/sync/domains/machines/identity/machineCollection';
import { buildProjectGroupDisplayIndex, projectGroupIdentityKey, type ProjectGroupDisplay } from '@/sync/domains/workspaces/projectGroupDisplay';
import type { ProjectOrganizationRow } from '@/sync/domains/workspaces/projectAccountRows';
import type { SessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import type { SessionOrganizationDisplayState } from '@/sync/domains/session/organization/types';
import { buildSessionOrganizationLabelKey } from '@/sync/domains/session/organization/keys';
import { buildLegacySessionWorkspaceAliasIndex, type LegacyWorkspaceAliasMachine } from '@/sync/domains/session/listing/legacySessionWorkspaceAliases';
import { t } from '@/text';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

export type SessionListProjectHeaderViewModel = Readonly<{
    collapseKey: string;
    displayTitle: string;
    hasCustomLabel: boolean;
    workspaceRefId: string | null;
    legacyWorkspaceKey: string;
    scopeHint: WorkspaceScopeBase | null;
    seedSessionId: string | null;
    machineSubtitle?: string;
    serverId?: string | null;
    /** The list projection's collision name and single group-wide offline message. */
    machineDetail?: string;
}>;

export type SessionListProjectHeaderViewModelState = Readonly<{
    projectHeaderViewModelByGroupKey: Map<string, SessionListProjectHeaderViewModel>;
    scopeHintByLegacyWorkspaceKey: Map<string, WorkspaceScopeBase>;
    /** The shared Project display index (title, accepted baseline), for rows in every layout. */
    projectDisplayByKey: ReadonlyMap<string, ProjectGroupDisplay>;
    /** Each Project group's own Project, so its rows know what the group already implies. */
    groupProjectByGroupKey: ReadonlyMap<string, QualifiedProjectKeyV1>;
}>;

const EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE: SessionListProjectHeaderViewModelState = {
    projectHeaderViewModelByGroupKey: new Map<string, SessionListProjectHeaderViewModel>(),
    scopeHintByLegacyWorkspaceKey: new Map<string, WorkspaceScopeBase>(),
    projectDisplayByKey: new Map<string, ProjectGroupDisplay>(),
    groupProjectByGroupKey: new Map<string, QualifiedProjectKeyV1>(),
};
const NO_CHECKOUT_REFS: readonly WorkspaceRefV1[] = [];

const SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE = new LruMap<string, ProjectHeaderCache>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

function appendCachePart(parts: string[], value: string): void {
    parts.push(value);
}

type ProjectHeaderProjectionInput = Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    workspaceLabels?: Readonly<Record<string, string> | null | undefined>;
    workspaceRefsServerId?: string;
    legacyWorkspaceLabelDisplayStatesByKey?: Readonly<Record<string,
        SessionOrganizationListViewState['labelDisplayStatesByKey'][string] | SessionOrganizationDisplayState>>;
    projectOrganizations?: readonly ProjectOrganizationRow[];
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    machinesById?: MachineCollection<Pick<MachineDisplayRenderable, 'id' | 'metadata' | 'availability'> & Partial<LegacyWorkspaceAliasMachine>>;
}>;

type MachineNameSource = Parameters<typeof resolveMachineDisplayNames>[0][number];
type ProjectHeaderCache = {
    input: Omit<ProjectHeaderProjectionInput, 'machinesById' | 'listItems' | 'workspaceLabels' | 'projectOrganizations' | 'legacyWorkspaceLabelDisplayStatesByKey'>;
    listInputs: WeakSet<ReadonlyArray<SessionListIndexItem>>;
    organizationInputs: WeakSet<readonly ProjectOrganizationRow[]>;
    hasOrganizations: boolean;
    state: SessionListProjectHeaderViewModelState;
    machines: Map<string, MachineNameSource>;
    names: Map<string, string>;
    idsByName: Map<string, Set<string>>;
    headersByMachine: Map<string, Map<string, string | undefined>>;
    fallbackMachines: Map<string, MachineNameSource>;
    hasMachineInventory: boolean;
    migrationMachineInputs: Map<string, string>;
    migrationAliases?: ReadonlyMap<string, WorkspaceScopeBase | null>;
    migrationLabelsKey?: string;
    baseScopeHints?: Map<string, WorkspaceScopeBase>;
};

function refreshLegacyLabelHints(cache: ProjectHeaderCache, input: ProjectHeaderProjectionInput): void {
    if (!cache.baseScopeHints) return;
    const home = input.workspaceRefsServerId;
    const labels = Object.entries(input.workspaceLabels ?? {}).filter(([key]) => /^wl_[0-9a-f]{8}$/.test(key));
    const admittedLabels: Array<readonly [string, string]> = [];
    for (const [key, label] of labels) {
        if (!home) continue;
        const display = input.legacyWorkspaceLabelDisplayStatesByKey?.[buildSessionOrganizationLabelKey({
            serverId: home, labelKind: 'workspace', scopeKey: key,
        })];
        if (display?.status !== 'available') continue;
        const value = display.value;
        const currentLabel = typeof value === 'string' ? value
            : value && typeof value === 'object' && 'label' in value && typeof value.label === 'string' ? value.label : undefined;
        if (currentLabel === label) admittedLabels.push([key, label]);
    }
    const labelsKey = JSON.stringify([home, admittedLabels]);
    if (cache.migrationLabelsKey === labelsKey && (admittedLabels.length === 0 || cache.migrationAliases)) return;
    cache.migrationLabelsKey = labelsKey;
    const hints = new Map(cache.baseScopeHints);
    // Unqualified predecessor keys are admitted only through the captured Home's opened label.
    for (const key of hints.keys()) if (/^wl_[0-9a-f]{8}$/.test(key)) hints.delete(key);
    if (home && admittedLabels.length) {
        if (!cache.migrationAliases) {
            const aliases = new Map<string, WorkspaceScopeBase | null>();
            for (const [key, ref] of buildLegacySessionWorkspaceAliasIndex(input.workspaceRefs, home, input.machinesById)) {
                aliases.set(key, ref ? { serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath } : null);
            }
            // Retain only the migration address, not superseded ref/repository bodies.
            cache.migrationAliases = aliases;
        }
        for (const [key] of admittedLabels) {
            const scope = cache.migrationAliases.get(key);
            if (scope) hints.set(key, scope);
        }
    }
    cache.state = { ...cache.state, scopeHintByLegacyWorkspaceKey: hints };
}

function sameMachineNameInput(left: MachineNameSource | undefined, right: MachineNameSource | undefined): boolean {
    return left === right || Boolean(left && right
        && left.absence === right.absence
        && left.availability?.kind === right.availability?.kind
        && (left.metadata === null) === (right.metadata === null)
        && left.metadata?.displayName === right.metadata?.displayName
        && left.metadata?.host === right.metadata?.host);
}

function captureMachineNameInput(source: MachineNameSource): MachineNameSource {
    return { id: source.id, absence: source.absence,
        metadata: source.metadata ? { displayName: source.metadata.displayName, host: source.metadata.host } : source.metadata,
        availability: source.availability ? { kind: source.availability.kind } : source.availability };
}

/** Update only changed name collision groups, then only headers naming those Machines. */
function refreshMachineNames(cache: ProjectHeaderCache, input: ProjectHeaderProjectionInput): SessionListProjectHeaderViewModelState {
    const changedGroups = new Set<string>();
    const removedIds = new Set(cache.machines.keys());
    const update = (id: string, next: MachineNameSource | undefined) => {
        removedIds.delete(id);
        const previous = cache.machines.get(id);
        if (sameMachineNameInput(previous, next)) return;
        if (previous) {
            const group = getMachineDisplayName(previous).toLocaleLowerCase();
            cache.idsByName.get(group)?.delete(id);
            changedGroups.add(group);
        }
        if (next) {
            const group = getMachineDisplayName(next).toLocaleLowerCase();
            const ids = cache.idsByName.get(group) ?? new Set<string>();
            ids.add(id);
            cache.idsByName.set(group, ids);
            changedGroups.add(group);
            // This cache owns labels, not retained fleet/inventory payloads.
            cache.machines.set(id, captureMachineNameInput(next));
        } else cache.machines.delete(id);
    };
    for (const machine of machineCollectionValues(input.machinesById)) update(machine.id, machine);
    for (const id of removedIds) update(id, cache.fallbackMachines.get(id));
    // Fallbacks are added only once, including groups which never held an inventory record.
    for (const [id, machine] of cache.fallbackMachines) if (!cache.machines.has(id)) update(id, machine);
    const changedIds = new Set<string>();
    for (const group of changedGroups) {
        const ids = cache.idsByName.get(group);
        if (!ids?.size) { cache.idsByName.delete(group); continue; }
        const names = resolveMachineDisplayNames([...ids].map(id => cache.machines.get(id)!));
        for (const [id, name] of names) if (cache.names.get(id) !== name) {
            cache.names.set(id, name);
            changedIds.add(id);
        }
    }
    for (const id of [...cache.names.keys()]) if (!cache.machines.has(id)) { cache.names.delete(id); changedIds.add(id); }
    let headers = cache.state.projectHeaderViewModelByGroupKey;
    for (const id of changedIds) for (const [key, fallbackSubtitle] of cache.headersByMachine.get(id) ?? []) {
        const previous = headers.get(key);
        const machineSubtitle = cache.names.get(id) ?? fallbackSubtitle;
        if (!previous || previous.machineSubtitle === machineSubtitle) continue;
        if (headers === cache.state.projectHeaderViewModelByGroupKey) headers = new Map(headers);
        headers.set(key, { ...previous, machineSubtitle });
    }
    if (headers !== cache.state.projectHeaderViewModelByGroupKey) cache.state = { ...cache.state, projectHeaderViewModelByGroupKey: headers };
    return cache.state;
}

/** Refresh incumbent Machine labels and Project migration inputs in the same bounded cache. */
function refreshMachineInputs(cache: ProjectHeaderCache, input: ProjectHeaderProjectionInput): SessionListProjectHeaderViewModelState {
    refreshMachineNames(cache, input);
    const removedMigrationIds = new Set(cache.migrationMachineInputs.keys());
    const needsLegacyMachineFacts = Object.keys(input.workspaceLabels ?? {})
        .some(key => /^wl_[0-9a-f]{8}$/.test(key));
    for (const machine of machineCollectionValues(input.machinesById)) {
        if (!needsLegacyMachineFacts) continue;
        removedMigrationIds.delete(machine.id);
        const facts = JSON.stringify([machine.metadata?.homeDir, machine.replacedByMachineId, machine.replacedAt]);
        if (cache.migrationMachineInputs.get(machine.id) !== facts) {
            cache.migrationMachineInputs.set(machine.id, facts);
            cache.migrationAliases = undefined;
        }
    }
    for (const id of removedMigrationIds) { cache.migrationMachineInputs.delete(id); cache.migrationAliases = undefined; }
    const { machinesById: _machines, listItems, workspaceLabels: _legacyLabels, projectOrganizations,
        legacyWorkspaceLabelDisplayStatesByKey: _legacyDisplays, ...structuralInput } = input;
    cache.listInputs.add(listItems);
    if (projectOrganizations) cache.organizationInputs.add(projectOrganizations);
    cache.hasOrganizations = projectOrganizations !== undefined;
    cache.input = structuralInput;
    refreshLegacyLabelHints(cache, input);
    return cache.state;
}

export function readSessionListProjectHeaderMachineId(item: Extract<SessionListIndexItem, { type: 'header' }>, _workspaceRefs: readonly WorkspaceRefV1[],
    displayByProject?: ReadonlyMap<string, ProjectGroupDisplay>): string | null {
    if (item.projectKey) return displayByProject
        ? displayByProject.get(projectGroupIdentityKey(item.projectKey))?.baseline?.machineId ?? null
        : item.workspaceScopeHint?.machineId ?? null;
    const workspace = item.workspace;
    return item.workspaceScopeHint?.machineId ?? item.machine?.id
        ?? (workspace?.t === 'workspaceRef' ? null : workspace?.machineId) ?? null;
}

function buildSessionListProjectHeaderViewModelStateCacheKey(input: ProjectHeaderProjectionInput,
    displayByProject: ReadonlyMap<string, ProjectGroupDisplay>): string {
    const parts: string[] = ['session-list-project-header-view-model-state'];
    appendCachePart(parts, `machineInventory:${input.machinesById !== undefined}`);
    appendCachePart(parts, `censusHome:${input.workspaceRefsServerId ?? ''}`);

    for (const row of input.projectOrganizations ?? []) {
        appendCachePart(parts, JSON.stringify(['projectLabel', projectGroupIdentityKey(row.key), row.value.label ?? null]));
    }

    for (const workspaceRef of input.workspaceRefs) {
        appendCachePart(parts, JSON.stringify([
            'workspaceRef',
            String(workspaceRef.id ?? ''),
            String(workspaceRef.serverId ?? ''),
            String(workspaceRef.machineId ?? ''),
            String(workspaceRef.rootPath ?? ''),
            String(workspaceRef.label ?? ''),
            String(workspaceRef.projectKey ?? ''),
            String(workspaceRef.createdAtMs),
        ]));
    }

    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') {
            continue;
        }

        appendCachePart(parts, JSON.stringify([
            'projectHeader',
            String(item.groupKey ?? ''),
            String(item.title ?? ''),
            String(item.workspaceKey ?? ''),
            item.projectKey ? projectGroupIdentityKey(item.projectKey) : '',
            String(item.workspace?.t ?? ''),
            JSON.stringify(item.workspace ?? null),
            String(item.workspaceScopeHint?.serverId ?? ''),
            String(item.workspaceScopeHint?.machineId ?? ''),
            String(item.workspaceScopeHint?.rootPath ?? ''),
            String(item.seedSessionId ?? ''),
            String(item.serverId ?? ''),
            String(item.serverName ?? ''),
            String(readSessionListProjectHeaderMachineId(item, input.workspaceRefs, displayByProject) ?? ''),
        ]));
    }

    appendCachePart(parts, `workspacePathDisplayMode:${input.workspacePathDisplayModeV1 ?? 'name'}`);

    return JSON.stringify(parts);
}

function shallowEqual(left: object, right: object): boolean {
    if (left === right) return true;
    const l = left as Record<string, unknown>;
    const r = right as Record<string, unknown>;
    const keys = Object.keys(l);
    if (keys.length !== Object.keys(r).length) return false;
    return keys.every(key => l[key] === r[key] || (isPlainRecord(l[key]) && isPlainRecord(r[key]) && shallowEqual(l[key], r[key])));
}

function isPlainRecord(value: unknown): value is object {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep the previous entry object for every key whose content is unchanged; keep the whole map when none changed. */
function reuseEqualEntries<K, V extends object | null>(previous: ReadonlyMap<K, V>, next: Map<K, V>): Map<K, V> {
    let allSame = previous.size === next.size;
    for (const [key, value] of next) {
        const old = previous.get(key);
        if (old !== undefined && (old === value || (old !== null && value !== null && shallowEqual(old, value)))) next.set(key, old);
        else allSame = false;
    }
    return allSame ? previous as Map<K, V> : next;
}

let lastBuiltState: SessionListProjectHeaderViewModelState | null = null;

function reuseEqualHeaderState(previous: SessionListProjectHeaderViewModelState | null,
    next: SessionListProjectHeaderViewModelState): SessionListProjectHeaderViewModelState {
    if (!previous) return next;
    const state: SessionListProjectHeaderViewModelState = {
        projectHeaderViewModelByGroupKey: reuseEqualEntries(previous.projectHeaderViewModelByGroupKey, next.projectHeaderViewModelByGroupKey),
        scopeHintByLegacyWorkspaceKey: reuseEqualEntries(previous.scopeHintByLegacyWorkspaceKey, next.scopeHintByLegacyWorkspaceKey),
        projectDisplayByKey: reuseEqualEntries(previous.projectDisplayByKey, next.projectDisplayByKey as Map<string, ProjectGroupDisplay>),
        groupProjectByGroupKey: reuseEqualEntries(previous.groupProjectByGroupKey, next.groupProjectByGroupKey as Map<string, QualifiedProjectKeyV1>),
    };
    return state.projectHeaderViewModelByGroupKey === previous.projectHeaderViewModelByGroupKey
        && state.scopeHintByLegacyWorkspaceKey === previous.scopeHintByLegacyWorkspaceKey
        && state.projectDisplayByKey === previous.projectDisplayByKey
        && state.groupProjectByGroupKey === previous.groupProjectByGroupKey ? previous : state;
}

let lastDisplayIndex: Readonly<{ refs: WeakRef<readonly WorkspaceRefV1[]>; organizations: WeakRef<readonly ProjectOrganizationRow[]> | undefined;
    index: ReadonlyMap<string, ProjectGroupDisplay> }> | null = null;

/** The 1,000+ entry index depends only on refs and organizations; rebuild on new input identity and keep equal entries. */
function readProjectDisplayIndex(refs: readonly WorkspaceRefV1[],
    organizations: readonly ProjectOrganizationRow[] | undefined): ReadonlyMap<string, ProjectGroupDisplay> {
    // Weak identities: superseded organization bodies must stay collectable.
    if (lastDisplayIndex?.refs.deref() === refs && lastDisplayIndex.organizations?.deref() === organizations
        && (organizations !== undefined || lastDisplayIndex.organizations === undefined)) return lastDisplayIndex.index;
    const built = new Map(buildProjectGroupDisplayIndex(refs, organizations));
    const index = lastDisplayIndex ? reuseEqualEntries(lastDisplayIndex.index, built) : built;
    lastDisplayIndex = { refs: new WeakRef(refs), organizations: organizations ? new WeakRef(organizations) : undefined, index };
    return index;
}

export function buildSessionListProjectHeaderViewModels(input: ProjectHeaderProjectionInput): SessionListProjectHeaderViewModelState {
    // The same bounded cache owns structural projection and keyed Machine invalidation.
    // Serialize structural inputs only after they change, never on a Machine receipt.
    for (const cached of SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.values()) {
        if (cached.listInputs.has(input.listItems) && cached.input.workspaceRefs === input.workspaceRefs
            && (input.projectOrganizations ? cached.organizationInputs.has(input.projectOrganizations) : !cached.hasOrganizations)
            && cached.hasMachineInventory === (input.machinesById !== undefined)
            && cached.input.workspaceRefsServerId === input.workspaceRefsServerId
            && cached.input.workspacePathDisplayModeV1 === input.workspacePathDisplayModeV1) return refreshMachineInputs(cached, input);
    }
    const displayByProject = readProjectDisplayIndex(input.workspaceRefs, input.projectOrganizations);
    const cacheKey = buildSessionListProjectHeaderViewModelStateCacheKey(input, displayByProject);
    const cached = SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.get(cacheKey);
    if (cached) return refreshMachineInputs(cached, input);
    const headersByMachine: ProjectHeaderCache['headersByMachine'] = new Map();
    const fallbackMachines: ProjectHeaderCache['fallbackMachines'] = new Map();
    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') continue;
        const machineId = readSessionListProjectHeaderMachineId(item, input.workspaceRefs, displayByProject);
        if (!machineId) continue;
        const headers = headersByMachine.get(machineId) ?? new Map();
        headers.set(item.groupKey ?? '', item.subtitle);
        headersByMachine.set(machineId, headers);
        // A keyed Project names only its accepted baseline, never an unrelated row's Machine.
        if (item.machine?.id === machineId) fallbackMachines.set(machineId, captureMachineNameInput(item.machine));
        else if (input.machinesById) fallbackMachines.set(machineId, { id: machineId, absence: 'unlisted' });
    }
    const { machinesById: _machines, listItems, workspaceLabels: _legacyLabels, projectOrganizations,
        legacyWorkspaceLabelDisplayStatesByKey: _legacyDisplays, ...structuralInput } = input;
    const cache: ProjectHeaderCache = { input: structuralInput, state: EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE,
        listInputs: new WeakSet([listItems]),
        // This label cache must not retain superseded organization bodies/prompt stacks.
        organizationInputs: new WeakSet(projectOrganizations ? [projectOrganizations] : []), hasOrganizations: projectOrganizations !== undefined,
        machines: new Map(), names: new Map(), idsByName: new Map(), headersByMachine, fallbackMachines,
        hasMachineInventory: input.machinesById !== undefined,
        migrationMachineInputs: new Map() };
    refreshMachineInputs(cache, input);

    let projectHeaderViewModelByGroupKey: Map<string, SessionListProjectHeaderViewModel> | null = null;
    let scopeHintByLegacyWorkspaceKey: Map<string, WorkspaceScopeBase> | null = null;
    const groupProjectByGroupKey = new Map<string, QualifiedProjectKeyV1>();

    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') {
            continue;
        }

        if (!projectHeaderViewModelByGroupKey || !scopeHintByLegacyWorkspaceKey) {
            projectHeaderViewModelByGroupKey = new Map<string, SessionListProjectHeaderViewModel>();
            scopeHintByLegacyWorkspaceKey = new Map<string, WorkspaceScopeBase>();
        }

        const groupKey = String(item.groupKey ?? '').trim();
        if (!groupKey) {
            continue;
        }

        if (item.projectKey) groupProjectByGroupKey.set(groupKey, item.projectKey);
        const legacyWorkspaceKey = String(item.workspaceKey ?? '').trim();
        const projectDisplay = item.projectKey ? displayByProject.get(projectGroupIdentityKey(item.projectKey)) : undefined;
        const baseline = projectDisplay?.baseline;
        const workspace = item.workspace;
        const scopeHint = item.projectKey ? baseline
            ? { serverId: baseline.serverId, machineId: baseline.machineId, rootPath: baseline.rootPath } : null
            : item.workspaceScopeHint ?? (workspace?.t === 'workspaceScope'
            && workspace.serverId && workspace.machineId
            ? { serverId: workspace.serverId, machineId: workspace.machineId, rootPath: workspace.rootPath }
            : null);
        const seedSessionId = String(item.seedSessionId ?? '').trim() || null;
        if (legacyWorkspaceKey && scopeHint) {
            scopeHintByLegacyWorkspaceKey.set(legacyWorkspaceKey, scopeHint);
        }

        const presentation = item.projectKey ? {
            displayTitle: projectDisplay?.title ?? t('common.loading'),
            hasCustomLabel: projectDisplay?.hasCustomLabel ?? false,
            workspaceRefId: baseline?.id ?? null,
        } : { ...resolveWorkspaceDisplayPresentation({
            scope: scopeHint,
            // An unresolved exact group has no admitted private checkout association.
            workspaceRefs: NO_CHECKOUT_REFS,
            fallbackPathLabel: item.workspaceScopeHint ? item.title : scopeHint?.rootPath ?? item.title,
            fallbackPathDisplayMode: input.workspacePathDisplayModeV1,
        }), hasCustomLabel: false };

        projectHeaderViewModelByGroupKey.set(groupKey, {
            collapseKey: groupKey,
            displayTitle: presentation.displayTitle,
            hasCustomLabel: presentation.hasCustomLabel,
            workspaceRefId: presentation.workspaceRefId,
            legacyWorkspaceKey,
            scopeHint,
            seedSessionId,
            machineSubtitle: cache.names.get(readSessionListProjectHeaderMachineId(item, input.workspaceRefs, displayByProject) ?? '') ?? item.subtitle,
            serverId: item.projectKey?.serverId ?? scopeHint?.serverId ?? item.serverId ?? null,
        });
    }

    if (!projectHeaderViewModelByGroupKey || !scopeHintByLegacyWorkspaceKey) {
        // Recent has no Project headers, but its rows still name their Project from the same index.
        cache.state = displayByProject.size === 0 ? EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE
            : { ...EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE, projectDisplayByKey: displayByProject };
        SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.set(cacheKey, cache);
        return cache.state;
    }

    const nextState: SessionListProjectHeaderViewModelState = {
        projectHeaderViewModelByGroupKey,
        scopeHintByLegacyWorkspaceKey,
        projectDisplayByKey: displayByProject,
        groupProjectByGroupKey,
    };

    cache.state = nextState;
    cache.baseScopeHints = scopeHintByLegacyWorkspaceKey;
    refreshLegacyLabelHints(cache, input);
    cache.state = reuseEqualHeaderState(lastBuiltState, cache.state);
    lastBuiltState = cache.state;
    SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.set(cacheKey, cache);
    return cache.state;
}
