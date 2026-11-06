import type { Machine } from '@/sync/domains/state/storageTypes';
import { readRegisteredStorageState, subscribeRegisteredStorageState, subscribeRegisteredStorageMachineUpdates } from '@/sync/domains/state/storageStateReaderBridge';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1, readConnectedServicesAccountChangeV1 } from '@happier-dev/protocol/changes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { isMachineReachable, resolveMachineReachability, readMachineRequestReachabilityRevision, subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isConnectedServiceUsageCapable, subscribeConnectedServiceRegistry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveUsageQueryPeriod, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

/** The catalog owner publishes consumed price changes; labels have their own subscribers. */
export function isUsagePresentationHomeAccountChange(event: HomeAccountChangeEvent): boolean {
    return event.changeKinds?.length === 1 && event.changeKinds[0] === 'account'
        && event.entityIds !== undefined && event.entityIds.length > 0
        && event.entityIds.every(id => id === CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1);
}

/** These named Account observations contain allowances, never accounting events or entered prices. */
export function isUsageQuotaHomeAccountChange(event: HomeAccountChangeEvent): boolean {
    return event.source !== 'snapshot' && event.usageAccountingChange === undefined
        && event.changeKinds?.length === 1 && event.changeKinds[0] === 'account'
        && event.entityIds !== undefined && event.entityIds.length > 0
        && event.entityIds.every(id => id === PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1
            || readConnectedServicesAccountChangeV1({ kind: 'account', entityId: id }) !== null);
}

type UsageAccountingChangeScope = Readonly<{ sessionIds: readonly string[]; observedFromMs?: number }>;

/** A Session-only Home page names its accounting scope even without an ephemeral usage hint. */
export function readUsageAccountingChangeScope(event: HomeAccountChangeEvent): UsageAccountingChangeScope | undefined {
    const change = event.usageAccountingChange;
    if (change) return change.sessionId === null ? undefined : {
        sessionIds: [change.sessionId], ...(change.observedFromMs !== undefined ? { observedFromMs: change.observedFromMs } : {}),
    };
    if (event.source === 'snapshot' || event.source === 'connected' || !event.entityIds?.length
        || !event.changeKinds?.length || !event.changeKinds.every(kind => kind === 'session')) return undefined;
    return { sessionIds: event.entityIds };
}

/** Only the end excludes an observation: pre-range counters still establish baselines. */
export function usageAccountingChangeAffectsQueries(queries: readonly UsageQuery[], change: UsageAccountingChangeScope): boolean {
    const sessionIds = new Set(change.sessionIds);
    return queries.some(query => query.includeAccounting
        && (query.session === null || (typeof query.session === 'string' ? sessionIds.has(query.session)
            : query.session.some(id => sessionIds.has(id))))
        && (change.observedFromMs === undefined
            || (resolveUsageQueryPeriod(query, Date.now()).endMs ?? Number.POSITIVE_INFINITY) > change.observedFromMs));
}

/** Quota pushes, foreground and explicit recovery invalidate reads; only a predecessor's positive producer deadline schedules acquisition. */
export function getUsageProjectionNextReadAtMs(input: Readonly<{
    legacyStaleAfterMs?: number;
}> = {}): number {
    return input.legacyStaleAfterMs !== undefined && input.legacyStaleAfterMs > 0
        ? Date.now() + Math.trunc(input.legacyStaleAfterMs) : Number.POSITIVE_INFINITY;
}

/** Detailed Profile/Settings and Machine changes arrive through their material-input subscriptions. */
export function isUsageProjectionHomeAccountChange(event: HomeAccountChangeEvent, observesMaterialInputs = false): boolean {
    // A mounted Usage owner already observes its material inputs and the
    // focused durable catch-up. A secondary socket reconnect changes neither.
    // An actual snapshot/reset cannot name changes and still demands once.
    return event.source === 'snapshot' || !observesMaterialInputs && event.source === 'connected' || event.usageQueryAffects !== false
        && ((!observesMaterialInputs && event.entityIds === undefined) || event.entityIds?.includes(PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1) === true
            || (event.changeKinds === undefined || event.changeKinds.includes('account'))
                && event.entityIds?.some(entityId => readConnectedServicesAccountChangeV1({ kind: 'account', entityId }) !== null) === true
            || !observesMaterialInputs && event.changeKinds === undefined && event.entityIds?.includes('self') === true);
}

