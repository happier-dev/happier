import {
    isBoundedPluginPerActiveServerValueV1,
    type DaemonPluginSettingsMutation,
    type DaemonPluginSettingsSnapshot,
} from '@happier-dev/protocol';

import type {
    MachinePluginSecretDeleteResult,
    MachinePluginSecretSetResult,
    MachinePluginSecretStatusResult,
    MachinePluginSettingsResult,
    MachinePluginSettingsSetResult,
} from '@/sync/ops/machineContributionRegistryProjection';

/**
 * Host-internal presentation adapter for declaration-backed plugin Settings.
 *
 * The adapter deliberately chooses exactly one canonical record per operation:
 * Account and daemon state are never merged, and a daemon target carries both
 * its portable identity and the device-local server id used solely for routing.
 * It is not exported through any Plugin UI bridge or SDK surface.
 */

export type ScopedPluginSettingsScope = Readonly<{ kind: 'account' | 'daemon' }>;

export type ScopedPluginSettingsDaemonTarget = Readonly<{
    kind: 'daemon';
    /** Durable/portable identity; never replaced with the local routing id. */
    serverIdentityId: string;
    machineId: string;
    /** Device-local routing adaptation for the exact portable target. */
    serverId: string;
}>;

export type ScopedPluginSettingsAccountTarget = Readonly<{
    kind: 'account';
    /** The exact Account server identity selected by the owning UI/runtime. */
    serverIdentityId: string;
}>;

export type ScopedPluginSettingsTarget =
    | ScopedPluginSettingsDaemonTarget
    | ScopedPluginSettingsAccountTarget;

/**
 * Daemon-secret status carries no raw material. Origin-bound declarations
 * retain their exact canonical origin only at this adapter/daemon boundary.
 */
export type ScopedPluginDaemonSecretSnapshot = Readonly<{
    target: ScopedPluginSettingsDaemonTarget;
    pluginId: string;
    secretId: string;
    state: 'configured' | 'missing' | 'denied' | 'unavailable';
    revision: string;
}>;

export type ScopedPluginDaemonSecretReadInput = Readonly<{
    pluginId: string;
    target: ScopedPluginSettingsDaemonTarget;
    secretId: string;
    /** Present only for declarations partitioned by a canonical endpoint origin. */
    canonicalOrigin?: string;
    signal?: AbortSignal;
}>;

export type ScopedPluginDaemonSecretMutation =
    | Readonly<{ kind: 'set'; value: string }>
    | Readonly<{ kind: 'delete' }>;

export type ScopedPluginDaemonSecretWriteInput = ScopedPluginDaemonSecretReadInput & Readonly<{
    expectedRevision: string;
    /** Raw material exists only in a `set` request below this boundary. */
    mutation: ScopedPluginDaemonSecretMutation;
}>;

export type ScopedPluginDaemonSecretReadResult =
    | Readonly<{ status: 'ready'; snapshot: ScopedPluginDaemonSecretSnapshot }>
    | Readonly<{ status: 'unavailable'; reason: 'transport' | 'target-mismatch' }>;

/** A dispatched daemon-secret mutation is never replayed after acknowledgement loss. */
export type ScopedPluginDaemonSecretWriteResult =
    | ScopedPluginDaemonSecretReadResult
    | Readonly<{ status: 'outcomeUnknown'; snapshot?: ScopedPluginDaemonSecretSnapshot }>;

export type ScopedPluginDaemonSecretAdapter = Readonly<{
    read(input: ScopedPluginDaemonSecretReadInput): Promise<ScopedPluginDaemonSecretReadResult>;
    write(input: ScopedPluginDaemonSecretWriteInput): Promise<ScopedPluginDaemonSecretWriteResult>;
}>;

/**
 * Forms an exact Settings record target from identities already selected by
 * their respective owners. Account state remains addressable when the
 * independently selected daemon is offline or absent.
 */
export function resolveScopedPluginSettingsTarget(params: Readonly<{
    scope: ScopedPluginSettingsScope;
    serverIdentityId: string | null | undefined;
    machineId?: string | null;
    serverId?: string | null;
}>): ScopedPluginSettingsTarget | null {
    const serverIdentityId = String(params.serverIdentityId ?? '').trim();
    if (!serverIdentityId) return null;
    if (params.scope.kind === 'account') {
        return { kind: 'account', serverIdentityId };
    }
    const machineId = String(params.machineId ?? '').trim();
    const serverId = String(params.serverId ?? '').trim();
    return machineId && serverId
        ? { kind: 'daemon', serverIdentityId, machineId, serverId }
        : null;
}

