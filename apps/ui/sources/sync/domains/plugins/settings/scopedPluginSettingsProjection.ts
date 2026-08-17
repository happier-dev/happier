import * as React from 'react';
import { DaemonPluginSettingsMutationSchema } from '@happier-dev/protocol';

import type { PluginProjectionEditableSettingField } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import {
    projectSafeScopedPluginSettingsValues,
    readScopedPluginSettingValue,
    resolveScopedPluginSettingMutation,
    type ScopedPluginSettingsAdapter,
    type ScopedPluginSettingsField,
    type ScopedPluginSettingsMutation,
    type ScopedPluginSettingsRevision,
    type ScopedPluginSettingsScope,
    type ScopedPluginSettingsSnapshot,
    type ScopedPluginSettingsTarget,
    type ScopedPluginSettingsWriteResult,
} from './scopedPluginSettingsAdapter';

type Drafts = Readonly<Record<string, unknown>>;

type FieldModelDraft = Readonly<{
    /** The exact target/lifetime and declaration whose draft this belongs to. */
    context: string;
    declarationIdentity: string;
    value: unknown;
    version: number;
    /**
     * A source replacement can leave a former draft visible without allowing
     * that old write intent to be replayed against the replacement source.
     */
    committable: boolean;
}>;

type FieldModelDrafts = Readonly<Record<string, FieldModelDraft>>;

type FieldModelError = Readonly<{
    context: string;
    declarationIdentity: string;
    /** A later keystroke must not inherit an older operation's failure. */
    draftVersion: number;
    status: 'failed' | 'outcomeUnknown';
}>;

type FieldModelErrors = Readonly<Record<string, FieldModelError>>;

export type ScopedPluginSettingsProjectionState = Readonly<{
    /** Identifies one exact record and the subscriber's current field inventory. */
    scopeKey: string;
    values: Readonly<Record<string, unknown>>;
    secretStates: Readonly<Record<string, 'configured' | 'missing'>>;
    /** Renderer-local values; redacted fields never receive persisted values. */
    drafts: Drafts;
    revision: ScopedPluginSettingsRevision | null;
    ready: boolean;
    settled: boolean;
    loading: boolean;
    /** At least one mutation is active for this exact record. */
    writePending: boolean;
    error: 'unavailable' | 'failed' | 'outcomeUnknown' | null;
}>;

const EMPTY_VALUES: Readonly<Record<string, unknown>> = Object.freeze({});
const EMPTY_SECRET_STATES: Readonly<Record<string, 'configured' | 'missing'>> = Object.freeze({});
const EMPTY_DRAFTS: Drafts = Object.freeze({});
const EMPTY_DECLARED_FIELDS: readonly PluginProjectionEditableSettingField[] = Object.freeze([]);

const EMPTY_SCOPED_PLUGIN_SETTINGS_PROJECTION_STATE: ScopedPluginSettingsProjectionState = Object.freeze({
    scopeKey: 'unavailable',
    values: EMPTY_VALUES,
    secretStates: EMPTY_SECRET_STATES,
    drafts: EMPTY_DRAFTS,
    revision: null,
    ready: false,
    settled: false,
    loading: false,
    writePending: false,
    error: null,
});

export type ScopedPluginSettingsWriteCurrentness = () => boolean;

/**
 * One renderer-facing ordinary Settings field. The scoped projection owns the
 * declaration binding, normalized draft, parsing, save lifetime, and CAS
 * dispatch below this model; renderers retain only presentation concerns.
 */
export type ScopedPluginSettingsFieldModel = Readonly<{
    field: PluginProjectionEditableSettingField;
    /** The declaration-bound safe value, including its declared default. */
    value: unknown;
    /** The control value currently being edited (text is always a string). */
    draft: unknown;
    dirty: boolean;
    /** One exact record write is active, including one started by a sibling control. */
    pending: boolean;
    /** The current draft was rejected, malformed, or has an ambiguous outcome. */
    error: 'failed' | 'outcomeUnknown' | null;
    setDraft(value: unknown): void;
    /**
     * Omitting `draft` submits the current model draft. Immediate controls can
     * provide their next value to avoid a render-timing dependency.
     */
    commit(input?: Readonly<{
        draft?: unknown;
        isCurrent?: ScopedPluginSettingsWriteCurrentness;
    }>): Promise<ScopedPluginSettingsWriteResult | null>;
}>;

export type ScopedPluginSettingsProjection = Readonly<{
    state: ScopedPluginSettingsProjectionState;
    /**
     * Optional declaration-backed ordinary controls. Existing low-level
     * consumers retain `state`/`commit`; Settings form renderers consume this
     * model instead of rebuilding field state over the record owner.
     */
    fieldModels: readonly ScopedPluginSettingsFieldModel[];
    setDraft(fieldId: string, value: unknown): void;
    /**
     * The record projection is the sole reader/writer for its scoped adapter.
     * A caller may contribute a target-owner freshness assertion, but cannot
     * bypass shared revision, conflict, or recovery handling.
     */
    commit(input: Readonly<{
        /** Canonical storage field id emitted by the declaration binding. */
        fieldId: string;
        mutation: ScopedPluginSettingsMutation;
        /** Renderer field whose local draft should clear on this success. */
        draftFieldId?: string;
        isCurrent?: ScopedPluginSettingsWriteCurrentness;
    }>): Promise<ScopedPluginSettingsWriteResult | null>;
    refresh(): Promise<void>;
}>;

export type UseScopedPluginSettingsProjectionParams = Readonly<{
    pluginId: string;
    scope: ScopedPluginSettingsScope;
    target: ScopedPluginSettingsTarget | null;
    /**
     * Every Settings projection—including an exact daemon record—belongs to
     * this captured Account lifetime. A daemon target remains its own storage
     * authority; the lifetime fences UI-held LKG, reads, and watches while the
     * user changes Accounts on the same server.
     */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    fields: readonly ScopedPluginSettingsField[];
    /**
     * Renderer declarations for ordinary (non-SavedSecret) controls. These
     * remain UI-domain declarations, while their binding and form state are
     * normalized by this canonical scoped Settings projection.
     */
    declaredFields?: readonly PluginProjectionEditableSettingField[];
    /**
     * Opaque declaration/source lifetime for this mounted consumer. A change
     * replaces the authority that supplied the same record fields, so the
     * shared record must reread and fence an in-flight older mutation.
     */
    sourceLifetimeIdentity?: string;
    /**
     * Explicit portable Server binding supplied by Administration/UI. It is
     * independent of the Account record target, which remains active-only.
     */
    perActiveServerIdentityId: string | null;
    enabled: boolean;
    adapter: ScopedPluginSettingsAdapter;
}>;

export type CommitScopedPluginSettingsFieldInput = Readonly<{
    pluginId: string;
    scope: ScopedPluginSettingsScope;
    target: ScopedPluginSettingsTarget;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    fields: readonly ScopedPluginSettingsField[];
    adapter: ScopedPluginSettingsAdapter;
    fieldId: string;
    mutation: ScopedPluginSettingsMutation;
    isCurrent?: ScopedPluginSettingsWriteCurrentness;
}>;

type SharedRecordState = Readonly<{
    snapshot: ScopedPluginSettingsSnapshot | null;
    settled: boolean;
    loading: boolean;
    writePending: boolean;
    error: 'unavailable' | 'failed' | 'outcomeUnknown' | null;
}>;