/**
 * Acquisition currentness shared by Usage's admitted-reference and provider-row projections.
 * It owns no data or authority: readers retain their credential, mode and generation fences.
 * A wake during a read remains pending until settlement, including during a manual refresh.
 */
export function observeUsageProjection(input: Readonly<{
    serverId: string;
    /** The caller already awaited an admitted read before attaching this observation. */
    initialReadCompleted?: boolean;
    read(): Promise<unknown>;
    busy(): boolean;
    nextReadAtMs(): number;
    /** Aging a retained observation updates presentation without another GET. */
    presentationDeadlineMs?(): number | undefined;
    publish?(): void;
}>): Readonly<{ reconcile(): void; invalidate(): void; dispose(): void }> {
    let disposed = false;
    let pending = input.initialReadCompleted !== true;
    let active = isRuntimeActive();
    let timer: ReturnType<typeof setTimeout> | null = null;
    function reconcile(): void {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (disposed || !isRuntimeActive() || input.busy()) return;
        if (pending) {
            pending = false;
            void input.read().then(reconcile, reconcile);
            return;
        }
        const readDeadline = input.nextReadAtMs();
        const presentationDeadline = input.presentationDeadlineMs?.();
        const deadline = Math.min(readDeadline, presentationDeadline !== undefined && presentationDeadline > Date.now()
            ? presentationDeadline : Number.POSITIVE_INFINITY);
        if (!Number.isFinite(deadline)) return;
        timer = setTimeout(() => {
            timer = null;
            // Timer chunks observe the same owner deadline; an early chunk is not aging or a GET.
            if (deadline > Date.now()) { reconcile(); return; }
            if (readDeadline <= Date.now()) invalidate();
            else { input.publish?.(); reconcile(); }
        }, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
    }
    function invalidate(): void { pending = true; reconcile(); }
    const detachHome = subscribeHomeAccountChange(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, input.serverId)) return;
        if (isUsageProjectionHomeAccountChange(event)) invalidate();
    }, { reconnect: 'refresh' });
    const detachRuntime = subscribeToRuntimeActiveChange(() => {
        const nextActive = isRuntimeActive();
        if (nextActive && !active) pending = true;
        active = nextActive;
        reconcile();
    });
    // Defer the initial read until the caller has assigned the observer to its retained entry.
    queueMicrotask(reconcile);
    return { reconcile, invalidate, dispose() {
        disposed = true;
        if (timer !== null) clearTimeout(timer);
        detachHome();
        detachRuntime();
    } };
}

export type UsageQueryMachineConsumers = Readonly<{
    /** Accounting source coverage consumes Machine names; quota and pool facts do not. */
    includeMachineNames?: boolean;
    poolMachineFilters: readonly (readonly string[])[];
    sessionMachineIds: readonly string[];
}>;

const NO_MACHINE_CONSUMERS: UsageQueryMachineConsumers = { poolMachineFilters: [], sessionMachineIds: [] };

function readUsageMachineFacts(machines: Readonly<Record<string, Machine>>, nowMs: number, scope?: ServerAccountScope | null) {
    return Object.values(machines).map(machine => {
        const reachability = resolveMachineReachability(scope, machine, nowMs);
        return { id: machine.id, name: readMachineName(machine), replaced: isMachineReplaced(machine),
            reachable: reachability === 'reachable',
            // A withdrawn observation or failed route is not a confirmed offline daemon.
            unavailable: reachability === 'unknown' || reachability === 'unreachable' && isMachineOnline(machine, nowMs) };
    })
        .sort((left, right) => left.id.localeCompare(right.id));
}

function readUsagePoolSelectorMachines(facts: ReturnType<typeof readUsageMachineFacts>, machineIds: readonly string[]) {
    return facts.filter(machine => !machine.replaced && machine.reachable
        && (machineIds.length === 0 || machineIds.includes(machine.id)));
}

function selectUsagePoolMachine(facts: ReturnType<typeof readUsageMachineFacts>, machineIds: readonly string[]) {
    const eligible = readUsagePoolSelectorMachines(facts, machineIds);
    if (eligible.length === 1) return { status: 'pending' as const, machineId: eligible[0]!.id };
    if (eligible.length > 1) return { status: 'unknown' as const };
    const unavailable = facts.filter(machine => !machine.replaced && machine.unavailable
        && (machineIds.length === 0 || machineIds.includes(machine.id)));
    return unavailable.length > 0 ? { status: 'error' as const, errorCode: 'MACHINE_RPC_UNREACHABLE',
        ...(unavailable.length === 1 ? { machineId: unavailable[0]!.id } : {}) }
        : { status: 'unsupported' as const, errorCode: 'no_machine' };
}