export type ScopedPluginSettingsBinding =
    | Readonly<{ kind: 'direct'; settingId: string }>
    | Readonly<{
        kind: 'perActiveServer';
        byServerIdSettingId: string;
        fallbackSettingId: string;
    }>;

export type ScopedPluginSettingsField = Readonly<{
    /** Renderer-local field identity. */
    key: string;
    /** A redacted/password field is never returned in a presentation snapshot. */
    redacted: boolean;
    binding?: ScopedPluginSettingsBinding;
}>;

export type ScopedPluginSettingsRevision =
    | Readonly<{ kind: 'daemon'; value: string }>
    | Readonly<{ kind: 'account'; value: number | 'absent' }>
    /** Account SavedSecret binding revision; it never carries secret material. */
    | Readonly<{ kind: 'account-secret'; value: number }>;

export type ScopedPluginSettingsSecretState = 'configured' | 'missing';

export type ScopedPluginSettingsSnapshot = Readonly<{
    scope: ScopedPluginSettingsScope;
    target: ScopedPluginSettingsTarget;
    revision: ScopedPluginSettingsRevision;
    /** Safe, declaration-filtered values only. */
    values: Readonly<Record<string, unknown>>;
    /** Presence-only projection for Account SavedSecret-backed fields. */
    secretStates?: Readonly<Record<string, ScopedPluginSettingsSecretState>>;
}>;

export type ScopedPluginSettingsReadResult =
    | Readonly<{ status: 'ready'; snapshot: ScopedPluginSettingsSnapshot }>
    | Readonly<{
        status: 'unavailable';
        reason: 'transport' | 'scope-mismatch' | 'target-mismatch' | 'invalid-value';
    }>;

/**
 * A rejected CAS write is deliberately distinct from a successful refresh.
 * Renderers can adopt the safe snapshot, surface conflict recovery, and never
 * report the user's rejected mutation as applied.
 */
export type ScopedPluginSettingsConflictResult = Readonly<{
    status: 'conflict';
    snapshot: ScopedPluginSettingsSnapshot;
}>;

/**
 * The daemon may have received a SET whose acknowledgement was lost. The
 * adapter performs one safe snapshot readback when available, but never
 * attributes that snapshot to the user's mutation or replays it.
 */
export type ScopedPluginSettingsOutcomeUnknownResult = Readonly<{
    status: 'outcomeUnknown';
    snapshot?: ScopedPluginSettingsSnapshot;
}>;

export type ScopedPluginSettingsWriteResult =
    | ScopedPluginSettingsReadResult
    | ScopedPluginSettingsConflictResult
    | ScopedPluginSettingsOutcomeUnknownResult;

/**
 * A host-private SavedSecret selection is a one-shot Account-secret intent.
 * Its opaque id may enter the owner only for this mutation and is never part
 * of a Settings snapshot, watch payload, or renderer-owned durable state.
 */
export type ScopedPluginSettingsAccountSecretMutation =
    | Readonly<{ kind: 'bind'; savedSecretId: string }>
    | Readonly<{ kind: 'unbind' }>;

/** A regular Settings record can only carry protocol value mutations. */
export type ScopedPluginSettingsRecordMutation = DaemonPluginSettingsMutation;

/**
 * A delete is explicit: an empty string remains valid data when the field's
 * declaration says to persist it. Bind/unbind are accepted only by the
 * Account SavedSecret adapter; ordinary Account and daemon record owners
 * reject them rather than treating a secret intent as a record value.
 */
export type ScopedPluginSettingsMutation =
    | ScopedPluginSettingsRecordMutation
    | ScopedPluginSettingsAccountSecretMutation;

export type ScopedPluginSettingsAccountReadInput = Readonly<{
    pluginId: string;
    target: ScopedPluginSettingsAccountTarget;
    fields: readonly ScopedPluginSettingsField[];
}>;

export type ScopedPluginSettingsAccountWriteInput = ScopedPluginSettingsAccountReadInput & Readonly<{
    fieldId: string;
    mutation: ScopedPluginSettingsMutation;
    expectedRevision: Extract<ScopedPluginSettingsRevision, { kind: 'account' }>;
}>;