type StoreSubscriber = Readonly<{
    fields: readonly ScopedPluginSettingsField[];
    enabled: boolean;
    /** Opaque declaration/source lifetime supplied by this record consumer. */
    sourceLifetimeIdentity: string | null;
    listener: () => void;
}>;

type ScopedPluginSettingsRecordStore = Readonly<{
    subscribe(input: StoreSubscriber): Readonly<{ id: number; unsubscribe(): void }>;
    update(id: number, input: StoreSubscriber): void;
    state(): SharedRecordState;
    commit(input: Readonly<{
        fieldId: string;
        mutation: ScopedPluginSettingsMutation;
        isCurrent?: ScopedPluginSettingsWriteCurrentness;
    }>): Promise<ScopedPluginSettingsWriteResult | null>;
    refresh(): Promise<void>;
}>;

type ScopedPluginSettingsStoreCache = {
    /** No Settings record can cross the captured active Account lifetime. */
    storesByLifetime: WeakMap<
        ActiveServerAccountScopeLifetime,
        Map<string, ScopedPluginSettingsRecordStore>
    >;
};

const storesByAdapter = new WeakMap<ScopedPluginSettingsAdapter, ScopedPluginSettingsStoreCache>();

let nextAccountLifetimeIdentity = 0;
const accountLifetimeIdentities = new WeakMap<ActiveServerAccountScopeLifetime, number>();

function accountLifetimeIdentity(lifetime: ActiveServerAccountScopeLifetime | null): string {
    if (!lifetime) return 'unavailable';
    let identity = accountLifetimeIdentities.get(lifetime);
    if (identity === undefined) {
        identity = nextAccountLifetimeIdentity + 1;
        nextAccountLifetimeIdentity = identity;
        accountLifetimeIdentities.set(lifetime, identity);
    }
    return `account:${identity}`;
}

function isCurrentAccountLifetime(lifetime: ActiveServerAccountScopeLifetime | null): boolean {
    if (!lifetime) return false;
    try {
        return lifetime.isCurrent();
    } catch {
        return false;
    }
}

function scopedTargetKey(target: ScopedPluginSettingsTarget | null): string {
    if (!target) return 'unavailable';
    return target.kind === 'account'
        ? `account:${target.serverIdentityId}`
        : `daemon:${target.serverIdentityId}:${target.machineId}:${target.serverId}`;
}

function fieldIdentity(field: ScopedPluginSettingsField): string {
    const binding = field.binding;
    return binding?.kind === 'direct'
        ? JSON.stringify([field.key, field.redacted, 'direct', binding.settingId])
        : binding?.kind === 'perActiveServer'
            ? JSON.stringify([
                field.key,
                field.redacted,
                'perActiveServer',
                binding.byServerIdSettingId,
                binding.fallbackSettingId,
            ])
            : JSON.stringify([field.key, field.redacted, null]);
}

/** The one declaration-to-storage projection used by host Settings controls. */
export function projectScopedPluginSettingsField(
    field: PluginProjectionEditableSettingField,
): ScopedPluginSettingsField {
    const binding = field.presentation?.binding;
    const redacted = field.control === 'password' || (field.redaction ?? 'none') !== 'none';
    if (binding?.kind === 'direct' && binding.settingId) {
        return {
            key: field.key,
            redacted,
            binding: { kind: 'direct', settingId: binding.settingId },
        };
    }
    if (binding?.kind === 'perActiveServer') {
        return {
            key: field.key,
            redacted,
            binding: {
                kind: 'perActiveServer',
                byServerIdSettingId: binding.byServerIdSettingId,
                fallbackSettingId: binding.fallbackSettingId,
            },
        };
    }
    return { key: field.key, redacted };
}

export function projectScopedPluginSettingsFields(
    fields: readonly PluginProjectionEditableSettingField[],
): readonly ScopedPluginSettingsField[] {
    return fields.map(projectScopedPluginSettingsField);
}

/**
 * Field identity fences a renderer draft from a declaration replacement. It
 * intentionally contains no setting value, target, or raw secret bytes.
 */
export function scopedPluginSettingsFieldDeclarationIdentity(
    field: PluginProjectionEditableSettingField,
): string {
    return JSON.stringify([
        field.key,
        field.valueType,
        field.clearWhenEmpty,
        field.secretCustody,
        field.managedServiceOrigin,
        field.control,
        field.defaultBooleanValue,
        field.defaultValue,
        projectScopedPluginSettingsField(field),
        field.valueSchema,
    ]);
}

function settingSchemaAcceptsNull(
    schema: PluginProjectionEditableSettingField['valueSchema'],
): boolean {
    if (schema.type === 'null') return true;
    return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].some(settingSchemaAcceptsNull);
}

function readDeclaredFieldValue(params: Readonly<{
    values: Readonly<Record<string, unknown>>;
    field: PluginProjectionEditableSettingField;
    serverIdentityId: string | null;
}>): unknown {
    const value = readScopedPluginSettingValue({
        values: params.values,
        field: projectScopedPluginSettingsField(params.field),
        serverIdentityId: params.serverIdentityId,
    });
    if (value !== undefined) return value;
    if (params.field.control === 'switch') return params.field.defaultBooleanValue === true;
    return params.field.defaultValue;
}

function formatDeclaredFieldDraft(
    field: PluginProjectionEditableSettingField,
    value: unknown,
): unknown {
    if (field.control === 'switch') return value === true;
    if (field.control === 'select' || field.control === 'multiSelect') return value;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (value === undefined) return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '';
    }
}

function parseDeclaredFieldDraft(
    field: PluginProjectionEditableSettingField,
    draft: unknown,
): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
    if (field.control === 'switch') {
        return typeof draft === 'boolean' ? { ok: true, value: draft } : { ok: false };
    }
    if (field.control === 'select' || field.control === 'multiSelect') {
        return { ok: true, value: draft };
    }
    if (typeof draft !== 'string') return { ok: false };
    if (field.control === 'number' || field.valueType === 'number' || field.valueType === 'integer') {
        if (draft.trim() === '' && settingSchemaAcceptsNull(field.valueSchema)) {
            return { ok: true, value: null };
        }
        const value = Number(draft);
        if (!Number.isFinite(value) || (field.valueType === 'integer' && !Number.isInteger(value))) {
            return { ok: false };
        }
        return { ok: true, value };
    }
    if (field.control === 'json' || ['object', 'array', 'null'].includes(field.valueType)) {
        try {
            return { ok: true, value: JSON.parse(draft) };
        } catch {
            return { ok: false };
        }
    }
    return { ok: true, value: draft };
}

export function createScopedPluginSettingsSetMutation(
    value: unknown,
): Extract<ScopedPluginSettingsMutation, Readonly<{ kind: 'set' }>> | null {
    const parsed = DaemonPluginSettingsMutationSchema.safeParse({ kind: 'set', value });
    return parsed.success && parsed.data.kind === 'set' ? parsed.data : null;
}

/** Read one declared field through its canonical storage binding. */
export function readScopedPluginSettingsDeclaredFieldValue(params: Readonly<{
    values: Readonly<Record<string, unknown>>;
    field: PluginProjectionEditableSettingField;
    serverIdentityId: string | null;
}>): unknown {
    return readDeclaredFieldValue(params);
}