/** Pool reads and invalidation resolve the same current selector; ambiguity is not a machine identity. */
export function getUsageQueryPoolMachineSelection(machines: Readonly<Record<string, Machine>>, machineIds: readonly string[],
    scope: ServerAccountScope, nowMs = Date.now()) {
    return selectUsagePoolMachine(readUsageMachineFacts(machines, nowMs, scope), machineIds);
}

/**
 * The Machines a pool's switching order could be read on for this Machines filter. Each keeps its own order,
 * so when there are several the read is `unknown` and a person chooses one; this never picks for them.
 */
export function listUsagePoolSelectorMachineIds(machines: Readonly<Record<string, Machine>>, machineIds: readonly string[],
    scope: ServerAccountScope, nowMs = Date.now()): string[] {
    return readUsagePoolSelectorMachines(readUsageMachineFacts(machines, nowMs, scope), machineIds).map(machine => machine.id);
}

function consumedMachineKey(facts: ReturnType<typeof readUsageMachineFacts>, consumers: UsageQueryMachineConsumers): string {
    const byId = new Map(facts.map(machine => [machine.id, machine]));
    return JSON.stringify([
        consumers.includeMachineNames === false ? [] : facts.map(machine => [machine.id, machine.name]),
        consumers.poolMachineFilters.map(ids => selectUsagePoolMachine(facts, ids)),
        [...new Set(consumers.sessionMachineIds)].sort().map(id => [id, byId.get(id)?.replaced, byId.get(id)?.reachable]),
    ]);
}

export function getUsageQueryMachineInvalidationKey(machines: Readonly<Record<string, Machine>>, nowMs = Date.now(),
    scope?: ServerAccountScope | null, consumers: UsageQueryMachineConsumers = NO_MACHINE_CONSUMERS): string {
    return consumedMachineKey(readUsageMachineFacts(machines, nowMs, scope), consumers);
}

