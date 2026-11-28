import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import type { Profile } from '@/sync/domains/profiles/profile';
import { readUsageAppCallsEnvironmentIds } from '@/sync/domains/usage/usageAppCallsSource';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { readRegisteredStorageState, subscribeRegisteredStorageState, subscribeRegisteredStorageMachineUpdates } from '@/sync/domains/state/storageStateReaderBridge';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { readConnectedServicesAccountChangeV1 } from '@happier-dev/protocol/changes';
import { isProviderAccountUsageChangeEntityIdV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import type { ProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { resolveMachineReachability, readMachineRequestReachabilityRevision, subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readConnectedServiceDeclaredCapabilities, subscribeConnectedServiceRegistry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { projectUsageQuotaAccountSources } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { resolveUsageQueryPeriod, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

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
        && event.entityIds.every(id => isProviderAccountUsageChangeEntityIdV1(id)
            || readConnectedServicesAccountChangeV1({ kind: 'account', entityId: id }) !== null);
}

/** Recovery and unknown source/credential changes retain the incumbent full read. */
export function readUsageQuotaChangedRecordIds(event: HomeAccountChangeEvent): readonly string[] | undefined {
    return event.source !== 'snapshot' && event.source !== 'connected'
        && event.providerAccountUsageRecordIds?.length ? event.providerAccountUsageRecordIds : undefined;
}

/** A service publication identifies the bindings to verify, without asserting that they changed. */
export function readUsageQuotaBindingServiceKeys(event: HomeAccountChangeEvent): readonly string[] | undefined {
    if (event.source === 'connected' || event.source === 'snapshot') return undefined;
    if (event.feedPageConsumed) return event.providerAccountUsageBindingServiceKeys;
    if (!isUsageQuotaHomeAccountChange(event)) return undefined;
    const keys: string[] = [];
    for (const entityId of event.entityIds ?? []) {
        const change = readConnectedServicesAccountChangeV1({ kind: 'account', entityId });
        if (change?.scope !== 'service') return undefined;
        keys.push(buildQualifiedPluginContributionKey(change.ref));
    }
    return keys;
}

/** An unresolved source still needs acquisition; admitted sources consume only their record changes. */
export function usageQuotaRecordChangeAffects(recordId: string | null | undefined, changedRecordIds: readonly string[] | undefined): boolean {
    return changedRecordIds === undefined || recordId == null || changedRecordIds.includes(recordId);
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
        // A scoped Session ledger change cannot invalidate App collector facts.
        && readUsageAppCallsEnvironmentIds(query.sources) === null
        && (query.session === null || (typeof query.session === 'string' ? sessionIds.has(query.session)
            : query.session.some(id => sessionIds.has(id))))
        && (change.observedFromMs === undefined
            || (resolveUsageQueryPeriod(query, Date.now()).endMs ?? Number.POSITIVE_INFINITY) > change.observedFromMs));
}

/** Detailed Profile/Settings and Machine changes arrive through their material-input subscriptions. */
export function isUsageProjectionHomeAccountChange(event: HomeAccountChangeEvent, observesMaterialInputs = false,
    recordIds?: readonly (string | null | undefined)[]): boolean {
    // A mounted Usage owner already observes its material inputs and the
    // focused durable catch-up. A secondary socket reconnect changes neither.
    // An actual snapshot/reset cannot name changes and still demands once.
    if (recordIds !== undefined && !recordIds.some(id => usageQuotaRecordChangeAffects(id, readUsageQuotaChangedRecordIds(event)))
        && readUsageQuotaBindingServiceKeys(event) === undefined) return false;
    return event.source === 'snapshot' || !observesMaterialInputs && event.source === 'connected' || event.usageQueryAffects !== false
        && ((!observesMaterialInputs && event.entityIds === undefined) || event.entityIds?.some(isProviderAccountUsageChangeEntityIdV1) === true
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
    readRecordId?(): string | null | undefined;
    read(recordId?: ProviderAccountUsageRecordId): Promise<unknown>;
    busy(): boolean;
    nextReadAtMs(): number;
    /** Aging a retained observation updates presentation without another GET. */
    presentationDeadlineMs?(): number | undefined;
    publish?(): void;
}>): Readonly<{ reconcile(): void; invalidate(): void; dispose(): void }> {
    let disposed = false;
    let pending = input.initialReadCompleted !== true;
    let addressedRecordId: ProviderAccountUsageRecordId | undefined;
    let active = isRuntimeActive();
    let timer: ReturnType<typeof setTimeout> | null = null;
    function reconcile(): void {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (disposed || !isRuntimeActive() || input.busy()) return;
        const recordId = !pending && addressedRecordId === input.readRecordId?.() ? addressedRecordId : undefined;
        const needsRead = pending || addressedRecordId !== undefined;
        addressedRecordId = undefined;
        if (needsRead) {
            pending = false;
            void input.read(recordId).then(reconcile, reconcile);
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
        const id = input.readRecordId?.();
        if (!isUsageProjectionHomeAccountChange(event, false, input.readRecordId ? [id] : undefined)) return;
        if (id && readUsageQuotaChangedRecordIds(event)?.includes(id)) {
            addressedRecordId = id;
            reconcile();
        } else invalidate();
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

/** Scope route and presence changes wake Work reuse and update the pool selector. */
function readUsageWorkMachineReadiness(
    scope: ServerAccountScope | null | undefined,
    machineId: string,
    machine: Machine | null | undefined,
    nowMs = Date.now(),
) {
    const reachability = resolveMachineReachability(scope, machine ?? { id: machineId, active: false }, nowMs);
    if (reachability !== 'unreachable') return reachability;
    return machine && isMachineOnline(machine, nowMs) === false ? 'machine_offline' : 'target_unavailable';
}

function readUsageMachineFacts(machines: Readonly<Record<string, Machine>>, nowMs: number, scope?: ServerAccountScope | null) {
    return Object.values(machines).map(machine => ({
        id: machine.id,
        name: readMachineName(machine),
        replaced: isMachineReplaced(machine),
        readiness: readUsageWorkMachineReadiness(scope, machine.id, machine, nowMs),
    }))
        .sort((left, right) => left.id.localeCompare(right.id));
}

function readUsagePoolSelectorMachines(facts: ReturnType<typeof readUsageMachineFacts>, machineIds: readonly string[]) {
    return facts.filter(machine => !machine.replaced && machine.readiness === 'reachable'
        && (machineIds.length === 0 || machineIds.includes(machine.id)));
}

function selectUsagePoolMachine(facts: ReturnType<typeof readUsageMachineFacts>, machineIds: readonly string[]) {
    const eligible = readUsagePoolSelectorMachines(facts, machineIds);
    if (eligible.length === 1) return { status: 'pending' as const, machineId: eligible[0]!.id };
    if (eligible.length > 1) return { status: 'unknown' as const };
    const unavailable = facts.filter(machine => !machine.replaced
        && (machine.readiness === 'unknown' || machine.readiness === 'target_unavailable')
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

function readConsumedMachineFacts(facts: ReturnType<typeof readUsageMachineFacts>, consumers: UsageQueryMachineConsumers,
    readMissingReadiness?: (machineId: string) => ReturnType<typeof readUsageWorkMachineReadiness>) {
    const byId = new Map(facts.map(machine => [machine.id, machine]));
    return [
        consumers.includeMachineNames === false ? [] : facts.map(machine => [machine.id, machine.name]),
        consumers.poolMachineFilters.map(ids => selectUsagePoolMachine(facts, ids)),
        [...new Set(consumers.sessionMachineIds)].sort().map(id => {
            const machine = byId.get(id);
            return [id, machine?.replaced, machine?.readiness ?? readMissingReadiness?.(id)];
        }),
    ] as const;
}

export function getUsageQueryMachineInvalidationKey(machines: Readonly<Record<string, Machine>>, nowMs = Date.now(),
    scope?: ServerAccountScope | null, consumers: UsageQueryMachineConsumers = NO_MACHINE_CONSUMERS): string {
    return JSON.stringify(readConsumedMachineFacts(readUsageMachineFacts(machines, nowMs, scope), consumers,
        id => readUsageWorkMachineReadiness(scope, id, undefined, nowMs)));
}

type QuotaAccount = Profile['connectedAccountsV4'][number];

export function readUsageQuotaAccountProjection(accounts: readonly QuotaAccount[]) {
    return projectUsageQuotaAccountSources(accounts, readConnectedServiceDeclaredCapabilities);
}

function quotaAccountInput({ lastUsedAt: _lastUsedAt, ...account }: QuotaAccount) {
    return account;
}

function changedQuotaSourceKeys(before: readonly QuotaAccount[], after: readonly QuotaAccount[]): string[] {
    if (before === after || before.length === after.length && before.every((row, index) => row === after[index])) return [];
    const bySource = (accounts: readonly QuotaAccount[]) => new Map(accounts.map(account =>
        [createCanonicalJsonSigningInput({ bindingKind: 'account', ref: account.ref }), quotaAccountInput(account)]));
    const previous = bySource(before);
    const current = bySource(after);
    return [...new Set([...previous.keys(), ...current.keys()])].filter(key =>
        !sameStrictJsonValue(previous.get(key), current.get(key)));
}

export type UsageQueryStateInvalidation = 'quota-inputs' | 'quota-pool-inputs' | 'quota-projection-inputs' | 'material-inputs' | 'projection-inputs' | 'session-evidence';

/** State invalidation for the Account-owned Usage Resource; not a second data reader. */
export function subscribeUsageQueryStateInvalidation(invalidate: (input: UsageQueryStateInvalidation, quotaSourceKeys?: readonly string[]) => void,
    readMachineConsumers: (machines: Readonly<Record<string, Machine>>) => UsageQueryMachineConsumers = () => NO_MACHINE_CONSUMERS,
    observe: (attach: () => () => void) => () => void = attach => attach()): ((() => void) & Readonly<{ reconcile(): void }>) | null {
    const readInputs = () => {
        const state = readRegisteredStorageState();
        return [state?.profileScope, state?.profile.connectedAccountsV4, state?.profile.connectedAccountGroupsV4,
            state?.machines, state?.settingsScope,
            state?.settings.experiments, state?.settings.featureToggles, state?.settings.usagePacingTargetsV1,
            state?.settings.usageCoachPreferencesV1, state?.settings.usageNightHoursV1, state?.settings.usageModelPriceOverridesV1] as const;
    };
    // Credential activity does not change quota facts or their admission. The
    // persisted Usage change signal separately wakes new provider observations.
    const readAccountInputs = (accounts: ReturnType<typeof readInputs>[1]) => accounts?.map(quotaAccountInput);
    const readMachineFacts = (machines: ReturnType<typeof readInputs>[3], nowMs: number, scope: ServerAccountScope | null | undefined) => {
        const facts = readUsageMachineFacts(machines ?? {}, nowMs, scope);
        return { facts, byId: new Map(facts.map(fact => [fact.id, fact])) };
    };
    let observedInputs = readInputs();
    let observedQuota = readUsageQuotaAccountProjection(observedInputs[1] ?? []);
    let observedMachineFacts = readMachineFacts(observedInputs[3], Date.now(), observedInputs[0]);
    let observedReachabilityRevision = readMachineRequestReachabilityRevision();
    const reconcile = (refreshMachineFacts = false) => {
        const inputs = readInputs();
        const reachabilityRevision = readMachineRequestReachabilityRevision();
        const nowMs = Date.now();
        // Retain the listener's already-observed projection before doing any
        // machine enumeration, parsing, sorting or serialization.
        const sameMachineRows = inputs[3] === observedInputs[3];
        const machineFactsCurrent = !refreshMachineFacts && sameMachineRows && inputs[0]?.serverId === observedInputs[0]?.serverId
            && inputs[0]?.accountId === observedInputs[0]?.accountId;
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
        const previousConsumers = !machineFactsCurrent && !sameMachineRows ? readMachineConsumers(observedInputs[3] ?? {}) : consumers;
        let machineNamesChanged = false;
        let poolMachineChanged = false;
        let workMachineChanged = false;
        if (consumers && previousConsumers) {
            const [names, pools, work] = readConsumedMachineFacts(machineFacts.facts, consumers);
            const [previousNames, previousPools, previousWork] = readConsumedMachineFacts(observedMachineFacts.facts, previousConsumers);
            machineNamesChanged = !sameStrictJsonValue(names, previousNames);
            poolMachineChanged = !sameStrictJsonValue(pools, previousPools);
            workMachineChanged = !sameStrictJsonValue(work, previousWork);
        }
        const scopeChanged = changedInputs[0] || changedInputs[4];
        const quotaPoolInputsChanged = changedInputs[1] || changedInputs[2] || poolMachineChanged;
        const presentationInputsChanged = machineNamesChanged || changedInputs.slice(5).some(Boolean);
        const quota = changedInputs[1] ? readUsageQuotaAccountProjection(inputs[1] ?? []) : observedQuota;
        const quotaSourceKeys = quotaPoolInputsChanged ? changedQuotaSourceKeys(observedQuota.accounts, quota.accounts) : undefined;
        observedInputs = inputs;
        observedQuota = quota;
        observedMachineFacts = machineFacts;
        // A synchronous Resource invalidation can re-enter admission. Those
        // reads already consume these facts, including this request revision.
        observedReachabilityRevision = reachabilityRevision;
        if (scopeChanged) invalidate('material-inputs');
        else if (workMachineChanged && (quotaPoolInputsChanged || presentationInputsChanged)) invalidate('material-inputs', quotaSourceKeys ?? []);
        else if (workMachineChanged) invalidate('session-evidence');
        else if (quotaPoolInputsChanged) invalidate('quota-pool-inputs', quotaSourceKeys);
        else if (presentationInputsChanged) invalidate(changedInputs[7] ? 'quota-projection-inputs' : 'projection-inputs');
    };
    const reconcileMissedInputs = () => reconcile(readMachineRequestReachabilityRevision() !== observedReachabilityRevision);
    const dispose = observe(() => {
        // Detect observations missed while no view was subscribed.
        reconcileMissedInputs();
        const unwatchState = subscribeRegisteredStorageState(() => reconcile(), {
            profileScope: true, profile: ['connectedAccountsV4', 'connectedAccountGroupsV4'], machines: true, settingsScope: true,
            settings: ['experiments', 'featureToggles', 'usagePacingTargetsV1', 'usageCoachPreferencesV1', 'usageNightHoursV1', 'usageModelPriceOverridesV1'],
        });
        const unwatchReachability = subscribeMachineRequestReachability(change => {
            if (change) {
                const scope = readRegisteredStorageState()?.profileScope;
                if (!scope || scope.accountId !== change.scope.accountId
                    || !areServerProfileIdentifiersEquivalent(scope.serverId, change.scope.serverId)) return;
            }
            reconcile(true);
        });
        const unwatchMachineActivity = subscribeRegisteredStorageMachineUpdates((serverId, machineIds) => {
            const state = readRegisteredStorageState();
            const scope = state?.profileScope;
            if (!state || !scope || !areServerProfileIdentifiersEquivalent(scope.serverId, serverId)) return;
            const nowMs = Date.now();
            if (machineIds.some(id => {
                const machine = state.machines[id];
                const previous = observedMachineFacts.byId.get(id);
                return machine && previous && previous.readiness !== readUsageWorkMachineReadiness(scope, id, machine, nowMs);
            })) reconcile(true);
        });
        const unwatchRegistry = subscribeConnectedServiceRegistry(() => {
            const quota = readUsageQuotaAccountProjection(readInputs()[1] ?? []);
            const sourceKeys = changedQuotaSourceKeys(observedQuota.accounts, quota.accounts);
            const causeChanged = observedQuota.unavailable?.errorCode !== quota.unavailable?.errorCode;
            observedQuota = quota;
            if (causeChanged || sourceKeys.length) invalidate('quota-inputs', sourceKeys);
        });
        return () => {
            unwatchState?.();
            unwatchReachability();
            unwatchMachineActivity?.();
            unwatchRegistry();
        };
    });
    return Object.assign(dispose, { reconcile: reconcileMissedInputs });
}