/** Resolve a declared display-field intent to the one canonical storage mutation. */
export function resolveScopedPluginSettingsDeclaredFieldMutation(params: Readonly<{
    values: Readonly<Record<string, unknown>>;
    field: PluginProjectionEditableSettingField;
    serverIdentityId: string | null;
    value: unknown;
}>): Readonly<{ fieldId: string; value: unknown }> {
    return resolveScopedPluginSettingMutation({
        values: params.values,
        field: projectScopedPluginSettingsField(params.field),
        serverIdentityId: params.serverIdentityId,
        value: params.value,
    });
}

/**
 * Inventory identity is set-like: root replacement may rebuild arrays and
 * move siblings without invalidating a surviving field's editable draft.
 */
export function scopedPluginSettingsFieldsKey(fields: readonly ScopedPluginSettingsField[]): string {
    return JSON.stringify(fields.map(fieldIdentity).sort());
}

function sameValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
    }
    if (
        left === null
        || right === null
        || typeof left !== 'object'
        || typeof right !== 'object'
        || Array.isArray(left)
        || Array.isArray(right)
    ) {
        return false;
    }
    const leftRecord = left as Readonly<Record<string, unknown>>;
    const rightRecord = right as Readonly<Record<string, unknown>>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index]
            && Object.prototype.hasOwnProperty.call(rightRecord, key)
            && sameValue(leftRecord[key], rightRecord[key]));
}

function fieldDraftValue(
    values: Readonly<Record<string, unknown>>,
    field: ScopedPluginSettingsField,
): unknown {
    // The adapter has already filtered unsafe values. Redacted/SavedSecret
    // fields intentionally have no persisted draft material.
    return field.redacted ? undefined : values[field.key];
}

function fieldCanMutateStorageField(field: ScopedPluginSettingsField, fieldId: string): boolean {
    const binding = field.binding;
    if (!binding) return field.key === fieldId;
    if (binding.kind === 'direct') return binding.settingId === fieldId;
    return binding.byServerIdSettingId === fieldId || binding.fallbackSettingId === fieldId;
}

function unionSubscriberFields(subscribers: ReadonlyMap<number, StoreSubscriber>): readonly ScopedPluginSettingsField[] {
    const byIdentity = new Map<string, ScopedPluginSettingsField>();
    for (const subscriber of subscribers.values()) {
        if (!subscriber.enabled) continue;
        for (const field of subscriber.fields) byIdentity.set(fieldIdentity(field), field);
    }
    return [...byIdentity.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, field]) => field);
}

function projectSnapshotForFields(
    snapshot: ScopedPluginSettingsSnapshot,
    fields: readonly ScopedPluginSettingsField[],
): Readonly<{
    values: Readonly<Record<string, unknown>>;
    secretStates: Readonly<Record<string, 'configured' | 'missing'>>;
}> {
    const secretStates: Record<string, 'configured' | 'missing'> = {};
    for (const field of fields) {
        const state = snapshot.secretStates?.[field.key];
        if (field.redacted && state) secretStates[field.key] = state;
    }
    return {
        values: projectSafeScopedPluginSettingsValues({ values: snapshot.values, fields }),
        secretStates,
    };
}

/**
 * A write response is authoritative for the storage field it mutated, but
 * may contain a full snapshot captured before a later refresh or sibling
 * mutation. Keep the shared record's newer sibling values intact.
 */
function applyWriteSnapshotField(params: Readonly<{
    current: ScopedPluginSettingsSnapshot | null;
    result: ScopedPluginSettingsSnapshot;
    fieldId: string;
}>): ScopedPluginSettingsSnapshot {
    if (!params.current) return params.result;
    const values = { ...params.current.values };
    if (Object.hasOwn(params.result.values, params.fieldId)) {
        values[params.fieldId] = params.result.values[params.fieldId];
    } else {
        delete values[params.fieldId];
    }
    const secretStates: Record<string, 'configured' | 'missing'> = {
        ...(params.current.secretStates ?? {}),
    };
    if (params.result.secretStates && Object.hasOwn(params.result.secretStates, params.fieldId)) {
        secretStates[params.fieldId] = params.result.secretStates[params.fieldId]!;
    } else {
        delete secretStates[params.fieldId];
    }
    return {
        ...params.result,
        values,
        ...(Object.keys(secretStates).length > 0 ? { secretStates } : {}),
    };
}

function isWriteCurrent(isCurrent: ScopedPluginSettingsWriteCurrentness | undefined): boolean {
    if (!isCurrent) return true;
    try {
        return isCurrent();
    } catch {
        return false;
    }
}