/**
 * The Account route owns an opaque `(accountId, pluginId)` record. Its
 * boundary adapter may handle envelope crypto and HTTP, but it never decides
 * which display field is writable or which values are safe for a renderer.
 */
export type ScopedPluginSettingsAccountRecordRead =
    | Readonly<{
        status: 'present';
        revision: number;
        /** Opaque record contents; never surfaced directly to a renderer. */
        values: Readonly<Record<string, unknown>>;
    }>
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'deleted'; revision: number }>
    | Readonly<{ status: 'unavailable' }>;

export type ScopedPluginSettingsAccountRecordWriteResult =
    | Readonly<{ status: 'updated'; revision: number }>
    | Readonly<{ status: 'conflict'; revision: number }>
    /** The write may have reached the Account record owner without a durable result. */
    | Readonly<{ status: 'outcomeUnknown' }>
    | Readonly<{ status: 'unavailable' }>;

export type ScopedPluginSettingsAccountRecordBoundary = Readonly<{
    readRecord(input: Readonly<{
        pluginId: string;
        target: ScopedPluginSettingsAccountTarget;
    }>): Promise<ScopedPluginSettingsAccountRecordRead>;
    writeRecord(input: Readonly<{
        pluginId: string;
        target: ScopedPluginSettingsAccountTarget;
        expectedRevision: number | 'absent';
        /** Complete opaque record: unknown entries are retained by this owner. */
        values: Readonly<Record<string, unknown>>;
    }>): Promise<ScopedPluginSettingsAccountRecordWriteResult>;
}>;

export type ScopedPluginSettingsAccountTransport = Readonly<{
    read(input: ScopedPluginSettingsAccountReadInput): Promise<ScopedPluginSettingsReadResult>;
    write(input: ScopedPluginSettingsAccountWriteInput): Promise<ScopedPluginSettingsWriteResult>;
}>;

export type ScopedPluginSettingsAdapterDependencies = Readonly<{
    daemonGet: (
        machineId: string,
        params: Readonly<{ serverId: string; serverIdentityId: string; pluginId: string }>,
    ) => Promise<MachinePluginSettingsResult>;
    daemonSet: (
        machineId: string,
        params: Readonly<{
            serverId: string;
            serverIdentityId: string;
            pluginId: string;
            fieldId: string;
            mutation: ScopedPluginSettingsRecordMutation;
            expectedRevision?: string;
        }>,
    ) => Promise<MachinePluginSettingsSetResult>;
    accountRead: (input: ScopedPluginSettingsAccountReadInput) => Promise<ScopedPluginSettingsReadResult>;
    accountWrite: (input: ScopedPluginSettingsAccountWriteInput) => Promise<ScopedPluginSettingsWriteResult>;
    /** Optional only for adapter test seams that do not exercise daemon custody. */
    daemonSecretStatus?: (
        machineId: string,
        params: Readonly<{
            serverId: string;
            serverIdentityId: string;
            pluginId: string;
            secretId: string;
            canonicalOrigin?: string;
            signal?: AbortSignal;
        }>,
    ) => Promise<MachinePluginSecretStatusResult>;
    daemonSecretSet?: (
        machineId: string,
        params: Readonly<{
            serverId: string;
            serverIdentityId: string;
            pluginId: string;
            secretId: string;
            canonicalOrigin?: string;
            expectedRevision?: string;
            value: string;
            signal?: AbortSignal;
        }>,
    ) => Promise<MachinePluginSecretSetResult>;
    daemonSecretDelete?: (
        machineId: string,
        params: Readonly<{
            serverId: string;
            serverIdentityId: string;
            pluginId: string;
            secretId: string;
            canonicalOrigin?: string;
            expectedRevision?: string;
            signal?: AbortSignal;
        }>,
    ) => Promise<MachinePluginSecretDeleteResult>;
}>;

export type ScopedPluginSettingsReadInput = Readonly<{
    pluginId: string;
    scope: ScopedPluginSettingsScope;
    target: ScopedPluginSettingsTarget;
    fields: readonly ScopedPluginSettingsField[];
}>;

export type ScopedPluginSettingsWriteInput = ScopedPluginSettingsReadInput & Readonly<{
    fieldId: string;
    mutation: ScopedPluginSettingsMutation;
    expectedRevision: ScopedPluginSettingsRevision;
}>;

