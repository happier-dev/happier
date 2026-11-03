import {
    arePluginMachineExecutionOriginsEqual,
    getPluginMachineExecutionOriginRef,
    PluginMachineExecutionOriginV1Schema,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginSourceCustodyV1Schema, pluginSourceCustodyV1Equal, type PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { PluginUiResourceBindingCapabilityV1Schema, type PluginUiResourceBindingCapabilityV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginUiProjectionModel } from './projection';
import type { PluginUiProjectionPhase } from './usePluginUiProjectionCurrentness';

type UnknownRecord = Readonly<Record<string, unknown>>;

/** Host-private contribution binding; never an Account or invocation admission. */
export const PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY = 'hostOrigin';

export type PluginUiContributionOriginV1 = Readonly<{
    machineId: string;
    serverId: string | null;
    serverIdentityId?: string;
    /** Currentness/activation cause, separate from release correspondence. */
    unavailableReasonCode?: string;
    /** Each contribution retains its own origin's executable currentness. */
    interactionEnabled: boolean;
    phase: PluginUiProjectionPhase;
    /** Exact producer identity; effects requiring ownership fail closed without it. */
    executionOrigin: PluginMachineExecutionOriginV1 | null;
}>;

export type PluginUiContributionSupplyV1 = PluginUiContributionOriginV1 & Readonly<{
    occurrenceId: string | null;
    pluginVersion: string | null;
    sourceCustody: PluginSourceCustodyV1 | null;
    executionTargetDefault: boolean;
    executionTargetAutoPick?: boolean;
    /** This producer's surface capability, independent of Account renderer custody. */
    resourceCapability?: PluginUiResourceBindingCapabilityV1;
}>;

export type PluginUiAccountExecutableOrigin = Readonly<{
    serverId: string;
    accountId: string;
    custodyId: string;
    sourceCustody: Extract<PluginSourceCustodyV1, Readonly<{ kind: 'account_release' | 'bundled_first_party' }>>;
}>;

// These proofs live only with immutable values owned by this decoder. Freezing
// an arbitrary input does not establish validation, nor does copying a brand.
const directOriginProof = Symbol('pluginUiDirectOrigin');
const contributionOriginProof = Symbol('pluginUiContributionOrigin');
const accountOriginProof = Symbol('pluginUiAccountOrigin');
const parsedSupplyProof = Symbol('pluginUiParsedSupply');
const parsedContributionSupplies = Symbol('pluginUiParsedSupplies');
const originProofKeys = [directOriginProof, contributionOriginProof, accountOriginProof, parsedSupplyProof] as const;

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readPhase(value: unknown): PluginUiProjectionPhase | null {
    return value === 'establishing' || value === 'current' || value === 'retainedOffline' || value === 'unavailable' ? value : null;
}

function readProof<T>(record: UnknownRecord | null, key: symbol): T | null {
    const proof = record ? asRecord(Object.getOwnPropertyDescriptor(record, key)?.value) : null;
    // Only this module creates the private descriptor and its immutable value.
    return proof && proof.owner === record ? proof.value as T : null;
}

function installProof(record: object, key: symbol, value: unknown): void {
    Object.defineProperty(record, key, { value: Object.freeze({ owner: record, value }) });
}

function freezeOwnedFacts(value: unknown): void {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freezeOwnedFacts(child);
    Object.freeze(value);
}

/** Availability supplies custody, not invocation admission. Raw stamps validate anew. */
export function readPluginUiAccountExecutableOrigin(entry: unknown): PluginUiAccountExecutableOrigin | null {
    const record = asRecord(entry);
    const stamp = asRecord(record?.hostAccountOrigin);
    const prepared = readProof<PluginUiAccountExecutableOrigin>(stamp, accountOriginProof);
    if (prepared) return prepared.sourceCustody.kind !== 'account_release'
        || prepared.sourceCustody.pluginId === record?.pluginId ? prepared : null;
    if (!stamp || typeof stamp.serverId !== 'string' || !stamp.serverId.trim()
        || typeof stamp.accountId !== 'string' || !stamp.accountId.trim()
        || typeof stamp.custodyId !== 'string' || !stamp.custodyId.trim()) return null;
    const custody = PluginSourceCustodyV1Schema.safeParse(stamp.sourceCustody);
    if (!custody.success || (custody.data.kind !== 'bundled_first_party' && custody.data.kind !== 'account_release')
        || (custody.data.kind === 'account_release' && custody.data.pluginId !== record?.pluginId)) return null;
    const origin: PluginUiAccountExecutableOrigin = { serverId: stamp.serverId, accountId: stamp.accountId,
        custodyId: stamp.custodyId, sourceCustody: custody.data };
    freezeOwnedFacts(origin);
    return origin;
}

function readCanonicalDirectOrigin(value: unknown): PluginMachineExecutionOriginV1 | null {
    const prepared = readProof<PluginMachineExecutionOriginV1>(asRecord(value), directOriginProof);
    if (prepared) return prepared;
    const parsed = PluginMachineExecutionOriginV1Schema.safeParse(value);
    if (!parsed.success) return null;
    installProof(parsed.data, directOriginProof, parsed.data);
    freezeOwnedFacts(parsed.data);
    return parsed.data;
}

/** Direct producer identity; the caller's current plugin id is still checked. */
export function readPluginUiProjectionEntryExecutionOrigin(entry: unknown): PluginMachineExecutionOriginV1 | null {
    const candidate = asRecord(entry);
    const pluginId = readString(candidate?.pluginId);
    if (!candidate || !pluginId || candidate.executionOrigin == null) return null;
    const origin = readCanonicalDirectOrigin(candidate.executionOrigin);
    return origin && getPluginMachineExecutionOriginRef(origin).pluginId === pluginId ? origin : null;
}

/** A declaration can inherit custody only from its current installed occurrence. */
export function hasCurrentPluginUiProjectionOccurrence(
    projection: Pick<PluginUiProjectionModel, 'installedPackagesById'>,
    entry: Readonly<{ pluginId: string; occurrenceId?: string }>,
): boolean {
    const occurrenceId = readString(entry.occurrenceId);
    const installed = projection.installedPackagesById[entry.pluginId];
    return occurrenceId !== null && installed?.enabled === true && installed.occurrenceId === occurrenceId;
}

/** Some declaration families omit stamps; their installed package owns the origin. */
export function readPluginUiProjectionEntryOrPackageExecutionOrigin(
    projection: Pick<PluginUiProjectionModel, 'installedPackagesById'>,
    entry: unknown,
    packageOriginsByPluginId?: Map<string, PluginMachineExecutionOriginV1 | null>,
): PluginMachineExecutionOriginV1 | null {
    const producerOrigin = readPluginUiProjectionEntryExecutionOrigin(entry);
    if (producerOrigin) return producerOrigin;
    const record = asRecord(entry);
    if (!record || record.executionOrigin !== undefined) return null;
    const pluginId = readString(record.pluginId);
    if (!pluginId || !hasCurrentPluginUiProjectionOccurrence(projection, {
        pluginId, occurrenceId: readString(record.occurrenceId) ?? undefined,
    })) return null;
    if (packageOriginsByPluginId?.has(pluginId)) return packageOriginsByPluginId.get(pluginId) ?? null;
    const origin = readPluginUiProjectionEntryExecutionOrigin({
        pluginId, executionOrigin: projection.installedPackagesById[pluginId]?.executionOrigin,
    });
    packageOriginsByPluginId?.set(pluginId, origin);
    return origin;
}

/** A standalone raw stamp is validated anew; published owned stamps read O(1). */
export function readPluginUiContributionOrigin(entry: unknown): PluginUiContributionOriginV1 | null {
    const origin = asRecord(asRecord(entry)?.[PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]);
    const prepared = readProof<PluginUiContributionOriginV1>(origin, contributionOriginProof);
    if (prepared) return prepared;
    const machineId = readString(origin?.machineId);
    const phase = readPhase(origin?.phase);
    if (!origin || !machineId || !phase) return null;
    const executionOrigin = origin.executionOrigin == null ? null : readCanonicalDirectOrigin(origin.executionOrigin);
    const result: PluginUiContributionOriginV1 = {
        machineId,
        serverId: readString(origin.serverId),
        ...(readString(origin.serverIdentityId) ? { serverIdentityId: readString(origin.serverIdentityId)! } : {}),
        ...(readString(origin.unavailableReasonCode) ? { unavailableReasonCode: readString(origin.unavailableReasonCode)! } : {}),
        interactionEnabled: origin.interactionEnabled === true,
        phase,
        executionOrigin,
    };
    installProof(result, contributionOriginProof, result);
    return Object.freeze(result);
}

function isParsedContributionSupplies(value: readonly unknown[]): value is readonly PluginUiContributionSupplyV1[] {
    return Object.getOwnPropertyDescriptor(value, parsedContributionSupplies)?.value === value;
}

function proveParsedContributionSupplies(supplies: PluginUiContributionSupplyV1[]): readonly PluginUiContributionSupplyV1[] {
    Object.defineProperty(supplies, parsedContributionSupplies, { value: supplies });
    return Object.freeze(supplies);
}

function parseContributionSupplies(supplies: readonly unknown[]): PluginUiContributionSupplyV1[] {
    return supplies.flatMap(supply => {
        const prepared = readProof<PluginUiContributionSupplyV1>(asRecord(supply), parsedSupplyProof);
        if (prepared) return [prepared];
        const origin = readPluginUiContributionOrigin({ hostOrigin: supply });
        if (!origin) return [];
        const facts = asRecord(supply);
        const custody = facts?.sourceCustody == null ? null : PluginSourceCustodyV1Schema.safeParse(facts.sourceCustody);
        const resourceCapability = PluginUiResourceBindingCapabilityV1Schema.safeParse(facts?.resourceCapability);
        const parsed: PluginUiContributionSupplyV1 = {
            ...origin,
            occurrenceId: readString(facts?.occurrenceId),
            pluginVersion: readString(facts?.pluginVersion),
            sourceCustody: custody?.success ? custody.data : null,
            executionTargetDefault: facts?.executionTargetDefault === true,
            ...(facts?.executionTargetAutoPick === false ? { executionTargetAutoPick: false } : {}),
            ...(resourceCapability.success ? { resourceCapability: resourceCapability.data } : {}),
        };
        installProof(parsed, contributionOriginProof, origin);
        installProof(parsed, parsedSupplyProof, parsed);
        freezeOwnedFacts(parsed);
        return [parsed];
    });
}

export function readPluginUiContributionSupplies(entry: unknown): readonly PluginUiContributionSupplyV1[] {
    const supplies = asRecord(entry)?.hostSupplies;
    if (Array.isArray(supplies) && isParsedContributionSupplies(supplies)) return supplies;
    return Array.isArray(supplies) ? parseContributionSupplies(supplies) : [];
}

/** The union publishes only canonical, owned supply facts, never a trust flag. */
export function publishPluginUiContributionSupplies(supplies: readonly PluginUiContributionSupplyV1[]): readonly PluginUiContributionSupplyV1[] {
    return isParsedContributionSupplies(supplies) ? supplies : proveParsedContributionSupplies(parseContributionSupplies(supplies));
}

function prepareDirectOrigin(value: unknown, canonical?: PluginMachineExecutionOriginV1 | null): unknown {
    const record = asRecord(value);
    if (!record || readProof(record, directOriginProof)) return value;
    const origin = canonical ?? readCanonicalDirectOrigin(value);
    if (!origin) return value;
    // Valid schema inputs contain only defined JSON fields. Keep authored field
    // order and spelling while owning every nested reference independently.
    const owned = { ...asRecord(projectNativeJsonValueForTransport(record)) };
    installProof(owned, directOriginProof, origin);
    return Object.freeze(owned);
}

function prepareContributionOrigin(value: unknown): unknown {
    const record = asRecord(value);
    if (!record || readProof(record, contributionOriginProof)) return value;
    const origin = readPluginUiContributionOrigin({ hostOrigin: record });
    if (!origin || (record.executionOrigin != null && !origin.executionOrigin)) return value;
    const owned = { ...record,
        ...(Object.hasOwn(record, 'executionOrigin') ? {
            executionOrigin: record.executionOrigin == null ? record.executionOrigin : prepareDirectOrigin(record.executionOrigin, origin.executionOrigin),
        } : {}),
    };
    installProof(owned, contributionOriginProof, origin);
    return Object.freeze(owned);
}

function prepareAccountOrigin(value: unknown, pluginId: unknown): unknown {
    const record = asRecord(value);
    if (!record || readProof(record, accountOriginProof)) return value;
    const origin = readPluginUiAccountExecutableOrigin({ pluginId, hostAccountOrigin: record });
    if (!origin) return value;
    // Retain the stamp's enumerable fields and order; the parsed, immutable
    // semantic facts are private, and no caller-owned custody graph is kept.
    const owned = { ...record, sourceCustody: projectNativeJsonValueForTransport(record.sourceCustody) };
    installProof(owned, accountOriginProof, origin);
    return Object.freeze(owned);
}

/** Called by live, warm and Availability acquisition, never by a render/read. */
export function preparePluginUiProjectionOrigins(model: PluginUiProjectionModel, previous?: PluginUiProjectionModel): PluginUiProjectionModel {
    const updates: Record<string, unknown> = {};
    let changed = false;
    for (const [key, value] of Object.entries(model)) {
        if (value === asRecord(previous)?.[key]) continue;
        const map = asRecord(value);
        if (!map) continue;
        const previousMap = asRecord(asRecord(previous)?.[key]);
        let nextMap: Record<string, unknown> | undefined;
        for (const [id, value] of Object.entries(map)) {
            if (value === previousMap?.[id]) continue;
            const entry = asRecord(value);
            if (!entry) continue;
            const executionOrigin = prepareDirectOrigin(entry.executionOrigin);
            const hostOrigin = prepareContributionOrigin(entry.hostOrigin);
            const hostAccountOrigin = prepareAccountOrigin(entry.hostAccountOrigin, entry.pluginId);
            if (executionOrigin === entry.executionOrigin && hostOrigin === entry.hostOrigin && hostAccountOrigin === entry.hostAccountOrigin) continue;
            nextMap ??= { ...map };
            nextMap[id] = Object.freeze({ ...entry,
                ...(Object.hasOwn(entry, 'executionOrigin') ? { executionOrigin } : {}),
                ...(Object.hasOwn(entry, 'hostOrigin') ? { hostOrigin } : {}),
                ...(Object.hasOwn(entry, 'hostAccountOrigin') ? { hostAccountOrigin } : {}),
            });
        }
        if (nextMap) { updates[key] = Object.freeze(nextMap); changed = true; }
    }
    return changed ? Object.freeze({ ...model, ...updates }) : model;
}

/** Reconcile only at publication; private proofs never adopt unproven facts. */
export function retainPluginUiProjectionValue(previous: unknown, next: unknown): unknown {
    // Contribution rows share immutable supply/origin subgraphs. Reconcile each
    // pair once within this publication, without retaining prior inputs later.
    const retainedPairs = new WeakMap<object, WeakMap<object, unknown>>();
    const retain = (old: unknown, value: unknown): unknown => {
        if (old === value) return old;
        if (!old || typeof old !== 'object' || !value || typeof value !== 'object') {
            // Without two object graphs there is nothing to reconcile. In
            // particular, first publication must not walk an entire new graph.
            return value;
        }
        // Canonical supplies have a closed, validated shape. A currentness
        // change does not authorize traversing their immutable custody graphs.
        const beforeSupply = readProof<PluginUiContributionSupplyV1>(asRecord(old), parsedSupplyProof);
        const nextSupply = readProof<PluginUiContributionSupplyV1>(asRecord(value), parsedSupplyProof);
        if (beforeSupply && nextSupply && beforeSupply === old && nextSupply === value) return retainCanonicalSupply(beforeSupply, nextSupply);
        let values = retainedPairs.get(old);
        if (values?.has(value)) return values.get(value);
        const retained = retainPluginUiProjectionNode(old, value, retain);
        if (!values) { values = new WeakMap(); retainedPairs.set(old, values); }
        values.set(value, retained);
        return retained;
    };
    return retain(previous, next);
}

function retainCanonicalSupply(previous: PluginUiContributionSupplyV1, next: PluginUiContributionSupplyV1): PluginUiContributionSupplyV1 {
    const executionOrigin = previous.executionOrigin === next.executionOrigin
        || (previous.executionOrigin && next.executionOrigin && arePluginMachineExecutionOriginsEqual(previous.executionOrigin, next.executionOrigin))
        ? previous.executionOrigin : next.executionOrigin;
    const sourceCustody = previous.sourceCustody === next.sourceCustody
        || (previous.sourceCustody && next.sourceCustody && pluginSourceCustodyV1Equal(previous.sourceCustody, next.sourceCustody))
        ? previous.sourceCustody : next.sourceCustody;
    if (executionOrigin === previous.executionOrigin && sourceCustody === previous.sourceCustody
        && previous.machineId === next.machineId && previous.serverId === next.serverId
        && previous.serverIdentityId === next.serverIdentityId && previous.unavailableReasonCode === next.unavailableReasonCode
        && previous.interactionEnabled === next.interactionEnabled && previous.phase === next.phase
        && previous.occurrenceId === next.occurrenceId && previous.pluginVersion === next.pluginVersion
        && previous.executionTargetDefault === next.executionTargetDefault && previous.executionTargetAutoPick === next.executionTargetAutoPick
        && previous.resourceCapability?.readable === next.resourceCapability?.readable
        && previous.resourceCapability?.dynamic === next.resourceCapability?.dynamic) return previous;
    if (executionOrigin === next.executionOrigin && sourceCustody === next.sourceCustody) return next;
    const retained = { ...next, executionOrigin, sourceCustody };
    const origin = readProof<PluginUiContributionOriginV1>(asRecord(next), contributionOriginProof)!;
    installProof(retained, contributionOriginProof, Object.freeze({ ...origin, executionOrigin }));
    installProof(retained, parsedSupplyProof, retained);
    return Object.freeze(retained);
}

function retainPluginUiProjectionNode(previous: unknown, next: unknown, retain: (previous: unknown, next: unknown) => unknown): unknown {
    if (previous === next) return previous;
    if (Array.isArray(next)) {
        if (isParsedContributionSupplies(next) && (!Array.isArray(previous) || !isParsedContributionSupplies(previous))) return next;
        const old = Array.isArray(previous) ? previous : [];
        const retained = next.map((value, index) => retain(old[index], value));
        if (Array.isArray(previous) && old.length === retained.length && retained.every((value, index) => value === old[index])) return previous;
        if (retained.every((value, index) => value === next[index])) return next;
        return isParsedContributionSupplies(next) ? proveParsedContributionSupplies(retained as PluginUiContributionSupplyV1[]) : Object.freeze(retained);
    }
    const record = asRecord(next);
    if (!record || (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null)) return next;
    const old = asRecord(previous);
    for (const key of originProofKeys) {
        if (readProof(record, key) && !readProof(old, key)) return next;
    }
    const keys = Object.keys(record);
    const oldKeys = old ? Object.keys(old) : [];
    let samePrevious = old !== null && keys.length === oldKeys.length && keys.every((key, index) => key === oldKeys[index]);
    let sameNext = true;
    // Spread preserves authored own __proto__ data properties and key order.
    const retained: Record<string, unknown> = { ...record };
    for (const key of keys) {
        const value = retain(old?.[key], record[key]);
        retained[key] = value;
        if (!old || value !== old[key]) samePrevious = false;
        if (value !== record[key]) sameNext = false;
    }
    if (samePrevious) return previous;
    if (sameNext) return next;
    // Every retained child is either the next child or a proven immutable
    // equivalent. Rebind the private descriptor to this reconstructed owner.
    for (const key of originProofKeys) {
        const proof = readProof(record, key);
        if (proof) installProof(retained, key, proof);
    }
    return Object.freeze(retained);
}