function createScopedPluginSettingsRecordStore(params: Readonly<{
    pluginId: string;
    scope: ScopedPluginSettingsScope;
    target: ScopedPluginSettingsTarget;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    adapter: ScopedPluginSettingsAdapter;
}>): ScopedPluginSettingsRecordStore {
    let state: SharedRecordState = {
        snapshot: null,
        settled: false,
        // A fresh record has no safe presentation until its first scoped
        // snapshot settles. Mark it loading before React effects subscribe so
        // a renderer cannot expose an editable empty transient between mount
        // and the owner-owned read.
        loading: true,
        writePending: false,
        error: null,
    };
    let nextSubscriberId = 0;
    let requestGeneration = 0;
    let lifetimeGeneration = 0;
    let pendingWriteCount = 0;
    // The store serializes one mutation per record lifetime. Retain its
    // canonical storage field so declaration retirement can invalidate only
    // that obsolete write without weakening live sibling-field serialization.
    let pendingWriteFieldId: string | null = null;
    let loadedFieldsKey: string | null = null;
    let subscribers = new Map<number, StoreSubscriber>();
    let inventoryFieldsKey = scopedPluginSettingsFieldsKey([]);
    let inventoryGeneration = 0;
    let currentRead: Promise<void> | null = null;
    let currentReadFieldsKey: string | null = null;
    let refreshAfterCurrentRead = false;
    let initialRefreshScheduled = false;
    let watch: Readonly<{ dispose(): void }> | null = null;
    let watchGeneration = 0;
    let recordLifetimeRetired = false;

    const notify = () => {
        for (const subscriber of subscribers.values()) subscriber.listener();
    };

    const activeFields = () => unionSubscriberFields(subscribers);

    const currentInventory = () => {
        const fields = activeFields();
        const fieldsKey = scopedPluginSettingsFieldsKey(fields);
        if (fieldsKey !== inventoryFieldsKey) {
            inventoryFieldsKey = fieldsKey;
            inventoryGeneration += 1;
        }
        return { fields, fieldsKey, generation: inventoryGeneration };
    };

    const isRecordCurrent = () => (
        !recordLifetimeRetired && isCurrentAccountLifetime(params.accountLifetime)
    );

    const refresh = async (): Promise<void> => {
        if (!isRecordCurrent()) {
            retireRecord();
            return;
        }
        const { fields, fieldsKey } = currentInventory();
        if (fields.length === 0) {
            state = {
                ...state,
                settled: true,
                loading: false,
                error: null,
            };
            loadedFieldsKey = fieldsKey;
            notify();
            return;
        }
        if (currentRead && currentReadFieldsKey === fieldsKey) {
            await currentRead;
            return;
        }
        const generation = requestGeneration + 1;
        requestGeneration = generation;
        currentReadFieldsKey = fieldsKey;
        state = {
            ...state,
            settled: state.snapshot !== null,
            loading: true,
            error: null,
        };
        notify();
        const read = (async () => {
            let result: Awaited<ReturnType<ScopedPluginSettingsAdapter['read']>>;
            try {
                result = await params.adapter.read({
                    pluginId: params.pluginId,
                    scope: params.scope,
                    target: params.target,
                    fields,
                });
            } catch {
                result = { status: 'unavailable', reason: 'transport' };
            }
            if (!isRecordCurrent()) {
                retireRecord();
                return;
            }
            if (requestGeneration !== generation) return;
            if (result.status === 'ready') {
                state = {
                    snapshot: result.snapshot,
                    settled: true,
                    loading: false,
                    writePending: pendingWriteCount > 0,
                    error: null,
                };
                loadedFieldsKey = fieldsKey;
            } else {
                state = {
                    ...state,
                    settled: true,
                    loading: false,
                    writePending: pendingWriteCount > 0,
                    error: 'unavailable',
                };
            }
            notify();
            const latestFieldsKey = currentInventory().fieldsKey;
            if (latestFieldsKey !== fieldsKey && subscribers.size > 0) void refresh();
        })();
        currentRead = read;
        try {
            await read;
        } finally {
            if (currentRead === read) {
                currentRead = null;
                currentReadFieldsKey = null;
                if (refreshAfterCurrentRead && subscribers.size > 0) {
                    refreshAfterCurrentRead = false;
                    void refresh();
                }
            }
        }
    };

    const scheduleInitialRefresh = () => {
        if (initialRefreshScheduled) return;
        initialRefreshScheduled = true;
        queueMicrotask(() => {
            initialRefreshScheduled = false;
            if (subscribers.size === 0 || currentRead !== null) return;
            void refresh();
        });
    };

    const refreshIfNeeded = () => {
        if (!isRecordCurrent()) {
            retireRecord();
            return;
        }
        const { fields, fieldsKey } = currentInventory();
        if (fields.length === 0) {
            void refresh();
            return;
        }
        if (state.snapshot === null || loadedFieldsKey !== fieldsKey) {
            // React mounts nested Settings controls child-first. Give every
            // subscriber in that one commit a microtask to join the record
            // inventory, then read their union once instead of issuing an
            // initial partial snapshot followed by a second widened one.
            if (currentRead === null) scheduleInitialRefresh();
            // A current read for this exact inventory already supplies the
            // pending request. A widened inventory waits for that read to
            // settle, then the record owner performs one current read rather
            // than starting a competing overlap.
            else if (currentReadFieldsKey !== fieldsKey) refreshAfterCurrentRead = true;
        }
        else notify();
    };

    const disposeWatch = () => {
        watchGeneration += 1;
        const current = watch;
        watch = null;
        if (!current) return;
        try {
            current.dispose();
        } catch {
            // A boundary watch must not keep a Settings record mounted after
            // its last consumer has retired.
        }
    };

    const retireCurrentRecord = () => {
        // A record can remain mounted while every consumer loses executable
        // admission (for example, during a daemon reconnect). That transition
        // is just as terminal for an in-flight mutation as the final unmount:
        // retain the last-known-good snapshot, but never let an old transport
        // response hold the next current consumer's write lock or settle into
        // its authority.
        lifetimeGeneration += 1;
        requestGeneration += 1;
        currentRead = null;
        currentReadFieldsKey = null;
        refreshAfterCurrentRead = false;
        initialRefreshScheduled = false;
        pendingWriteCount = 0;
        pendingWriteFieldId = null;
        loadedFieldsKey = null;
        state = {
            ...state,
            loading: false,
            writePending: false,
        };
    };

    /**
     * Account lifetime retirement is terminal for every UI-held Settings
     * projection, including an exact daemon target. Preserve same-Account LKG
     * through reconnects above, but never let a same-daemon Account B inherit
     * Account A's values, revision, pending work, or watch callback.
     */
    const retireRecord = () => {
        if (recordLifetimeRetired) return;
        recordLifetimeRetired = true;
        disposeWatch();
        retireCurrentRecord();
        state = {
            snapshot: null,
            settled: false,
            loading: false,
            writePending: false,
            error: null,
        };
        notify();
    };

    // The incumbent scope owner marks a lifetime stale before callbacks, so
    // this clear and watch disposal complete synchronously before Account B
    // can mount—even when its exact daemon target is unchanged.
    params.accountLifetime?.onRetire(retireRecord);

    const retirePendingWriteForRemovedField = () => {
        if (pendingWriteCount === 0 || pendingWriteFieldId === null) return;
        const { fields } = currentInventory();
        if (fields.some((field) => fieldCanMutateStorageField(field, pendingWriteFieldId!))) return;
        // The only write in this record lifetime addressed a declaration that
        // no longer exists. It cannot retain the lock for a reintroduced
        // field; retire it just like a loss of current admission.
        retireCurrentRecord();
    };

    const reconcileWatch = () => {
        if (!isRecordCurrent()) {
            retireRecord();
            return;
        }
        if (currentInventory().fields.length === 0) {
            disposeWatch();
            return;
        }
        if (watch || !params.adapter.watch) return;
        const generation = watchGeneration + 1;
        watchGeneration = generation;
        try {
            const registered = params.adapter.watch({
                pluginId: params.pluginId,
                scope: params.scope,
                target: params.target,
                onInvalidated: () => {
                    if (watchGeneration !== generation || subscribers.size === 0) return;
                    if (!isRecordCurrent()) {
                        retireRecord();
                        return;
                    }
                    // AccountChange is level-triggered. If its notification
                    // races a current read, retain one owner-local reread
                    // after that response instead of losing the newer fact.
                    if (currentRead) {
                        refreshAfterCurrentRead = true;
                        return;
                    }
                    void refresh();
                },
            });
            watch = registered ?? null;
        } catch {
            // A watch is an enhancement to this owner's authoritative read;
            // registration failure never grants a second local data path.
            watch = null;
        }
    };

    return Object.freeze({
        subscribe(input) {
            const id = nextSubscriberId + 1;
            nextSubscriberId = id;
            subscribers.set(id, input);
            // Register before the first read so an AccountChange cannot land
            // between subscription and the record's initial snapshot.
            reconcileWatch();
            refreshIfNeeded();
            return Object.freeze({
                id,
                unsubscribe: () => {
                    if (!subscribers.delete(id)) return;
                    if (subscribers.size > 0) {
                        retirePendingWriteForRemovedField();
                        reconcileWatch();
                        refreshIfNeeded();
                        return;
                    }
                    disposeWatch();
                    // A later remount must not reuse a response that settled
                    // after this record lost every current consumer. Keep the
                    // shared store, but make the next subscriber perform its
                    // own authoritative read.
                    retireCurrentRecord();
                },
            });
        },
        update(id, input) {
            const previous = subscribers.get(id);
            if (!previous) return;
            const hadCurrentConsumers = currentInventory().fields.length > 0;
            subscribers.set(id, input);
            if (hadCurrentConsumers && currentInventory().fields.length === 0) {
                retireCurrentRecord();
            } else {
                retirePendingWriteForRemovedField();
                if (previous.sourceLifetimeIdentity !== input.sourceLifetimeIdentity) {
                    // The exact record remains the same, but its declaration
                    // authority did not. Do not adopt an older source's
                    // mutation response, and make one record-owned reread
                    // authoritative for the replacement source.
                    inventoryGeneration += 1;
                    loadedFieldsKey = null;
                    if (currentRead !== null) {
                        requestGeneration += 1;
                        refreshAfterCurrentRead = true;
                    }
                }
            }
            reconcileWatch();
            refreshIfNeeded();
        },
        state: () => state,
        async commit(input) {
            if (!isRecordCurrent()) {
                retireRecord();
                return null;
            }
            const snapshot = state.snapshot;
            const inventory = currentInventory();
            const { fields } = inventory;
            // The rendered controls disable while a write is pending, but an
            // already-captured callback can outlive that render. Keep one
            // serialization gate at the shared record so generic and
            // declarative consumers cannot issue competing CAS writes.
            if (!snapshot || fields.length === 0 || pendingWriteCount > 0) return null;
            const lifetime = lifetimeGeneration;
            // Target selection remains owned by its caller; the shared store
            // invokes its assertion immediately before one adapter dispatch.
            if (!isWriteCurrent(input.isCurrent)) return null;
            pendingWriteCount += 1;
            pendingWriteFieldId = input.fieldId;
            state = { ...state, writePending: true, error: null };
            notify();
            let result: ScopedPluginSettingsWriteResult;
            try {
                result = await params.adapter.write({
                    pluginId: params.pluginId,
                    scope: params.scope,
                    target: params.target,
                    fields,
                    fieldId: input.fieldId,
                    mutation: input.mutation,
                    expectedRevision: snapshot.revision,
                });
            } catch {
                result = { status: 'unavailable', reason: 'transport' };
            }
            if (!isRecordCurrent()) {
                retireRecord();
                return null;
            }
            // A reconnect may already have retired this write's lifetime and
            // admitted a new mutation. The old transport response is no
            // longer counted in that new lifetime, so it must not decrement
            // the current write's pending counter.
            if (lifetimeGeneration === lifetime) {
                pendingWriteCount = Math.max(0, pendingWriteCount - 1);
                pendingWriteFieldId = null;
            }
            if (
                lifetimeGeneration !== lifetime
                || inventoryGeneration !== inventory.generation
                || !isWriteCurrent(input.isCurrent)
            ) {
                state = { ...state, writePending: pendingWriteCount > 0 };
                notify();
                return null;
            }
            const resultSnapshot = 'snapshot' in result ? result.snapshot : undefined;
            if (
                resultSnapshot !== undefined
                && (
                    result.status === 'ready'
                    || result.status === 'conflict'
                    || result.status === 'outcomeUnknown'
                )
            ) {
                state = {
                    snapshot: applyWriteSnapshotField({
                        current: state.snapshot,
                        result: resultSnapshot,
                        fieldId: input.fieldId,
                    }),
                    settled: true,
                    loading: false,
                    writePending: pendingWriteCount > 0,
                    error: result.status === 'conflict'
                        ? 'failed'
                        : result.status === 'outcomeUnknown'
                            ? 'outcomeUnknown'
                            : null,
                };
                loadedFieldsKey = scopedPluginSettingsFieldsKey(fields);
                notify();
                return result;
            }
            if (result.status === 'outcomeUnknown') {
                // The adapter has already attempted its sole safe readback.
                // Do not turn an ambiguous write into a second request or a
                // silent retry when that readback could not be obtained.
                state = {
                    ...state,
                    writePending: pendingWriteCount > 0,
                    error: 'outcomeUnknown',
                };
                notify();
                return result;
            }
            state = {
                ...state,
                writePending: pendingWriteCount > 0,
                error: 'failed',
            };
            notify();
            // One recovery read belongs to this owner. Consumers never race a
            // local refetch or replay their rejected mutation.
            await refresh();
            // A successful recovery snapshot lets the renderer restore the
            // authoritative value, but it does not turn the rejected mutation
            // into a success. Keep the typed failure visible until a later
            // current operation or refresh supersedes it.
            if (
                lifetimeGeneration === lifetime
                && inventoryGeneration === inventory.generation
            ) {
                state = { ...state, error: 'failed' };
                notify();
            }
            return result;
        },
        refresh,
    });
}