/**
 * A content-free invalidation for one already-selected Settings record. The
 * adapter remains the only reader: a watch can wake the record owner, never
 * carry values, revisions, or a second mutation path into a renderer.
 */
export type ScopedPluginSettingsWatchInput = Readonly<{
    pluginId: string;
    scope: ScopedPluginSettingsScope;
    target: ScopedPluginSettingsTarget;
    onInvalidated(): void;
}>;

export type ScopedPluginSettingsWatch = Readonly<{
    dispose(): void;
}>;

export type ScopedPluginSettingsAdapter = Readonly<{
    read(input: ScopedPluginSettingsReadInput): Promise<ScopedPluginSettingsReadResult>;
    write(input: ScopedPluginSettingsWriteInput): Promise<ScopedPluginSettingsWriteResult>;
    /**
     * The existing scoped Settings adapter is also the sole host boundary for
     * declaration-routed daemon secrets. It has no Settings-record fallback.
     */
    daemonSecret?: ScopedPluginDaemonSecretAdapter;
    /**
     * Optional while a narrow boundary has no genuine external change feed.
     * The shared record owner still has one read/write path in that case.
     */
    watch?(input: ScopedPluginSettingsWatchInput): ScopedPluginSettingsWatch;
}>;

function fieldStorageIds(field: ScopedPluginSettingsField): readonly string[] {
    if (field.binding?.kind === 'direct') return [field.binding.settingId];
    if (field.binding?.kind === 'perActiveServer') {
        return [field.binding.byServerIdSettingId, field.binding.fallbackSettingId];
    }
    return [field.key];
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function hasExactTargetIdentity(target: ScopedPluginSettingsTarget): boolean {
    if (!target.serverIdentityId.trim()) return false;
    if (target.kind === 'account') return true;
    return Boolean(target.machineId.trim() && target.serverId.trim());
}

function accountRecordExpectedRevision(
    record: ScopedPluginSettingsAccountRecordRead,
): number | 'absent' | null {
    if (record.status === 'absent') return 'absent';
    if (record.status === 'present' || record.status === 'deleted') return record.revision;
    return null;
}

function accountRecordValues(record: ScopedPluginSettingsAccountRecordRead): Readonly<Record<string, unknown>> {
    return record.status === 'present' ? record.values : {};
}

function accountRecordToScopedResult(params: Readonly<{
    record: ScopedPluginSettingsAccountRecordRead;
    input: ScopedPluginSettingsAccountReadInput;
}>): ScopedPluginSettingsReadResult {
    const expectedRevision = accountRecordExpectedRevision(params.record);
    if (expectedRevision === null) return { status: 'unavailable', reason: 'transport' };
    const values = accountRecordValues(params.record);
    if (!haveBoundedPerActiveServerValues(values, params.input.fields)) {
        return { status: 'unavailable', reason: 'invalid-value' };
    }
    return {
        status: 'ready',
        snapshot: {
            scope: { kind: 'account' },
            target: params.input.target,
            revision: { kind: 'account', value: expectedRevision },
            values: projectSafeScopedPluginSettingsValues({
                values,
                fields: params.input.fields,
            }),
        },
    };
}

function accountRecordToConflictResult(params: Readonly<{
    record: ScopedPluginSettingsAccountRecordRead;
    input: ScopedPluginSettingsAccountReadInput;
}>): ScopedPluginSettingsWriteResult {
    const result = accountRecordToScopedResult(params);
    return result.status === 'ready'
        ? { status: 'conflict', snapshot: result.snapshot }
        : result;
}

function isWritableAccountField(
    fieldId: string,
    fields: readonly ScopedPluginSettingsField[],
): boolean {
    return fields.some((field) => !field.redacted && fieldStorageIds(field).includes(fieldId));
}

/**
 * The Protocol declaration owns this binding's limits. The Account transport
 * applies that same invariant at its opaque-record boundary, rather than
 * letting a renderer project or CAS an unbounded map around the Settings
 * owner. Unknown record keys deliberately remain opaque here.
 */
function haveBoundedPerActiveServerValues(
    values: Readonly<Record<string, unknown>>,
    fields: readonly ScopedPluginSettingsField[],
): boolean {
    return fields.every((field) => {
        const binding = field.binding;
        if (binding?.kind !== 'perActiveServer') return true;
        const value = values[binding.byServerIdSettingId];
        return value === undefined || isBoundedPluginPerActiveServerValueV1(value);
    });
}

/**
 * A presentation snapshot permits only the declared, non-redacted storage ids.
 * This keeps undeclared values and password values out of renderer state even
 * when an older native record still contains them.
 */
export function projectSafeScopedPluginSettingsValues(params: Readonly<{
    values: Readonly<Record<string, unknown>>;
    fields: readonly ScopedPluginSettingsField[];
    redactedKeys?: readonly string[];
}>): Readonly<Record<string, unknown>> {
    const declared = new Set<string>();
    const redacted = new Set(params.redactedKeys ?? []);
    for (const field of params.fields) {
        const storageIds = fieldStorageIds(field);
        if (field.redacted) {
            for (const id of storageIds) redacted.add(id);
            continue;
        }
        for (const id of storageIds) declared.add(id);
    }
    const projected: Record<string, unknown> = {};
    for (const id of declared) {
        if (redacted.has(id) || !Object.prototype.hasOwnProperty.call(params.values, id)) continue;
        projected[id] = params.values[id];
    }
    return projected;
}

/**
 * Account Settings are one opaque, CAS-protected record. This transport owns
 * the required read-before-write merge so renderer snapshots can remain
 * declaration-filtered while unknown and secret record entries survive a
 * non-secret field update. A conflict is refreshed once and is never replayed.
 */
export function createAccountScopedPluginSettingsTransport(
    boundary: ScopedPluginSettingsAccountRecordBoundary,
): ScopedPluginSettingsAccountTransport {
    async function read(input: ScopedPluginSettingsAccountReadInput): Promise<ScopedPluginSettingsReadResult> {
        try {
            const record = await boundary.readRecord({
                pluginId: input.pluginId,
                target: input.target,
            });
            return accountRecordToScopedResult({ record, input });
        } catch {
            return { status: 'unavailable', reason: 'transport' };
        }
    }

    return Object.freeze({
        read,
        async write(input): Promise<ScopedPluginSettingsWriteResult> {
            if (input.mutation.kind !== 'set' && input.mutation.kind !== 'delete') {
                return { status: 'unavailable', reason: 'scope-mismatch' };
            }
            if (!isWritableAccountField(input.fieldId, input.fields)) {
                return { status: 'unavailable', reason: 'scope-mismatch' };
            }
            try {
                const current = await boundary.readRecord({
                    pluginId: input.pluginId,
                    target: input.target,
                });
                const expectedRevision = accountRecordExpectedRevision(current);
                if (expectedRevision === null) return { status: 'unavailable', reason: 'transport' };
                if (input.expectedRevision.value !== expectedRevision) {
                    return accountRecordToConflictResult({ record: current, input });
                }
                const values = { ...accountRecordValues(current) };
                if (!haveBoundedPerActiveServerValues(values, input.fields)) {
                    return { status: 'unavailable', reason: 'invalid-value' };
                }
                if (input.mutation.kind === 'delete') {
                    delete values[input.fieldId];
                } else {
                    values[input.fieldId] = input.mutation.value;
                }
                if (!haveBoundedPerActiveServerValues(values, input.fields)) {
                    return { status: 'unavailable', reason: 'invalid-value' };
                }
                const result = await boundary.writeRecord({
                    pluginId: input.pluginId,
                    target: input.target,
                    expectedRevision,
                    values,
                });
                if (result.status === 'updated') {
                    return {
                        status: 'ready',
                        snapshot: {
                            scope: { kind: 'account' },
                            target: input.target,
                            revision: { kind: 'account', value: result.revision },
                            values: projectSafeScopedPluginSettingsValues({ values, fields: input.fields }),
                        },
                    };
                }
                if (result.status === 'conflict') {
                    // A conflict refreshes the authoritative record exactly once;
                    // the user's mutation is never replayed against new content.
                    const refreshed = await read(input);
                    return refreshed.status === 'ready'
                        ? { status: 'conflict', snapshot: refreshed.snapshot }
                        : refreshed;
                }
                if (result.status === 'outcomeUnknown') {
                    // The transport owner established possible dispatch. It
                    // gets one canonical readback, never a CAS replay.
                    const refreshed = await read(input);
                    return refreshed.status === 'ready'
                        ? { status: 'outcomeUnknown', snapshot: refreshed.snapshot }
                        : { status: 'outcomeUnknown' };
                }
                return { status: 'unavailable', reason: 'transport' };
            } catch {
                return { status: 'unavailable', reason: 'transport' };
            }
        },
    });
}

/** Resolve a renderer field through the declaration's canonical binding. */
export function readScopedPluginSettingValue(params: Readonly<{
    values: Readonly<Record<string, unknown>>;
    field: ScopedPluginSettingsField;
    /** The explicit canonical profile identity, never a device-local profile id. */
    serverIdentityId: string | null;
}>): unknown {
    const binding = params.field.binding;
    if (binding?.kind === 'direct') return params.values[binding.settingId];
    if (binding?.kind === 'perActiveServer') {
        const byServer = readRecord(params.values[binding.byServerIdSettingId]);
        if (params.serverIdentityId && byServer && Object.hasOwn(byServer, params.serverIdentityId)) {
            return byServer[params.serverIdentityId];
        }
        return params.values[binding.fallbackSettingId];
    }
    return params.values[params.field.key];
}

/**
 * Translate one display-field intent into the native record field. The only
 * map update is an explicit `perActiveServer` declaration; no renderer scans
 * or parses an opaque settings record to infer a target.
 */
export function resolveScopedPluginSettingMutation(params: Readonly<{
    values: Readonly<Record<string, unknown>>;
    field: ScopedPluginSettingsField;
    serverIdentityId: string | null;
    value: unknown;
}>): Readonly<{ fieldId: string; value: unknown }> {
    const binding = params.field.binding;
    if (binding?.kind === 'direct') return { fieldId: binding.settingId, value: params.value };
    if (binding?.kind !== 'perActiveServer' || !params.serverIdentityId) {
        return {
            fieldId: binding?.kind === 'perActiveServer'
                ? binding.fallbackSettingId
                : params.field.key,
            value: params.value,
        };
    }
    const current = readRecord(params.values[binding.byServerIdSettingId]);
    const byServer: Record<string, unknown> = current ? { ...current } : {};
    byServer[params.serverIdentityId] = params.value;
    return { fieldId: binding.byServerIdSettingId, value: byServer };
}

function daemonSnapshotToScopedResult(params: Readonly<{
    snapshot: DaemonPluginSettingsSnapshot;
    input: ScopedPluginSettingsReadInput;
}>): ScopedPluginSettingsReadResult {
    if (
        params.input.scope.kind !== 'daemon'
        || params.input.target.kind !== 'daemon'
        || params.snapshot.pluginId !== params.input.pluginId
        || params.snapshot.scope.kind !== 'daemon'
    ) {
        return { status: 'unavailable', reason: 'scope-mismatch' };
    }
    return {
        status: 'ready',
        snapshot: {
            scope: params.input.scope,
            target: params.input.target,
            revision: { kind: 'daemon', value: params.snapshot.revision },
            values: projectSafeScopedPluginSettingsValues({
                values: params.snapshot.values,
                fields: params.input.fields,
                redactedKeys: params.snapshot.redactedKeys,
            }),
        },
    };
}

function daemonResultToScopedResult(params: Readonly<{
    result: MachinePluginSettingsResult;
    input: ScopedPluginSettingsReadInput;
}>): ScopedPluginSettingsReadResult {
    if (!params.result.supported) return { status: 'unavailable', reason: 'transport' };
    return daemonSnapshotToScopedResult({ snapshot: params.result.snapshot, input: params.input });
}

function daemonSetResultToScopedResult(params: Readonly<{
    result: MachinePluginSettingsSetResult;
    input: ScopedPluginSettingsWriteInput;
}>): ScopedPluginSettingsWriteResult {
    if (!params.result.supported) {
        return params.result.reason === 'outcomeUnknown'
            ? { status: 'outcomeUnknown' }
            : { status: 'unavailable', reason: 'transport' };
    }
    const snapshotResult = daemonSnapshotToScopedResult({
        snapshot: params.result.result.snapshot,
        input: params.input,
    });
    if (snapshotResult.status !== 'ready') return snapshotResult;
    return params.result.result.status === 'applied'
        ? snapshotResult
        : { status: 'conflict', snapshot: snapshotResult.snapshot };
}

async function readDaemonScopedPluginSettings(params: Readonly<{
    dependencies: ScopedPluginSettingsAdapterDependencies;
    input: ScopedPluginSettingsReadInput;
    target: ScopedPluginSettingsDaemonTarget;
}>): Promise<ScopedPluginSettingsReadResult> {
    try {
        const result = await params.dependencies.daemonGet(params.target.machineId, {
            serverId: params.target.serverId,
            serverIdentityId: params.target.serverIdentityId,
            pluginId: params.input.pluginId,
        });
        return daemonResultToScopedResult({ result, input: params.input });
    } catch {
        return { status: 'unavailable', reason: 'transport' };
    }
}

function hasExactDaemonSecretTarget(target: ScopedPluginSettingsDaemonTarget): boolean {
    return Boolean(
        target.serverIdentityId.trim()
        && target.machineId.trim()
        && target.serverId.trim(),
    );
}

function daemonSecretRequestTarget(input: ScopedPluginDaemonSecretReadInput): Readonly<{
    serverId: string;
    serverIdentityId: string;
    pluginId: string;
    secretId: string;
    canonicalOrigin?: string;
    signal?: AbortSignal;
}> {
    return {
        serverId: input.target.serverId,
        serverIdentityId: input.target.serverIdentityId,
        pluginId: input.pluginId,
        secretId: input.secretId,
        ...(input.canonicalOrigin === undefined ? {} : { canonicalOrigin: input.canonicalOrigin }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
}

function daemonSecretResultToScopedResult(params: Readonly<{
    result: MachinePluginSecretStatusResult;
    input: ScopedPluginDaemonSecretReadInput;
}>): ScopedPluginDaemonSecretReadResult {
    if (!params.result.supported) return { status: 'unavailable', reason: 'transport' };
    if (
        params.result.result.pluginId !== params.input.pluginId
        || params.result.result.secretId !== params.input.secretId
    ) {
        return { status: 'unavailable', reason: 'transport' };
    }
    return {
        status: 'ready',
        snapshot: {
            target: params.input.target,
            pluginId: params.input.pluginId,
            secretId: params.input.secretId,
            state: params.result.result.state,
            revision: params.result.result.revision,
        },
    };
}

function daemonSecretMutationResultToScopedResult(params: Readonly<{
    result: MachinePluginSecretSetResult | MachinePluginSecretDeleteResult;
    input: ScopedPluginDaemonSecretReadInput;
}>): ScopedPluginDaemonSecretWriteResult {
    if (!params.result.supported) {
        return params.result.reason === 'outcomeUnknown'
            ? { status: 'outcomeUnknown' }
            : { status: 'unavailable', reason: 'transport' };
    }
    return daemonSecretResultToScopedResult({
        result: { supported: true, result: params.result.result },
        input: params.input,
    });
}

async function readDaemonScopedPluginSecret(params: Readonly<{
    dependencies: Required<Pick<
        ScopedPluginSettingsAdapterDependencies,
        'daemonSecretStatus'
    >>;
    input: ScopedPluginDaemonSecretReadInput;
}>): Promise<ScopedPluginDaemonSecretReadResult> {
    if (!hasExactDaemonSecretTarget(params.input.target)) {
        return { status: 'unavailable', reason: 'target-mismatch' };
    }
    try {
        const result = await params.dependencies.daemonSecretStatus(
            params.input.target.machineId,
            daemonSecretRequestTarget(params.input),
        );
        return daemonSecretResultToScopedResult({ result, input: params.input });
    } catch {
        return { status: 'unavailable', reason: 'transport' };
    }
}

function createScopedPluginDaemonSecretAdapter(
    dependencies: Required<Pick<
        ScopedPluginSettingsAdapterDependencies,
        'daemonSecretStatus' | 'daemonSecretSet' | 'daemonSecretDelete'
    >>,
): ScopedPluginDaemonSecretAdapter {
    return Object.freeze({
        read(input): Promise<ScopedPluginDaemonSecretReadResult> {
            return readDaemonScopedPluginSecret({ dependencies, input });
        },
        async write(input): Promise<ScopedPluginDaemonSecretWriteResult> {
            if (!hasExactDaemonSecretTarget(input.target)) {
                return { status: 'unavailable', reason: 'target-mismatch' };
            }
            try {
                const request = {
                    ...daemonSecretRequestTarget(input),
                    expectedRevision: input.expectedRevision,
                };
                const result = input.mutation.kind === 'set'
                    ? await dependencies.daemonSecretSet(input.target.machineId, {
                        ...request,
                        value: input.mutation.value,
                    })
                    : await dependencies.daemonSecretDelete(input.target.machineId, request);
                const settled = daemonSecretMutationResultToScopedResult({ result, input });
                if (settled.status !== 'outcomeUnknown') return settled;
                // One safe status readback can refresh presentation, but never
                // proves authorship of the postcondition or authorizes replay.
                const readback = await readDaemonScopedPluginSecret({ dependencies, input });
                return readback.status === 'ready'
                    ? { status: 'outcomeUnknown', snapshot: readback.snapshot }
                    : settled;
            } catch {
                return { status: 'unavailable', reason: 'transport' };
            }
        },
    });
}

/**
 * Builds the one adapter used by host Settings presentation. The production
 * account route is injected by the owning authenticated Account transport;
 * tests inject only genuine transport boundaries, never internal binding logic.
 */
export function createScopedPluginSettingsAdapter(
    dependencies: ScopedPluginSettingsAdapterDependencies,
): ScopedPluginSettingsAdapter {
    const daemonSecret = (
        dependencies.daemonSecretStatus
        && dependencies.daemonSecretSet
        && dependencies.daemonSecretDelete
    )
        ? createScopedPluginDaemonSecretAdapter({
            daemonSecretStatus: dependencies.daemonSecretStatus,
            daemonSecretSet: dependencies.daemonSecretSet,
            daemonSecretDelete: dependencies.daemonSecretDelete,
        })
        : undefined;
    return {
        ...(daemonSecret ? { daemonSecret } : {}),
        async read(input) {
            if (!hasExactTargetIdentity(input.target)) {
                return { status: 'unavailable', reason: 'target-mismatch' };
            }
            if (input.scope.kind === 'account') {
                if (input.target.kind !== 'account') {
                    return { status: 'unavailable', reason: 'target-mismatch' };
                }
                return await dependencies.accountRead({
                    pluginId: input.pluginId,
                    target: input.target,
                    fields: input.fields,
                });
            }
            if (input.target.kind !== 'daemon') {
                return { status: 'unavailable', reason: 'target-mismatch' };
            }
            return await readDaemonScopedPluginSettings({
                dependencies,
                input,
                target: input.target,
            });
        },
        async write(input) {
            if (!hasExactTargetIdentity(input.target)) {
                return { status: 'unavailable', reason: 'target-mismatch' };
            }
            if (input.mutation.kind !== 'set' && input.mutation.kind !== 'delete') {
                return { status: 'unavailable', reason: 'scope-mismatch' };
            }
            if (input.scope.kind === 'account') {
                if (input.target.kind !== 'account' || input.expectedRevision.kind !== 'account') {
                    return { status: 'unavailable', reason: 'target-mismatch' };
                }
                return await dependencies.accountWrite({
                    pluginId: input.pluginId,
                    target: input.target,
                    fields: input.fields,
                    fieldId: input.fieldId,
                    mutation: input.mutation,
                    expectedRevision: input.expectedRevision,
                });
            }
            if (input.target.kind !== 'daemon' || input.expectedRevision.kind !== 'daemon') {
                return { status: 'unavailable', reason: 'target-mismatch' };
            }
            try {
                const result = await dependencies.daemonSet(input.target.machineId, {
                    serverId: input.target.serverId,
                    serverIdentityId: input.target.serverIdentityId,
                    pluginId: input.pluginId,
                    fieldId: input.fieldId,
                    mutation: input.mutation,
                    expectedRevision: input.expectedRevision.value,
                });
                const settled = daemonSetResultToScopedResult({ result, input });
                if (settled.status !== 'outcomeUnknown') return settled;
                // One adapter-owned safe readback updates presentation with
                // current declared values. Its snapshot cannot prove which
                // writer produced the postcondition, so the mutation remains
                // outcomeUnknown and is never replayed.
                const readback = await readDaemonScopedPluginSettings({
                    dependencies,
                    input,
                    target: input.target,
                });
                return readback.status === 'ready'
                    ? { status: 'outcomeUnknown', snapshot: readback.snapshot }
                    : settled;
            } catch {
                return { status: 'unavailable', reason: 'transport' };
            }
        },
    };
}