/** State invalidation for the Account-owned Usage Resource; not a second data reader. */
export function subscribeUsageQueryStateInvalidation(invalidate: (input: 'quota-inputs' | 'projection-inputs') => void,
    readMachineConsumers: (machines: Readonly<Record<string, Machine>>) => UsageQueryMachineConsumers = () => NO_MACHINE_CONSUMERS,
    observe: (attach: () => () => void) => () => void = attach => attach()): (() => void) | null {
    const readInputs = () => {
        const state = readRegisteredStorageState();
        return [state?.profileScope, state?.profile.connectedAccountsV4, state?.profile.connectedAccountGroupsV4,
            state?.machines, state?.settingsScope,
            state?.settings.experiments, state?.settings.featureToggles, state?.settings.usagePacingTargetsV1,
            state?.settings.usageCoachPreferencesV1, state?.settings.usageNightHoursV1, state?.settings.usageModelPriceOverridesV1] as const;
    };
    // Credential activity does not change quota facts or their admission. The
    // persisted Usage change signal separately wakes new provider observations.
    const readAccountInputs = (accounts: ReturnType<typeof readInputs>[1]) => accounts?.map(({ lastUsedAt: _lastUsedAt, ...account }) => account);
    const readMachineFacts = (machines: ReturnType<typeof readInputs>[3], nowMs: number, scope: ServerAccountScope | null | undefined) => {
        const facts = readUsageMachineFacts(machines ?? {}, nowMs, scope);
        return { facts, byId: new Map(facts.map(fact => [fact.id, fact])) };
    };
    let observedInputs = readInputs();
    const readUsageCapabilities = () => JSON.stringify(readRegisteredStorageState()?.profile.connectedAccountsV4
        .map(account => isConnectedServiceUsageCapable(account.ref.service)) ?? []);
    let observedUsageCapabilities = readUsageCapabilities();
    let observedMachineFacts = readMachineFacts(observedInputs[3], Date.now(), observedInputs[0]);
    let observedReachabilityRevision = readMachineRequestReachabilityRevision();
    const reconcile = (machineActivityChanged = false) => {
        const inputs = readInputs();
        const nowMs = Date.now();
        // Retain the listener's already-observed projection before doing any
        // machine enumeration, parsing, sorting or serialization.
        const reachabilityRevision = readMachineRequestReachabilityRevision();
        const machineFactsCurrent = !machineActivityChanged && inputs[3] === observedInputs[3] && inputs[0]?.serverId === observedInputs[0]?.serverId
            && inputs[0]?.accountId === observedInputs[0]?.accountId
            && reachabilityRevision === observedReachabilityRevision;
        if (machineFactsCurrent && inputs.every((input, index) => input === observedInputs[index])) return;
        const machineFacts = machineFactsCurrent ? observedMachineFacts : readMachineFacts(inputs[3], nowMs, inputs[0]);
        // Evaluate both projections against the same currently admitted demand.
        // A newly opened pool/Session must not itself look like a machine change
        // on the next unrelated store notification. Retained facts also preserve
        // the old request reachability after its canonical observation changes.
        const changedInputs = inputs.map((input, index) => index !== 3 && input !== observedInputs[index]
            && (index === 1 ? !sameStrictJsonValue(readAccountInputs(inputs[1]), readAccountInputs(observedInputs[1]))
                : !sameStrictJsonValue(input, observedInputs[index])));
        const consumers = !machineFactsCurrent ? readMachineConsumers(inputs[3] ?? {}) : undefined;
        const previousConsumers = !machineFactsCurrent ? readMachineConsumers(observedInputs[3] ?? {}) : undefined;
        const changed = !machineFactsCurrent && consumedMachineKey(machineFacts.facts, consumers!)
            !== consumedMachineKey(observedMachineFacts.facts, previousConsumers!)
            // Profile/Settings hydration can replace these small admitted inputs
            // without changing Usage evidence. Compare only changed references;
            // ordinary store churn still exits before any projection work.
            || changedInputs.some(Boolean);
        // Presentation preferences do not change admitted allowance facts.
        // Quotas use the server feature bit only; experiments and local feature
        // toggles can change Usage presentation but never that decision.
        const machineAdmissionChanged = !machineFactsCurrent
            && consumedMachineKey(machineFacts.facts, { ...consumers!, includeMachineNames: false })
                !== consumedMachineKey(observedMachineFacts.facts, { ...previousConsumers!, includeMachineNames: false });
        // Groups and selector/SCM eligibility need fresh admission. Only names
        // and preferences can reuse already-admitted A, B and private evidence.
        const quotaInputsChanged = [0, 1, 2, 4, 7].some(index => changedInputs[index]) || machineAdmissionChanged;
        observedInputs = inputs;
        observedUsageCapabilities = readUsageCapabilities();
        observedMachineFacts = machineFacts;
        observedReachabilityRevision = reachabilityRevision;
        if (changed) invalidate(quotaInputsChanged ? 'quota-inputs' : 'projection-inputs');
    };
    return observe(() => {
        reconcile();
        const unwatchState = subscribeRegisteredStorageState(() => reconcile(), {
            profileScope: true, profile: ['connectedAccountsV4', 'connectedAccountGroupsV4'], machines: true, settingsScope: true,
            settings: ['experiments', 'featureToggles', 'usagePacingTargetsV1', 'usageCoachPreferencesV1', 'usageNightHoursV1', 'usageModelPriceOverridesV1'],
        });
        const unwatchReachability = subscribeMachineRequestReachability(() => reconcile());
        const unwatchMachineActivity = subscribeRegisteredStorageMachineUpdates((serverId, machineIds) => {
            const state = readRegisteredStorageState();
            const scope = state?.profileScope;
            if (!state || !scope || !areServerProfileIdentifiersEquivalent(scope.serverId, serverId)) return;
            if (machineIds.some(id => {
                const machine = state.machines[id];
                const previous = observedMachineFacts.byId.get(id);
                return machine && previous && previous.reachable !== isMachineReachable(scope, machine);
            })) reconcile(true);
        });
        const unwatchRegistry = subscribeConnectedServiceRegistry(() => {
            const capabilities = readUsageCapabilities();
            if (capabilities === observedUsageCapabilities) return;
            observedUsageCapabilities = capabilities;
            invalidate('quota-inputs');
        });
        return () => { unwatchState?.(); unwatchReachability(); unwatchMachineActivity?.(); unwatchRegistry(); };
    });
}