function resolveScopedPluginSettingsRecordStore(params: Readonly<{
    pluginId: string;
    scope: ScopedPluginSettingsScope;
    target: ScopedPluginSettingsTarget;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    adapter: ScopedPluginSettingsAdapter;
}>): ScopedPluginSettingsRecordStore | null {
    const recordKey = `${params.pluginId}:${params.scope.kind}:${scopedTargetKey(params.target)}`;
    let cache = storesByAdapter.get(params.adapter);
    if (!cache) {
        cache = {
            storesByLifetime: new WeakMap(),
        };
        storesByAdapter.set(params.adapter, cache);
    }

    const accountLifetime = params.accountLifetime;
    if (!accountLifetime || !isCurrentAccountLifetime(accountLifetime)) return null;
    let stores = cache.storesByLifetime.get(accountLifetime);
    if (!stores) {
        stores = new Map();
        cache.storesByLifetime.set(accountLifetime, stores);
    }
    let store = stores.get(recordKey);
    if (!store) {
        store = createScopedPluginSettingsRecordStore(params);
        stores.set(recordKey, store);
    }
    return store;
}

/**
 * Imperative field mutations share the exact record store used by mounted
 * Generic and declarative Settings. This is the only non-React entry point:
 * it joins the current field inventory, refreshes through the canonical
 * adapter, and obeys the same serialization, CAS, currentness, conflict, and
 * recovery rules instead of starting a second read/write loop.
 */
export async function commitScopedPluginSettingsField(
    input: CommitScopedPluginSettingsFieldInput,
): Promise<ScopedPluginSettingsWriteResult | null> {
    const store = resolveScopedPluginSettingsRecordStore(input);
    if (!store) return null;
    const subscription = store.subscribe({
        fields: input.fields,
        enabled: true,
        // The command joins the record mutation owner; it does not become a
        // declaration/source owner that could replace a mounted Settings view.
        sourceLifetimeIdentity: null,
        listener: () => {},
    });
    try {
        // Do not launch a competing refresh while a mounted Settings control
        // owns the record's one in-flight mutation. `commit` repeats this
        // serialization check to close the race after a refresh settles.
        if (store.state().writePending) return null;
        await store.refresh();
        return await store.commit({
            fieldId: input.fieldId,
            mutation: input.mutation,
            ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
        });
    } finally {
        subscription.unsubscribe();
    }
}

function projectDrafts(params: Readonly<{
    fields: readonly ScopedPluginSettingsField[];
    values: Readonly<Record<string, unknown>>;
    dirtyDrafts: Drafts;
}>): Drafts {
    const drafts: Record<string, unknown> = {};
    for (const field of params.fields) {
        const persisted = fieldDraftValue(params.values, field);
        if (persisted !== undefined) drafts[field.key] = persisted;
        if (Object.prototype.hasOwnProperty.call(params.dirtyDrafts, field.key)) {
            drafts[field.key] = params.dirtyDrafts[field.key];
        }
    }
    return drafts;
}

