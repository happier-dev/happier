import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { getServerProfileById, areServerProfileIdentifiersEquivalent, captureServerProfileScopeResolver, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import { readRegisteredStorageState, subscribeRegisteredStorageState, subscribeRegisteredStorageMachineUpdates } from '@/sync/domains/state/storageStateReaderBridge';
import type { storage } from '@/sync/domains/state/storageStore';
import { createServerAccountScope, serverAccountScopeListKey, serverAccountScopedResourceKey, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { machineAdministrationTargetObservationsState } from '@/sync/domains/state/machineAdministrationUiState';
import { resolveAllProfileMachineInventorySnapshots, type ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { readMachineRequestReachabilityRevision, subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { sessionListRuntimeClock, type SessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { resolveFleetSnapshotMachineRejection } from './fleetUnion';
import { readPluginExecutionOriginMachineTargets, createPluginMachineExecutionOriginMachineFacts,
    buildPluginMachineExecutionOriginCandidates, buildPluginMachineSourceExecutionOriginCandidates,
    combinePluginMachineExecutionOriginCandidates, resolvePluginMachineExecutionOriginState,
    type PluginMachineReleaseClassificationV1, type PluginMachineExecutionOriginRejectionV1,
    type PluginExecutionOriginCandidateV1, type PluginMachineExecutionOriginStateV1,
    type PluginMachineSourceExecutionOriginCandidateV1, type PluginExecutionOriginMachineFactReader,
    type PluginExecutionOriginContextualTarget } from './pluginExecutionOrigin';
import { readPluginMachineExecutionTargetPreference, readPluginMachineExecutionLastUsedTarget } from './selectionPreferences';
import { readPluginExecutionOriginAutomaticHints } from './pluginExecutionOriginAutomaticHints';

export type PluginExecutionOriginDescriptiveInputs = Readonly<{
    availabilityRevision: object | null;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    homeServerIdentityId?: string | null;
    storedOrigin: PluginMachineExecutionOriginV1 | null;
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
    machineRejections?: readonly PluginMachineExecutionOriginRejectionV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    establishingTargets?: readonly MachineAdministrationTargetV1[];
    autoPick?: boolean;
    renderedVersion?: string;
    availabilityNotLoaded?: boolean;
    localStatus?: LocalDaemonStatusData | null;
}>;
export type PluginExecutionOriginDescriptiveSelection = Readonly<{
    candidates: readonly PluginExecutionOriginCandidateV1[];
    state: PluginMachineExecutionOriginStateV1;
    loading: boolean;
}>;

export type ExecutionOriginMachineSnapshotSelection = Readonly<{
    key: string;
    eligibilityKey: string;
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nextRefreshAtMs: number | null;
    readMachineFact: PluginExecutionOriginMachineFactReader;
    selection: PluginExecutionOriginDescriptiveSelection | null;
}>;
type StorageState = Pick<ReturnType<typeof storage.getState>, 'machines' | 'machineListByServerId' | 'machineListStatusByServerId'> & Readonly<{
    settings: Pick<ReturnType<typeof storage.getState>['settings'], 'machineAdministrationTargetsLocalV1'>;
}>;
export type ExecutionOriginMachineSnapshotInputs = Readonly<{
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readinessServerIdentityId?: string;
    activeServerId: string;
    profiles: readonly ServerProfile[];
    profilesGeneration?: number;
    accountScopesByServerId: ReadonlyMap<string, ServerAccountScope>;
    accountLifetime?: ServerAccountScopeLifetime | null;
    bindings?: readonly ServerAccountScopeLifetime[];
    selection?: PluginExecutionOriginDescriptiveInputs;
}>;
const EMPTY_FACT = Object.freeze({ activeAt: 0, rejection: 'unknown' as const, eligible: false });
export const EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION: ExecutionOriginMachineSnapshotSelection = Object.freeze({
    key: '', eligibilityKey: '', snapshots: Object.freeze([]), nextRefreshAtMs: null, readMachineFact: () => EMPTY_FACT, selection: null,
});

/** A failed or signed-out census is an answer; an unread census is not empty. */
export function isMachineInventoryPending(snapshot: ServerMachineInventorySnapshotV1): boolean {
    if (snapshot.kind !== 'resolved' && snapshot.kind !== 'unknown') return false;
    if (snapshot.kind === 'resolved' && snapshot.settled === true) return (snapshot.executionPendingMachineIds?.length ?? 0) > 0;
    return snapshot.inventoryStatus !== 'error' && snapshot.inventoryStatus !== 'signedOut';
}

type InventoryPublication = Readonly<{
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nextRefreshAtMs: number | null;
    readMachineFact: PluginExecutionOriginMachineFactReader;
    pendingHomes: ReadonlySet<string>;
    state: StorageState;
    reachabilityRevision: number;
    observedAtMs: number;
    homes: ReadonlyMap<string, InventoryHome>;
    changedTargets: readonly PluginExecutionOriginContextualTarget[];
    fullRefresh: boolean;
    activeServerIdentityId: string;
}>;
type InventoryMachineFact = ReturnType<PluginExecutionOriginMachineFactReader>;
type InventoryRow = Readonly<{
    machine: ServerMachineInventorySnapshotV1['machines'][number];
    displayIndex: number;
    sourceIndex: number | null;
    eligible: boolean;
    presence: string;
    fact: InventoryMachineFact;
    nextRefreshAtMs: number | null;
}>;
type InventoryHome = Readonly<{
    snapshot: Extract<ServerMachineInventorySnapshotV1, { kind: 'resolved' }>;
    rows: ReadonlyMap<string, InventoryRow>;
    sourceMachines: readonly StorageState['machines'][string][] | null;
}>;
type Demand = {
    inputs: ExecutionOriginMachineSnapshotInputs;
    targets: readonly PluginExecutionOriginContextualTarget[];
    context: Context;
    facts: Readonly<{ eligibilityKey: string; activityKey: string }> | null;
    factProjection: ReturnType<typeof createPluginMachineExecutionOriginMachineFacts> | null;
    factsInventory: InventoryPublication | null;
    current: ExecutionOriginMachineSnapshotSelection;
    snapshot: ExecutionOriginMachineSnapshotSelection;
    listeners: Set<() => void>;
    description: Readonly<{
        inputs: ExecutionOriginMachineSnapshotInputs;
        key: string;
        eligibilityKey: string;
        storedTarget: MachineAdministrationTargetV1 | null;
        lastUsedTarget: MachineAdministrationTargetV1 | null;
        value: PluginExecutionOriginDescriptiveSelection;
    }> | null;
};
type Context = {
    key: string;
    inputs: ExecutionOriginMachineSnapshotInputs;
    scopes: ReadonlyMap<string, ServerAccountScope>;
    inventory: InventoryPublication | null;
    demands: Set<Demand>;
};
export type ExecutionOriginMachineSnapshotConnection = Readonly<{
    getSnapshot(): ExecutionOriginMachineSnapshotSelection;
    readCurrent(): ExecutionOriginMachineSnapshotSelection;
    updateInputs(inputs: ExecutionOriginMachineSnapshotInputs): void;
    dispose(): void;
}>;
type PublicationDependencies = Readonly<{
    readState(): StorageState | null;
    subscribeState(listener: () => void): (() => void) | null;
    subscribeMachineUpdates(listener: (serverId: string, machineIds: readonly string[]) => void): (() => void) | null;
    clock: SessionListRuntimeClock;
}>;

function sameTargets(left: readonly PluginExecutionOriginContextualTarget[], right: readonly PluginExecutionOriginContextualTarget[]) {
    return left.length === right.length && left.every((target, index) => target.serverIdentityId === right[index]!.serverIdentityId
        && target.machineId === right[index]!.machineId);
}

function sameTarget(left: MachineAdministrationTargetV1 | null | undefined, right: MachineAdministrationTargetV1 | null | undefined) {
    return left?.serverIdentityId === right?.serverIdentityId && left?.machineId === right?.machineId;
}

function sameCandidateInputs(left: ExecutionOriginMachineSnapshotInputs, right: ExecutionOriginMachineSnapshotInputs) {
    const a = left.selection;
    const b = right.selection;
    return a?.classifyRelease === b?.classifyRelease && a?.availabilityRevision === b?.availabilityRevision
        && left.materializations === right.materializations && (left.sources === right.sources
            || left.sources.length === right.sources.length && left.sources.every((candidate, index) => {
                const other = right.sources[index]!;
                return candidate.source.serverId === other.source.serverId
                    && candidate.source.version === other.source.version && candidate.source.occurrenceId === other.source.occurrenceId
                    && arePluginMachineExecutionOriginsEqual(candidate.source.origin, other.source.origin)
                    && candidate.releaseContent === other.releaseContent && candidate.validation.kind === other.validation.kind
                    && (candidate.validation.kind !== 'rejected' || other.validation.kind === 'rejected' && candidate.validation.reason === other.validation.reason);
            }))
        && (a?.machineRejections === b?.machineRejections || (a?.machineRejections?.length ?? 0) === (b?.machineRejections?.length ?? 0)
            && (a?.machineRejections ?? []).every((entry, index) => sameTarget(entry, b?.machineRejections?.[index])
                && entry.reason === b?.machineRejections?.[index]?.reason)) && left.pluginId === right.pluginId;
}

function sameSelectionInputs(left: ExecutionOriginMachineSnapshotInputs, right: ExecutionOriginMachineSnapshotInputs) {
    const a = left.selection;
    const b = right.selection;
    return sameCandidateInputs(left, right) && left.accountLifetime === right.accountLifetime && a?.homeServerIdentityId === b?.homeServerIdentityId
        && a?.storedOrigin === b?.storedOrigin && sameTarget(a?.contextualTarget, b?.contextualTarget)
        && (a?.contextualTarget === undefined) === (b?.contextualTarget === undefined)
        && (a?.contextualTarget === null) === (b?.contextualTarget === null)
        && (a?.declaredDefaultOrigins === b?.declaredDefaultOrigins || (a?.declaredDefaultOrigins?.length ?? 0) === (b?.declaredDefaultOrigins?.length ?? 0)
            && (a?.declaredDefaultOrigins ?? []).every((origin, index) => arePluginMachineExecutionOriginsEqual(origin, b!.declaredDefaultOrigins![index]!)))
        && (a?.establishingTargets === b?.establishingTargets || (a?.establishingTargets?.length ?? 0) === (b?.establishingTargets?.length ?? 0)
            && (a?.establishingTargets ?? []).every((target, index) => sameTarget(target, b?.establishingTargets?.[index])))
        && a?.autoPick === b?.autoPick && a?.renderedVersion === b?.renderedVersion
        && a?.availabilityNotLoaded === b?.availabilityNotLoaded && a?.localStatus === b?.localStatus;
}

function sameCandidateRows(left: readonly PluginExecutionOriginCandidateV1[], right: readonly PluginExecutionOriginCandidateV1[]) {
    return left.length === right.length && left.every((candidate, index) => candidate === right[index]);
}

function readInventoryMachineFact(homes: ReadonlyMap<string, InventoryHome>, target: PluginExecutionOriginContextualTarget): InventoryMachineFact {
    const home = homes.get(target.serverIdentityId);
    return home?.rows.get(target.machineId)?.fact ?? { activeAt: 0, eligible: false,
        rejection: resolveFleetSnapshotMachineRejection({ snapshot: home?.snapshot, machine: undefined }) };
}

/** A changed classifier must run, but equal descriptive results must not republish themselves. */
function retainDescriptiveCandidates(previous: readonly PluginExecutionOriginCandidateV1[] | undefined,
    proposed: readonly PluginExecutionOriginCandidateV1[]) {
    if (!previous) return proposed;
    const retained = proposed.map((candidate, index) => {
        const old = previous[index];
        if (!old) return candidate;
        const sameFact = 'materialization' in old && 'materialization' in candidate
            ? old.materialization === candidate.materialization : 'source' in old && 'source' in candidate && old.source === candidate.source;
        return sameFact && old.releaseContent === candidate.releaseContent && old.validation.kind === candidate.validation.kind
            && (old.validation.kind !== 'rejected' || candidate.validation.kind === 'rejected' && old.validation.reason === candidate.validation.reason)
            ? old : candidate;
    });
    return sameCandidateRows(previous, retained) ? previous : Object.freeze(retained);
}

function retainDescriptiveState(previous: PluginMachineExecutionOriginStateV1 | undefined, next: PluginMachineExecutionOriginStateV1) {
    if (!previous || previous.kind !== next.kind) return next;
    if (previous.kind === 'selected' && next.kind === 'selected') return previous.candidate === next.candidate
        && previous.selectionSource === next.selectionSource && arePluginMachineExecutionOriginsEqual(previous.origin, next.origin) ? previous : next;
    if (previous.kind === 'selected' || next.kind === 'selected' || !sameCandidateRows(previous.candidates, next.candidates)) return next;
    if (previous.kind === 'selectionRequired' && next.kind === 'selectionRequired') return previous;
    if (previous.kind === 'conflict' && next.kind === 'conflict') return previous.reasons.length === next.reasons.length
        && previous.reasons.every((reason, index) => reason === next.reasons[index]) ? previous : next;
    if (previous.kind === 'unavailable' && next.kind === 'unavailable') return sameTarget(previous.storedTarget, next.storedTarget)
        && (previous.storedOrigin === next.storedOrigin || previous.storedOrigin !== null && next.storedOrigin !== null
            && arePluginMachineExecutionOriginsEqual(previous.storedOrigin, next.storedOrigin))
        && previous.reasons.length === next.reasons.length && previous.reasons.every((reason, index) => reason === next.reasons[index]) ? previous : next;
    return next;
}

/** The existing inventory producer publishes on source changes; snapshot reads never derive. */
export function createExecutionOriginMachineSnapshotPublication(dependencies: PublicationDependencies) {
    const contexts = new Map<string, Context>();
    const clockToken = {};
    let stops: Array<() => void> = [];
    let publishing = false;
    type AutomaticOriginEntry = { current: Demand | null; remaining: Demand[]; next: number };
    let automaticOriginView: Readonly<{
        order: ReadonlyMap<Demand, number>;
        plugins: ReadonlyMap<string, Map<ServerAccountScopeLifetime | null | undefined, AutomaticOriginEntry>>;
    }> | null = null;

    function selectedAutomaticOrigin(demand: Demand) {
        const state = demand.current.selection?.state;
        return demand.inputs.selection?.contextualTarget === undefined && state?.kind === 'selected' && state.selectionSource === 'auto'
            ? state.origin : null;
    }

    // One ordered view for this synchronous publication. It is discarded after
    // the pass; it never substitutes for currentness or persists selected facts.
    function prepareAutomaticOriginView() {
        if (!publishing || automaticOriginView) return;
        const order = new Map<Demand, number>();
        const plugins = new Map<string, Map<ServerAccountScopeLifetime | null | undefined, AutomaticOriginEntry>>();
        for (const context of contexts.values()) for (const demand of context.demands) {
            order.set(demand, order.size);
            let lifetimes = plugins.get(demand.inputs.pluginId);
            if (!lifetimes) { lifetimes = new Map(); plugins.set(demand.inputs.pluginId, lifetimes); }
            let entry = lifetimes.get(demand.inputs.accountLifetime);
            if (!entry) { entry = { current: null, remaining: [], next: 0 }; lifetimes.set(demand.inputs.accountLifetime, entry); }
            if (selectedAutomaticOrigin(demand)) {
                entry.current ??= demand;
                entry.remaining.push(demand);
            }
        }
        automaticOriginView = { order, plugins };
    }

    function withAutomaticOriginView(publish: () => void) {
        if (publishing) { publish(); return; }
        publishing = true;
        try { publish(); } finally { publishing = false; automaticOriginView = null; }
    }

    function publishAutomaticOrigin(demand: Demand) {
        const view = automaticOriginView;
        const entry = view?.plugins.get(demand.inputs.pluginId)?.get(demand.inputs.accountLifetime);
        if (!view || !entry) return;
        if (selectedAutomaticOrigin(demand)) {
            if (!entry.current || (view.order.get(demand) ?? Infinity) < (view.order.get(entry.current) ?? Infinity)) entry.current = demand;
        } else if (entry.current === demand) {
            entry.current = null;
            // Publication follows the same demand order as the initial view.
            // Each incumbent is visited at most once when earlier choices retire.
            while (entry.next < entry.remaining.length) {
                const candidate = entry.remaining[entry.next++]!;
                if (selectedAutomaticOrigin(candidate)) { entry.current = candidate; break; }
            }
        }
    }

    // Reuse the mounted selection, including for fresh invocation and Action
    // reads. This is a descriptive hint; the policy still admits current facts.
    function readAutomaticOrigin(pluginId: string, accountLifetime: ServerAccountScopeLifetime | null | undefined) {
        if (accountLifetime === null || accountLifetime?.isCurrent() === false) return null;
        prepareAutomaticOriginView();
        if (automaticOriginView) {
            const demand = automaticOriginView.plugins.get(pluginId)?.get(accountLifetime)?.current;
            return demand ? selectedAutomaticOrigin(demand) : null;
        }
        for (const context of contexts.values()) for (const demand of context.demands) {
            if (demand.inputs.pluginId !== pluginId || demand.inputs.accountLifetime !== accountLifetime
                || demand.inputs.selection?.contextualTarget !== undefined) continue;
            const state = demand.current.selection?.state;
            if (state?.kind === 'selected' && state.selectionSource === 'auto') return state.origin;
        }
        return null;
    }

    function describe(demand: Demand, inventory: InventoryPublication, key: string, eligibilityKey: string) {
        const spec = demand.inputs.selection;
        if (!spec) return null;
        const targets = inventory.state.settings.machineAdministrationTargetsLocalV1;
        const storedTarget = spec.contextualTarget !== undefined ? null : readPluginMachineExecutionTargetPreference(targets, demand.inputs.pluginId);
        const lastUsedTarget = readPluginMachineExecutionLastUsedTarget(demand.inputs.accountLifetime?.scope ?? null, demand.inputs.pluginId);
        const rememberedTarget = storedTarget ?? (spec.storedOrigin && {
            serverIdentityId: spec.storedOrigin.serverIdentityId,
            machineId: getPluginMachineExecutionOriginRef(spec.storedOrigin).machineId,
        });
        const readLoading = (state: PluginMachineExecutionOriginStateV1) => {
            // The presence owner has settled every eligible source offline.
            // Neither Account availability nor its pending projection can
            // finish an acquisition on that Machine until presence recovers.
            if (state.kind === 'unavailable' && state.reasons.length > 0
                && state.reasons.every(reason => reason === 'offline')) return false;
            const readinessHome = state.kind === 'selected' ? state.origin.serverIdentityId
                : rememberedTarget?.serverIdentityId ?? spec.homeServerIdentityId;
            const establishingTarget = state.kind === 'selected' ? { serverIdentityId: state.origin.serverIdentityId,
                machineId: getPluginMachineExecutionOriginRef(state.origin).machineId }
                : spec.contextualTarget !== undefined ? spec.contextualTarget : rememberedTarget;
            const projectionPending = spec.contextualTarget !== null && (state.kind === 'unavailable' || state.kind === 'selected')
                && spec.establishingTargets?.some(target => establishingTarget ? sameTarget(target, establishingTarget)
                    : target.serverIdentityId === readinessHome) === true;
            const selectedContentPending = state.kind === 'selected'
                && inventory.homes.get(state.origin.serverIdentityId)?.snapshot.executionPendingMachineIds
                    ?.includes(getPluginMachineExecutionOriginRef(state.origin).machineId) === true;
            return spec.availabilityNotLoaded === true || selectedContentPending
                || ((inventory.pendingHomes.has(readinessHome ?? '') && state.kind !== 'selected') || projectionPending);
        };
        const matches = (description: NonNullable<Demand['description']>) => description.key === key
            && sameSelectionInputs(description.inputs, demand.inputs) && sameTarget(description.storedTarget, storedTarget)
            && sameTarget(description.lastUsedTarget, lastUsedTarget)
            && description.value.loading === readLoading(description.value.state);
        if (demand.description && matches(demand.description)) return demand.description.value;
        const previous = demand.description;
        const candidates = previous && previous.eligibilityKey === eligibilityKey && sameCandidateInputs(previous.inputs, demand.inputs)
            ? previous.value.candidates : retainDescriptiveCandidates(previous?.value.candidates, combinePluginMachineExecutionOriginCandidates(buildPluginMachineExecutionOriginCandidates({
                pluginId: demand.inputs.pluginId, materializations: demand.inputs.materializations, classifyRelease: spec.classifyRelease,
                machineSnapshots: inventory.snapshots, readMachineFact: inventory.readMachineFact, machineRejections: spec.machineRejections,
            }), buildPluginMachineSourceExecutionOriginCandidates({ pluginId: demand.inputs.pluginId, sources: demand.inputs.sources,
                machineSnapshots: inventory.snapshots, readMachineFact: inventory.readMachineFact })));
        const presence = rememberedTarget ? inventory.readMachineFact(rememberedTarget).rejection
            ?? spec.machineRejections?.find(entry => sameTarget(entry, rememberedTarget))?.reason ?? null : null;
        const resolved = resolvePluginMachineExecutionOriginState({ pluginId: demand.inputs.pluginId,
            storedOrigin: spec.storedOrigin, storedTarget, homeServerIdentityId: spec.homeServerIdentityId, candidates,
            automaticOrigin: previous && previous.inputs.pluginId === demand.inputs.pluginId
                && previous.inputs.accountLifetime === demand.inputs.accountLifetime
                && previous.value.state.kind === 'selected' && previous.value.state.selectionSource === 'auto'
                ? previous.value.state.origin : readAutomaticOrigin(demand.inputs.pluginId, demand.inputs.accountLifetime),
            declaredDefaultOrigins: spec.declaredDefaultOrigins, contextualTarget: spec.contextualTarget,
            storedOriginMachinePresence: presence, autoPick: spec.autoPick, renderedVersion: spec.renderedVersion,
            ...readPluginExecutionOriginAutomaticHints(demand.inputs.pluginId, candidates, inventory.snapshots),
            lastUsedTarget,
            inventoryPending: inventory.pendingHomes.has(rememberedTarget?.serverIdentityId ?? spec.homeServerIdentityId ?? ''),
        });
        const state = retainDescriptiveState(previous?.value.state, resolved);
        const loading = readLoading(state);
        const value = previous?.value.candidates === candidates && previous.value.state === state && previous.value.loading === loading
            ? previous.value : Object.freeze({ candidates, state, loading });
        demand.description = { inputs: demand.inputs, key, eligibilityKey, storedTarget, lastUsedTarget, value };
        return value;
    }

    function armClock() {
        let deadline: number | null = null;
        for (const context of contexts.values()) {
            const next = context.inventory?.nextRefreshAtMs;
            if (next != null && (deadline === null || next < deadline)) deadline = next;
        }
        if (deadline === null) dependencies.clock.clearWake(clockToken);
        else dependencies.clock.requestWake(clockToken, deadline);
    }

    function publishDemand(demand: Demand) {
        const { context, inputs } = demand;
        const inventory = context.inventory;
        if (!inventory || (inputs.accountLifetime && !inputs.accountLifetime.isCurrent())) {
            demand.current = EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION;
        } else {
            if (demand.factsInventory !== inventory) {
                const facts = { machineSnapshots: inventory.snapshots, readMachineFact: inventory.readMachineFact };
                if (!demand.factProjection) demand.factProjection = createPluginMachineExecutionOriginMachineFacts({
                    ...facts, targets: demand.targets,
                });
                else if (inventory.fullRefresh || inventory.changedTargets.length > 0) {
                    demand.factProjection.update(facts, inventory.fullRefresh ? undefined : inventory.changedTargets);
                }
                demand.facts = demand.factProjection.getSnapshot();
                demand.factsInventory = inventory;
            }
            const readinessHome = inputs.readinessServerIdentityId
                ?? readPluginMachineExecutionTargetPreference(inventory.state.settings.machineAdministrationTargetsLocalV1, inputs.pluginId)?.serverIdentityId
                ?? inventory.activeServerIdentityId;
            const prefix = `${context.key}\u0000${readinessHome}\u0000${inventory.pendingHomes.has(readinessHome)}\u0000`;
            const eligibilityKey = `${prefix}${demand.facts!.eligibilityKey}`;
            // Activity ranks an initial/replacement Auto choice. A heartbeat
            // alone must not republish or replace an eligible mounted choice.
            const key = inputs.selection ? eligibilityKey : `${prefix}${demand.facts!.activityKey}`;
            const selection = describe(demand, inventory, key, eligibilityKey);
            if (demand.current.key !== key || demand.current.snapshots !== inventory.snapshots || demand.current.selection !== selection) {
                demand.current = Object.freeze({ key, eligibilityKey, selection,
                    snapshots: inventory.snapshots, nextRefreshAtMs: inventory.nextRefreshAtMs, readMachineFact: inventory.readMachineFact });
            }
        }
        publishAutomaticOrigin(demand);
        // Raw presentation can advance without waking a semantic consumer.
        if (demand.snapshot.key !== demand.current.key || demand.snapshot.selection !== demand.current.selection) {
            demand.snapshot = demand.current;
            for (const listener of demand.listeners) listener();
        }
    }

    function publishContext(context: Context, force = false) {
        const state = dependencies.readState();
        if (!state) return;
        const nowMs = Date.now();
        const revision = readMachineRequestReachabilityRevision();
        const previous = context.inventory;
        const unchanged = !force && previous && previous.state.machines === state.machines
            && previous.state.machineListByServerId === state.machineListByServerId
            && previous.state.machineListStatusByServerId === state.machineListStatusByServerId
            && previous.reachabilityRevision === revision && nowMs >= previous.observedAtMs
            && (previous.nextRefreshAtMs === null || nowMs < previous.nextRefreshAtMs);
        if (!unchanged) {
            const activeMachines = Object.values(state.machines);
            const snapshots = resolveAllProfileMachineInventorySnapshots({ profiles: context.inputs.profiles,
                activeServerId: context.inputs.activeServerId, activeMachines,
                machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId,
                accountScopesByServerId: context.scopes, nowMs, loadWarmEntries: loadMachineDisplayWarmCacheEntries });
            let nextRefreshAtMs: number | null = null;
            const pendingHomes = new Set<string>();
            const homes = new Map<string, InventoryHome>();
            const changedTargets: PluginExecutionOriginContextualTarget[] = [];
            const resolveScopeId = captureServerProfileScopeResolver();
            for (const snapshot of snapshots) {
                if ('serverIdentityId' in snapshot && isMachineInventoryPending(snapshot)) pendingHomes.add(snapshot.serverIdentityId);
                if (snapshot.kind !== 'resolved') continue;
                const profile = context.inputs.profiles.find(entry => entry.id === snapshot.profileId);
                const sourceMachines = resolveServerScopedMachineInventory({
                    serverId: snapshot.serverIdentityId, serverIdAliases: [snapshot.profileId, ...(profile?.legacyServerIds ?? [])],
                    activeServerId: context.inputs.activeServerId, activeMachines,
                    machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId,
                }, resolveScopeId).machines;
                const sourceIndices = new Map(sourceMachines?.map((machine, index) => [machine.id, index] as const));
                const old = previous?.homes.get(snapshot.serverIdentityId);
                const sameAdmission = old !== undefined && old.snapshot.accountId === snapshot.accountId
                    && old.snapshot.observation === snapshot.observation && old.snapshot.settled === snapshot.settled
                    && previous !== null && nowMs >= previous.observedAtMs;
                // A census/Account/reachability transition can change an absent
                // demanded target too (unknown vs missing), without a row delta.
                if (!sameAdmission && previous) for (const demand of context.demands) {
                    for (const target of demand.targets) if (target.serverIdentityId === snapshot.serverIdentityId) changedTargets.push(target);
                }
                const eligible = new Set(snapshot.executionEligibleMachineIds);
                const rows = new Map<string, InventoryRow>();
                const scope = createServerAccountScope(snapshot.serverIdentityId, snapshot.accountId);
                for (const [displayIndex, machine] of snapshot.machines.entries()) {
                    const sourceIndex = sourceIndices.get(machine.id) ?? null;
                    const before = old?.rows.get(machine.id);
                    const executionEligible = eligible.has(machine.id);
                    const sameRow = sameAdmission && before?.machine === machine
                        && before.fact.activeAt === machine.activeAt
                        && (before.nextRefreshAtMs === null || nowMs < before.nextRefreshAtMs);
                    const livePresence = sameRow && previous?.reachabilityRevision === revision
                        ? null : resolveMachinePickerPresence(machine, nowMs, scope, resolveScopeId);
                    const presence = livePresence ? livePresence.status === 'offline' ? livePresence.reason : livePresence.status : before!.presence;
                    const unchanged = sameRow && before!.eligible === executionEligible && before!.presence === presence;
                    let row = before;
                    if (!unchanged) {
                        const proposed = { activeAt: machine.activeAt, eligible: executionEligible,
                            rejection: resolveFleetSnapshotMachineRejection({ snapshot, machine, executionEligible }) };
                        const fact = before && before.fact.activeAt === proposed.activeAt && before.fact.eligible === proposed.eligible
                            && before.fact.rejection === proposed.rejection ? before.fact : proposed;
                        row = { machine, displayIndex, sourceIndex, eligible: executionEligible, presence, fact,
                            nextRefreshAtMs: readMachineStatusNextRefreshAtMs(machine, nowMs) };
                    } else if (row!.displayIndex !== displayIndex || row!.sourceIndex !== sourceIndex) {
                        row = { ...row!, displayIndex, sourceIndex };
                    }
                    rows.set(machine.id, row!);
                    if (before?.fact !== row!.fact) changedTargets.push({ serverIdentityId: snapshot.serverIdentityId, machineId: machine.id });
                    const deadline = row!.nextRefreshAtMs;
                    if (deadline !== null && (nextRefreshAtMs === null || deadline < nextRefreshAtMs)) nextRefreshAtMs = deadline;
                }
                for (const machineId of old?.rows.keys() ?? []) if (!rows.has(machineId)) {
                    changedTargets.push({ serverIdentityId: snapshot.serverIdentityId, machineId });
                }
                homes.set(snapshot.serverIdentityId, { snapshot, rows, sourceMachines });
            }
            for (const [serverIdentityId, old] of previous?.homes ?? []) if (!homes.has(serverIdentityId)) {
                for (const machineId of old.rows.keys()) changedTargets.push({ serverIdentityId, machineId });
                for (const demand of context.demands) {
                    for (const target of demand.targets) if (target.serverIdentityId === serverIdentityId) changedTargets.push(target);
                }
            }
            context.inventory = { snapshots, nextRefreshAtMs, pendingHomes, state, observedAtMs: nowMs, homes, changedTargets, fullRefresh: !previous,
                activeServerIdentityId: getServerProfileById(context.inputs.activeServerId)?.serverIdentityId ?? '',
                reachabilityRevision: revision,
                readMachineFact: target => readInventoryMachineFact(homes, target) };
        } else {
            if (previous.state.settings.machineAdministrationTargetsLocalV1 === state.settings.machineAdministrationTargetsLocalV1) return;
            context.inventory = { ...previous, state, changedTargets: [], fullRefresh: false };
        }
        for (const demand of context.demands) publishDemand(demand);
    }

    function publishMachineUpdates(context: Context, state: StorageState, serverId: string, machineIds: readonly string[]) {
        const previous = context.inventory;
        if (!previous) { publishContext(context); return; }
        const resolveScopeId = captureServerProfileScopeResolver();
        const snapshotIndex = previous.snapshots.findIndex(entry => areServerProfileIdentifiersEquivalent(entry.profileId, serverId, resolveScopeId));
        const snapshot = previous.snapshots[snapshotIndex];
        if (snapshot?.kind !== 'resolved') return;
        const home = previous.homes.get(snapshot.serverIdentityId)!;
        const nowMs = Date.now();
        // Semantic/root, scope, reachability and expiry transitions still use
        // the canonical census. Exact receipts with retained roots change only
        // liveness; their row coordinates were established by that census.
        if (previous.state.machines !== state.machines || previous.state.machineListByServerId !== state.machineListByServerId
            || previous.state.machineListStatusByServerId !== state.machineListStatusByServerId
            || previous.reachabilityRevision !== readMachineRequestReachabilityRevision()
            || nowMs < previous.observedAtMs || (previous.nextRefreshAtMs !== null && nowMs >= previous.nextRefreshAtMs)) {
            publishContext(context);
            return;
        }
        let rows: Map<string, InventoryRow> | null = null;
        let machines: Array<InventoryRow['machine']> | null = null;
        const changedTargets: PluginExecutionOriginContextualTarget[] = [];
        let earliestChanged = false;
        let nextRefreshAtMs = previous.nextRefreshAtMs;
        const scope = createServerAccountScope(snapshot.serverIdentityId, snapshot.accountId);
        for (const machineId of new Set(machineIds)) {
            const before = home.rows.get(machineId);
            const source = before?.sourceIndex != null ? home.sourceMachines?.[before.sourceIndex] : undefined;
            if (!before || !source || source.id !== machineId) { publishContext(context, true); return; }
            if (before.fact.activeAt === source.activeAt && before.machine.updatedAt === source.updatedAt) continue;
            const livePresence = resolveMachinePickerPresence(source, nowMs, scope, resolveScopeId);
            const presence = livePresence.status === 'offline' ? livePresence.reason : livePresence.status;
            if (presence !== before.presence) { publishContext(context, true); return; }
            const machine = { ...before.machine, activeAt: source.activeAt, updatedAt: source.updatedAt };
            const fact = before.fact.activeAt === source.activeAt ? before.fact : { ...before.fact, activeAt: source.activeAt };
            const row: InventoryRow = { ...before, machine, fact, nextRefreshAtMs: readMachineStatusNextRefreshAtMs(source, nowMs) };
            rows ??= new Map(home.rows);
            machines ??= [...snapshot.machines];
            rows.set(machineId, row);
            machines[before.displayIndex] = machine;
            if (fact !== before.fact) changedTargets.push({ serverIdentityId: snapshot.serverIdentityId, machineId });
            if (before.nextRefreshAtMs === previous.nextRefreshAtMs && row.nextRefreshAtMs !== before.nextRefreshAtMs) earliestChanged = true;
            if (row.nextRefreshAtMs !== null && (nextRefreshAtMs === null || row.nextRefreshAtMs < nextRefreshAtMs)) nextRefreshAtMs = row.nextRefreshAtMs;
        }
        if (!rows || !machines) return;
        const nextSnapshot = { ...snapshot, machines: Object.freeze(machines) };
        const homes = new Map(previous.homes);
        homes.set(snapshot.serverIdentityId, { ...home, rows, snapshot: nextSnapshot });
        // Only the scalar deadline minimum needs a scan when its old owner
        // moves. No unaffected row is re-admitted or re-projected.
        if (earliestChanged) {
            nextRefreshAtMs = null;
            for (const currentHome of homes.values()) for (const row of currentHome.rows.values()) {
                const deadline = row.nextRefreshAtMs;
                if (deadline !== null && (nextRefreshAtMs === null || deadline < nextRefreshAtMs)) nextRefreshAtMs = deadline;
            }
        }
        const snapshots = [...previous.snapshots];
        snapshots[snapshotIndex] = nextSnapshot;
        context.inventory = { ...previous, snapshots: Object.freeze(snapshots), homes, state, observedAtMs: nowMs,
            changedTargets, fullRefresh: false, nextRefreshAtMs,
            readMachineFact: target => readInventoryMachineFact(homes, target) };
        for (const demand of context.demands) publishDemand(demand);
    }

    function publish() {
        withAutomaticOriginView(() => { for (const context of contexts.values()) publishContext(context); });
        armClock();
    }

    function start() {
        if (stops.length > 0) return;
        stops = [dependencies.subscribeState(publish), subscribeMachineRequestReachability(publish),
            dependencies.clock.subscribe(publish), dependencies.subscribeMachineUpdates((serverId, machineIds) => {
                const state = dependencies.readState();
                if (!state) return;
                withAutomaticOriginView(() => {
                    for (const context of contexts.values()) publishMachineUpdates(context, state, serverId, machineIds);
                });
                armClock();
            })].filter((stop): stop is () => void => stop !== null);
    }

    return {
        readAutomaticOrigin,
        connect(inputs: ExecutionOriginMachineSnapshotInputs, listener: () => void): ExecutionOriginMachineSnapshotConnection {
            let disposed = false;
            let demand: Demand;
            let retirements: Array<Readonly<{ dispose(): void }>> = [];
            const notify = () => listener();
            function bind(next: ExecutionOriginMachineSnapshotInputs) {
                if (disposed) return;
                for (const retirement of retirements) retirement.dispose();
                retirements = [];
                const scopes = new Map([...next.accountScopesByServerId].filter(([serverId, scope]) => {
                    const binding = next.bindings?.find(entry => entry.scope.accountId === scope.accountId
                        && areServerProfileIdentifiersEquivalent(entry.scope.serverId, serverId));
                    return !binding || binding.isCurrent();
                }));
                const key = `${next.activeServerId}\u0000${serverAccountScopeListKey([...scopes.values()].sort((a, b) => a.serverId.localeCompare(b.serverId)))}`;
                let context = contexts.get(key);
                if (!context) {
                    context = { key, inputs: next, scopes, inventory: null, demands: new Set() };
                    contexts.set(key, context);
                } else if ((next.profilesGeneration !== undefined && (context.inputs.profilesGeneration === undefined
                    || next.profilesGeneration > context.inputs.profilesGeneration))
                    || (next.profilesGeneration === undefined && context.inputs.profiles !== next.profiles)) {
                    context.inputs = next;
                    context.inventory = null;
                }
                const previous = demand;
                const previousSnapshot = previous?.snapshot ?? EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION;
                const targets = previous && previous.inputs.materializations === next.materializations && previous.inputs.sources === next.sources
                    && previous.inputs.pluginId === next.pluginId ? previous.targets : readPluginExecutionOriginMachineTargets(next);
                if (previous) {
                    previous.listeners.delete(notify);
                    if (previous.listeners.size === 0) previous.context.demands.delete(previous);
                    if (previous.context !== context && previous.context.demands.size === 0) contexts.delete(previous.context.key);
                }
                const reuse = previous?.context === context && previous.listeners.size === 0 && sameTargets(previous.targets, targets);
                // Equivalent connections consume one demand. Match only when a
                // connection binds, never by searching siblings per arrival.
                const equivalent = [...context.demands].find(other => other.inputs.readinessServerIdentityId === next.readinessServerIdentityId
                    && sameTargets(other.targets, targets) && sameSelectionInputs(other.inputs, next));
                demand = equivalent ?? { inputs: next, targets: reuse ? previous.targets : targets, context,
                    facts: reuse ? previous.facts : null, factsInventory: reuse ? previous.factsInventory : null,
                    factProjection: reuse ? previous.factProjection : null,
                    current: previous?.current ?? EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION,
                    snapshot: previousSnapshot, listeners: new Set(),
                    description: previous?.description ?? null };
                context.demands.add(demand);
                withAutomaticOriginView(() => {
                    publishContext(context);
                    publishDemand(demand);
                });
                demand.listeners.add(notify);
                if (next.accountLifetime?.isCurrent()) {
                    const observationKey = serverAccountScopedResourceKey(next.accountLifetime.scope, `plugin.lastRunOn:${next.pluginId}`);
                    retirements.push({ dispose: machineAdministrationTargetObservationsState.subscribeKey(observationKey, () => {
                        withAutomaticOriginView(() => publishDemand(demand));
                    }) });
                }
                for (const lifetime of [next.accountLifetime, ...next.bindings ?? []]) {
                    if (lifetime?.isCurrent()) retirements.push(lifetime.onRetire(() => {
                        if (!disposed) bind(next);
                    }));
                }
                armClock();
                if (previousSnapshot.key !== demand.snapshot.key || previousSnapshot.selection !== demand.snapshot.selection) notify();
            }
            start();
            bind(inputs);
            return {
                getSnapshot: () => demand.snapshot,
                readCurrent: () => demand.current,
                updateInputs: bind,
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    for (const retirement of retirements) retirement.dispose();
                    demand.listeners.delete(notify);
                    if (demand.listeners.size === 0) demand.context.demands.delete(demand);
                    if (demand.context.demands.size === 0) contexts.delete(demand.context.key);
                    if (contexts.size === 0) {
                        for (const stop of stops) stop();
                        stops = [];
                    }
                    armClock();
                },
            };
        },
    };
}

export const executionOriginMachineSnapshotPublication = createExecutionOriginMachineSnapshotPublication({
    readState: readRegisteredStorageState,
    subscribeState: subscribeRegisteredStorageState,
    subscribeMachineUpdates: subscribeRegisteredStorageMachineUpdates,
    clock: sessionListRuntimeClock,
});