function retainSemanticDrafts(params: Readonly<{
    previousFields: readonly ScopedPluginSettingsField[];
    fields: readonly ScopedPluginSettingsField[];
    dirtyDrafts: Drafts;
}>): Drafts {
    const previousByKey = new Map(params.previousFields.map((field) => [field.key, fieldIdentity(field)]));
    const next: Record<string, unknown> = {};
    for (const field of params.fields) {
        if (
            previousByKey.get(field.key) === fieldIdentity(field)
            && Object.prototype.hasOwnProperty.call(params.dirtyDrafts, field.key)
        ) {
            next[field.key] = params.dirtyDrafts[field.key];
        }
    }
    return next;
}

function matchesFieldModelEntry(
    entry: FieldModelDraft | FieldModelError | undefined,
    context: string,
    declarationIdentity: string,
): boolean {
    return entry?.context === context && entry.declarationIdentity === declarationIdentity;
}

type ScopedPluginSettingsFieldModelsParams = Readonly<{
    declaredFields: readonly PluginProjectionEditableSettingField[];
    fields: readonly ScopedPluginSettingsField[];
    perActiveServerIdentityId: string | null;
    sourceLifetimeIdentity: string | null;
    recordKey: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    state: ScopedPluginSettingsProjectionState;
    /** Reads the shared record's synchronous CAS admission state. */
    isRecordWritePending: () => boolean;
    commitRecord: ScopedPluginSettingsProjection['commit'];
}>;

/**
 * The record store owns snapshot/revision/CAS. This companion projection owns
 * the declaration-bound field model that ordinary Settings renderers consume,
 * so no renderer reconstructs parsing, drafts, pending/error maps, or write
 * currentness around that record owner.
 */
function useScopedPluginSettingsFieldModels(
    params: ScopedPluginSettingsFieldModelsParams,
): readonly ScopedPluginSettingsFieldModel[] {
    const declaredFieldsKey = React.useMemo(
        () => JSON.stringify(params.declaredFields.map(scopedPluginSettingsFieldDeclarationIdentity)),
        [params.declaredFields],
    );
    const context = `${params.recordKey}:${accountLifetimeIdentity(params.accountLifetime)}:${JSON.stringify(params.perActiveServerIdentityId)}`;
    const allowedFieldIdentities = React.useMemo(
        () => new Set(params.fields.map(fieldIdentity)),
        [params.fields],
    );
    const declaredFields = React.useMemo(
        () => params.declaredFields.filter((field) => allowedFieldIdentities.has(fieldIdentity(
            projectScopedPluginSettingsField(field),
        ))),
        [allowedFieldIdentities, params.declaredFields],
    );
    const declarationIdentityByKey = React.useMemo(() => {
        const identities = new Map<string, string>();
        for (const field of declaredFields) {
            // Duplicate declarations intentionally share one draft/fence. The
            // protocol projection never grants different semantics to the same
            // field key within one scoped form.
            identities.set(field.key, scopedPluginSettingsFieldDeclarationIdentity(field));
        }
        return identities;
    }, [declaredFields]);
    const [drafts, setDrafts] = React.useState<FieldModelDrafts>(() => Object.freeze({}));
    const [errors, setErrors] = React.useState<FieldModelErrors>(() => Object.freeze({}));
    const draftsRef = React.useRef<FieldModelDrafts>(drafts);
    const nextDraftVersionRef = React.useRef(0);
    const previousSourceLifetimeIdentityRef = React.useRef(params.sourceLifetimeIdentity);
    const currentRef = React.useRef<Readonly<{
        context: string;
        declarationIdentityByKey: ReadonlyMap<string, string>;
        perActiveServerIdentityId: string | null;
        sourceLifetimeIdentity: string | null;
        state: ScopedPluginSettingsProjectionState;
    }>>({
        context,
        declarationIdentityByKey,
        perActiveServerIdentityId: params.perActiveServerIdentityId,
        sourceLifetimeIdentity: params.sourceLifetimeIdentity,
        state: params.state,
    });
    currentRef.current = {
        context,
        declarationIdentityByKey,
        perActiveServerIdentityId: params.perActiveServerIdentityId,
        sourceLifetimeIdentity: params.sourceLifetimeIdentity,
        state: params.state,
    };
    draftsRef.current = drafts;

    React.useLayoutEffect(() => {
        const currentIdentities = currentRef.current.declarationIdentityByKey;
        const sourceReplaced = previousSourceLifetimeIdentityRef.current !== params.sourceLifetimeIdentity;
        previousSourceLifetimeIdentityRef.current = params.sourceLifetimeIdentity;
        const retain = (entries: FieldModelDrafts | FieldModelErrors) => {
            const next: Record<string, FieldModelDraft | FieldModelError> = {};
            for (const [key, entry] of Object.entries(entries)) {
                if (
                    entry.context === context
                    && currentIdentities.get(key) === entry.declarationIdentity
                ) {
                    next[key] = entry;
                }
            }
            return next;
        };
        const retainedDrafts = retain(draftsRef.current) as FieldModelDrafts;
        const currentDrafts = sourceReplaced
            ? Object.fromEntries(Object.entries(retainedDrafts).map(([key, entry]) => [
                key,
                { ...entry, committable: false },
            ]))
            : retainedDrafts;
        draftsRef.current = currentDrafts;
        setDrafts(currentDrafts);
        setErrors((current) => {
            if (sourceReplaced) return Object.freeze({});
            const next = retain(current) as FieldModelErrors;
            return next;
        });
    }, [context, declaredFieldsKey, params.sourceLifetimeIdentity]);

    const isCurrentField = React.useCallback((
        field: PluginProjectionEditableSettingField,
        identity: string,
        expectedContext?: string,
    ) => {
        const current = currentRef.current;
        return (
            (expectedContext === undefined || current.context === expectedContext)
            && current.declarationIdentityByKey.get(field.key) === identity
        );
    }, []);

    const setFieldDraft = React.useCallback((
        field: PluginProjectionEditableSettingField,
        identity: string,
        value: unknown,
    ): FieldModelDraft | null => {
        const current = currentRef.current;
        if (!isCurrentField(field, identity)) return null;
        const persistedDraft = formatDeclaredFieldDraft(
            field,
            readDeclaredFieldValue({
                values: current.state.values,
                field,
                serverIdentityId: current.perActiveServerIdentityId,
            }),
        );
        const existing = draftsRef.current[field.key];
        const version = nextDraftVersionRef.current + 1;
        nextDraftVersionRef.current = version;
        const next = { ...draftsRef.current };
        if (sameValue(value, persistedDraft)) {
            delete next[field.key];
        } else {
            next[field.key] = {
                context: current.context,
                declarationIdentity: identity,
                value,
                // A programmatic immediate control can submit the same
                // semantic value twice; still fence its stale settlement.
                version: existing && matchesFieldModelEntry(existing, current.context, identity)
                    ? Math.max(existing.version + 1, version)
                    : version,
                committable: true,
            };
        }
        const activeDraft = next[field.key] ?? null;
        // Immediate controls submit from the same event. Keep the model ref
        // authoritative before React schedules a render so that a direct
        // `commit({ draft })` cannot observe a previous value.
        draftsRef.current = next;
        setDrafts(next);
        setErrors((previous) => {
            if (!Object.prototype.hasOwnProperty.call(previous, field.key)) return previous;
            const next = { ...previous };
            delete next[field.key];
            return next;
        });
        return activeDraft;
    }, [isCurrentField]);

    const commitField = React.useCallback(async (
        field: PluginProjectionEditableSettingField,
        identity: string,
        input: Readonly<{ draft?: unknown; isCurrent?: ScopedPluginSettingsWriteCurrentness }> | undefined,
    ): Promise<ScopedPluginSettingsWriteResult | null> => {
        const beforeDraft = currentRef.current;
        // An immediate control can retain a callback from before a sibling
        // started its CAS write. Reject it before changing the local model so
        // a disabled switch/select cannot become an uncommitted optimistic
        // second mutation.
        if (
            !isCurrentField(field, identity)
            || !beforeDraft.state.ready
            || beforeDraft.state.writePending
            || params.isRecordWritePending()
        ) {
            return null;
        }
        let submittedDraft: FieldModelDraft | null = null;
        if (input && Object.hasOwn(input, 'draft')) {
            submittedDraft = setFieldDraft(field, identity, input.draft);
        }
        const current = currentRef.current;
        if (
            !isCurrentField(field, identity)
            || !current.state.ready
            || current.state.writePending
            || params.isRecordWritePending()
        ) return null;
        const activeDraft = submittedDraft ?? draftsRef.current[field.key];
        if (
            !matchesFieldModelEntry(activeDraft, current.context, identity)
            || !activeDraft.committable
        ) return null;
        const parsed = parseDeclaredFieldDraft(field, activeDraft.value);
        if (!parsed.ok) {
            setErrors((previous) => {
                const entry: FieldModelError = {
                    context: current.context,
                    declarationIdentity: identity,
                    draftVersion: activeDraft.version,
                    status: 'failed',
                };
                const next: FieldModelErrors = { ...previous, [field.key]: entry };
                return next;
            });
            return null;
        }
        const storageMutation = resolveScopedPluginSettingMutation({
            values: current.state.values,
            field: projectScopedPluginSettingsField(field),
            serverIdentityId: current.perActiveServerIdentityId,
            value: parsed.value,
        });
        const mutation = createScopedPluginSettingsSetMutation(storageMutation.value);
        if (!mutation) {
            setErrors((previous) => {
                const entry: FieldModelError = {
                    context: current.context,
                    declarationIdentity: identity,
                    draftVersion: activeDraft.version,
                    status: 'failed',
                };
                const next: FieldModelErrors = { ...previous, [field.key]: entry };
                return next;
            });
            return null;
        }
        const remainsCurrent = (): boolean => {
            if (!isCurrentField(field, identity, current.context)) return false;
            if (!input?.isCurrent) return true;
            try {
                return input.isCurrent();
            } catch {
                return false;
            }
        };
        if (!remainsCurrent()) return null;
        const result = await params.commitRecord({
            fieldId: storageMutation.fieldId,
            mutation,
            draftFieldId: field.key,
            isCurrent: remainsCurrent,
        });
        const latest = currentRef.current;
        const latestDraft = draftsRef.current[field.key];
        if (
            latest.context !== current.context
            || latest.declarationIdentityByKey.get(field.key) !== identity
            || !latestDraft
            || !matchesFieldModelEntry(latestDraft, current.context, identity)
            || latestDraft.version !== activeDraft.version
        ) {
            return result;
        }
        if (latest.sourceLifetimeIdentity !== current.sourceLifetimeIdentity) {
            // The caller's source changed while this write was in flight.
            // Retain its visible draft for continuity, but require a new user
            // edit before the replacement source can issue another mutation.
            const next = {
                ...draftsRef.current,
                [field.key]: { ...latestDraft, committable: false },
            };
            draftsRef.current = next;
            setDrafts(next);
            return result;
        }
        if (result?.status === 'ready') {
            const next = { ...draftsRef.current };
            delete next[field.key];
            draftsRef.current = next;
            setDrafts(next);
            setErrors((previous) => {
                if (!Object.prototype.hasOwnProperty.call(previous, field.key)) return previous;
                const next = { ...previous };
                delete next[field.key];
                return next;
            });
            return result;
        }
        if (result !== null) {
            if (
                field.control === 'switch'
                || field.control === 'select'
                || field.control === 'multiSelect'
            ) {
                // Immediate controls do not leave a failed optimistic value
                // selected. The owner has either adopted a safe conflict/
                // readback snapshot or retained the last authoritative value.
                const next = { ...draftsRef.current };
                delete next[field.key];
                draftsRef.current = next;
                setDrafts(next);
            }
            setErrors((previous) => {
                const entry: FieldModelError = {
                    context: current.context,
                    declarationIdentity: identity,
                    draftVersion: activeDraft.version,
                    status: result.status === 'outcomeUnknown' ? 'outcomeUnknown' : 'failed',
                };
                const next: FieldModelErrors = { ...previous, [field.key]: entry };
                return next;
            });
        }
        return result;
    }, [isCurrentField, params.commitRecord, params.isRecordWritePending, setFieldDraft]);

    return React.useMemo(() => declaredFields.map((field) => {
        const identity = scopedPluginSettingsFieldDeclarationIdentity(field);
        const value = readDeclaredFieldValue({
            values: params.state.values,
            field,
            serverIdentityId: params.perActiveServerIdentityId,
        });
        const persistedDraft = formatDeclaredFieldDraft(field, value);
        const activeDraft = drafts[field.key];
        const hasDraft = matchesFieldModelEntry(activeDraft, context, identity);
        const draft = hasDraft ? activeDraft!.value : persistedDraft;
        const error = errors[field.key];
        const currentError = matchesFieldModelEntry(error, context, identity)
            && (!hasDraft || error!.draftVersion === activeDraft!.version)
            ? error!.status
            : null;
        return Object.freeze({
            field,
            value,
            draft,
            dirty: hasDraft && activeDraft!.committable,
            pending: params.state.writePending,
            error: currentError,
            setDraft: (next: unknown) => setFieldDraft(field, identity, next),
            commit: (input?: Readonly<{
                draft?: unknown;
                isCurrent?: ScopedPluginSettingsWriteCurrentness;
            }>) => commitField(field, identity, input),
        } satisfies ScopedPluginSettingsFieldModel);
    }), [commitField, context, declaredFields, drafts, errors, params.perActiveServerIdentityId, params.state, setFieldDraft]);
}

/**
 * Canonical host-side Settings projection. A record-keyed store owns the
 * adapter's snapshot, revision, watches, CAS mutation, conflict adoption, and
 * one recovery refresh once; every mounted consumer subscribes to a safe
 * declaration-filtered view of that one shared record.
 */
export function useScopedPluginSettingsProjection(
    params: UseScopedPluginSettingsProjectionParams,
): ScopedPluginSettingsProjection {
    const fieldsKey = scopedPluginSettingsFieldsKey(params.fields);
    const targetKey = scopedTargetKey(params.target);
    const recordKey = `${params.pluginId}:${params.scope.kind}:${targetKey}`;
    const scopeKey = `${recordKey}:${fieldsKey}`;
    const store = React.useMemo(
        () => params.target
            ? resolveScopedPluginSettingsRecordStore({
                pluginId: params.pluginId,
                scope: params.scope,
                target: params.target,
                accountLifetime: params.accountLifetime,
                adapter: params.adapter,
            })
            : null,
        [params.accountLifetime, params.adapter, params.pluginId, params.scope.kind, recordKey],
    );
    const [, forceRender] = React.useReducer((count: number) => count + 1, 0);
    const subscriberRef = React.useRef<StoreSubscriber>({
        fields: params.fields,
        enabled: params.enabled,
        sourceLifetimeIdentity: params.sourceLifetimeIdentity ?? null,
        listener: forceRender,
    });
    subscriberRef.current = {
        fields: params.fields,
        enabled: params.enabled,
        sourceLifetimeIdentity: params.sourceLifetimeIdentity ?? null,
        listener: forceRender,
    };
    const subscriptionRef = React.useRef<Readonly<{
        store: ScopedPluginSettingsRecordStore;
        id: number;
    }> | null>(null);
    const previousFieldsRef = React.useRef<readonly ScopedPluginSettingsField[]>(params.fields);
    const previousRecordKeyRef = React.useRef(recordKey);
    const previousAccountLifetimeRef = React.useRef(params.accountLifetime);
    const dirtyDraftsRef = React.useRef<Drafts>(EMPTY_DRAFTS);
    const draftVersionByKeyRef = React.useRef(new Map<string, number>());
    const [dirtyDrafts, setDirtyDrafts] = React.useState<Drafts>(EMPTY_DRAFTS);

    React.useEffect(() => {
        if (!store) {
            subscriptionRef.current = null;
            return;
        }
        const subscription = store.subscribe(subscriberRef.current);
        subscriptionRef.current = { store, id: subscription.id };
        return () => {
            if (subscriptionRef.current?.store === store && subscriptionRef.current.id === subscription.id) {
                subscriptionRef.current = null;
            }
            subscription.unsubscribe();
        };
    }, [store]);

    // Update the existing subscriber inventory without replacing the shared
    // record. The store decides whether its field identity actually needs a
    // read, so an equivalent parent rerender cannot start a second request.
    React.useLayoutEffect(() => {
        const subscription = subscriptionRef.current;
        if (!store || subscription?.store !== store) return;
        store.update(subscription.id, subscriberRef.current);
    }, [params.enabled, params.fields, params.sourceLifetimeIdentity, store]);

    React.useLayoutEffect(() => {
        const previousFields = previousFieldsRef.current;
        const sameRecord = previousRecordKeyRef.current === recordKey
            && previousAccountLifetimeRef.current === params.accountLifetime;
        previousRecordKeyRef.current = recordKey;
        previousAccountLifetimeRef.current = params.accountLifetime;
        previousFieldsRef.current = params.fields;
        const retained = retainSemanticDrafts({
            previousFields: sameRecord ? previousFields : [],
            fields: params.fields,
            dirtyDrafts: dirtyDraftsRef.current,
        });
        dirtyDraftsRef.current = retained;
        setDirtyDrafts(retained);
    }, [fieldsKey, params.accountLifetime, recordKey]);

    const shared = store?.state() ?? {
        snapshot: null,
        settled: params.fields.length === 0 || !params.enabled || !params.target,
        loading: false,
        writePending: false,
        error: !params.enabled || !params.target ? 'unavailable' as const : null,
    } satisfies SharedRecordState;
    // Consumers use the safe values as effect dependencies. Keep this view
    // referentially stable until the record snapshot, declaration inventory,
    // or local draft actually changes.
    const projected = React.useMemo(
        () => shared.snapshot
            ? projectSnapshotForFields(shared.snapshot, params.fields)
            : { values: EMPTY_VALUES, secretStates: EMPTY_SECRET_STATES },
        [params.fields, shared.snapshot],
    );
    const drafts = React.useMemo(
        () => projectDrafts({ fields: params.fields, values: projected.values, dirtyDrafts }),
        [dirtyDrafts, params.fields, projected.values],
    );
    const state = React.useMemo<ScopedPluginSettingsProjectionState>(() => ({
        scopeKey,
        values: projected.values,
        secretStates: projected.secretStates,
        drafts,
        revision: shared.snapshot?.revision ?? null,
        ready: shared.snapshot !== null && params.enabled,
        settled: params.fields.length === 0 || shared.settled,
        loading: params.fields.length > 0 && params.enabled ? shared.loading : false,
        writePending: shared.writePending,
        error: params.fields.length === 0 ? null : shared.error,
    }), [
        drafts,
        params.enabled,
        params.fields.length,
        projected.secretStates,
        projected.values,
        scopeKey,
        shared.error,
        shared.loading,
        shared.settled,
        shared.snapshot,
        shared.writePending,
    ]);

    const setDraft = React.useCallback((fieldId: string, value: unknown) => {
        const field = params.fields.find((candidate) => candidate.key === fieldId);
        if (!field) return;
        const persisted = fieldDraftValue(projected.values, field);
        draftVersionByKeyRef.current.set(fieldId, (draftVersionByKeyRef.current.get(fieldId) ?? 0) + 1);
        setDirtyDrafts((current) => {
            const next = { ...current };
            if (sameValue(value, persisted)) delete next[fieldId];
            else next[fieldId] = value;
            dirtyDraftsRef.current = next;
            return next;
        });
    }, [params.fields, projected.values]);

    const commit = React.useCallback(async (input: Readonly<{
        fieldId: string;
        mutation: ScopedPluginSettingsMutation;
        draftFieldId?: string;
        isCurrent?: ScopedPluginSettingsWriteCurrentness;
    }>): Promise<ScopedPluginSettingsWriteResult | null> => {
        if (!store || !params.enabled || !params.target) return null;
        const draftFieldId = input.draftFieldId ?? input.fieldId;
        const draftVersion = draftVersionByKeyRef.current.get(draftFieldId) ?? 0;
        const revisionBeforeCommit = store.state().snapshot?.revision ?? null;
        const result = await store.commit(input);
        const recoveredRevision = store.state().snapshot?.revision ?? null;
        // A failed transport normally preserves a local draft for retry. Once
        // this record's one recovery read proves a newer authoritative
        // revision, however, that draft no longer describes the current
        // record and must not obscure the recovered value.
        const adoptAuthoritativeDraft = result?.status === 'ready'
            || result?.status === 'conflict'
            || (
                result?.status === 'unavailable'
                && recoveredRevision !== null
                && !sameValue(recoveredRevision, revisionBeforeCommit)
            );
        if (
            adoptAuthoritativeDraft
            && draftVersionByKeyRef.current.get(draftFieldId) === draftVersion
        ) {
            setDirtyDrafts((current) => {
                if (!Object.prototype.hasOwnProperty.call(current, draftFieldId)) return current;
                const next = { ...current };
                delete next[draftFieldId];
                dirtyDraftsRef.current = next;
                return next;
            });
        }
        return result;
    }, [params.enabled, params.target, store]);

    const refresh = React.useCallback(async (): Promise<void> => {
        await store?.refresh();
    }, [store]);
    const isRecordWritePending = React.useCallback(
        () => store?.state().writePending ?? false,
        [store],
    );

    const fieldModels = useScopedPluginSettingsFieldModels({
        declaredFields: params.declaredFields ?? EMPTY_DECLARED_FIELDS,
        fields: params.fields,
        perActiveServerIdentityId: params.perActiveServerIdentityId,
        sourceLifetimeIdentity: params.sourceLifetimeIdentity ?? null,
        recordKey,
        accountLifetime: params.accountLifetime,
        state,
        isRecordWritePending,
        commitRecord: commit,
    });

    return React.useMemo(
        () => ({ state, fieldModels, setDraft, commit, refresh }),
        [commit, fieldModels, refresh, setDraft, state],
    );
}
