import { isDeepStrictEqual } from 'node:util';

import {
    PluginIdSchema,
    PluginJsonSchemaV2Schema,
    PluginSettingsContributionV2Schema,
    type PluginJsonSchemaValidator,
    compilePluginJsonSchema,
    isBoundedPluginPerActiveServerValueV1,
    isValidPluginJsonSchemaValue,
    type PluginSettingFieldV2,
    type PluginSettingsContributionV2,
} from '@happier-dev/protocol';
import {
    isPluginError,
    PluginError,
    type Disposable,
    type JsonValue,
} from '@happier-dev/plugin-sdk';
import type {
    ScopedSettingsService,
    SettingDescriptor,
    SettingsChange,
    SettingsScopeRef,
    SettingsService,
} from '@happier-dev/plugin-sdk/settings';

import type { StablePluginEventsBroker } from './events';
import { clonePluginPlainData } from '../../plainData';
import type { PluginInvocationServicesSeed } from './types';
import {
    PLUGIN_HOST_STORAGE_KEY_PREFIX,
    updatePluginStorageScopeValueAtomically,
    type PluginStorageOwnerScope,
} from '../../context/storage';

export const PLUGIN_SETTINGS_STORAGE_KEY = `${PLUGIN_HOST_STORAGE_KEY_PREFIX}settings/v1`;
const SETTINGS_RECORD_TYPE = 'happier_plugin_settings_record_v1';
const MAX_SETTINGS_EVENT_VALUE_BYTES = 512 * 1024;
const MAX_SETTINGS_ACTION_PATCH_BYTES = 64 * 1024;
const MAX_SETTINGS_ACTION_PATCH_FIELDS = 16;
const SETTINGS_CHANGED_REF = Object.freeze({
    pluginId: '@happier',
    localId: 'runtime/plugin-settings-changed',
});

export type CanonicalPluginSettingsRecord = Readonly<{
    t: typeof SETTINGS_RECORD_TYPE;
    revision: number;
    values: Readonly<Record<string, JsonValue>>;
}>;

export type StablePluginSettingsIdentity = Readonly<{
    pluginId: string;
    qualifiedId: string;
}>;

export type StablePluginSettingsField = Readonly<{
    id: string;
    contributionId: string;
    qualifiedId: string;
    descriptor: SettingDescriptor;
}>;

export type StablePluginSettingsModel = Readonly<{
    identity: StablePluginSettingsIdentity;
    scope: PluginSettingsContributionV2['scope'];
    descriptors: readonly SettingDescriptor[];
    fields: readonly StablePluginSettingsField[];
}>;

export type StablePluginSettingsScope = PluginSettingsContributionV2['scope'];

const validatorsByModel = new WeakMap<object, ReadonlyMap<string, PluginJsonSchemaValidator>>();
const perActiveServerMapFieldIdsByModel = new WeakMap<object, ReadonlySet<string>>();

export type StablePluginSettingsRecordStore = Readonly<{
    supports?(model: StablePluginSettingsModel): boolean;
    read(model: StablePluginSettingsModel, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown | null>;
    update<T>(
        model: StablePluginSettingsModel,
        operation: (current: unknown | null) => Readonly<{ record: CanonicalPluginSettingsRecord; result: T }>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<T>;
    watch?(
        model: StablePluginSettingsModel,
        listener: (change: SettingsChange) => void,
    ): Disposable;
}>;

function settingsError(code: string, message: string, details?: JsonValue): PluginError {
    return new PluginError({ code, message, ...(details === undefined ? {} : { details }) });
}

function clonePlainData<T>(value: T, path = 'value'): T {
    return clonePluginPlainData(value, {
        path,
        invalid: (message) => settingsError('plugin_settings_invalid_plain_data', message),
    });
}

function localizedText(value: string | Readonly<{ key: string; fallback: string }>): string {
    return typeof value === 'string' ? value : value.fallback;
}

function normalizeTarget(
    pluginId: string,
    target: PluginSettingsContributionV2['target'],
): SettingDescriptor['target'] {
    if (target.kind === 'plugin') return Object.freeze({ kind: 'plugin' });
    const agent = typeof target.agent === 'string'
        ? { pluginId, localId: target.agent }
        : target.agent;
    return Object.freeze({
        kind: 'agent',
        agent: Object.freeze({ pluginId: agent.pluginId, localId: agent.localId }),
    });
}

function descriptorForField(
    contribution: PluginSettingsContributionV2,
    field: PluginSettingFieldV2,
    pluginId: string,
): SettingDescriptor {
    const schema = PluginJsonSchemaV2Schema.parse(clonePlainData(field.schema));
    const base = {
        id: field.id,
        title: localizedText(field.title),
        ...(field.description ? { description: localizedText(field.description) } : {}),
        target: normalizeTarget(pluginId, contribution.target),
        scope: contribution.scope,
        schema,
    };
    return isSecretSettingField(field)
        ? Object.freeze({ ...base, secret: true as const })
        : Object.freeze({
            ...base,
            ...(field.default === undefined ? {} : { default: clonePlainData(field.default) }),
        });
}

function isSecretSettingField(field: PluginSettingFieldV2): boolean {
    return field.secret === true || (field.secret !== undefined && field.secret !== false);
}

function qualifiedSettingsId(pluginId: string, scope: StablePluginSettingsScope): string {
    return `${pluginId}/settings/${scope}`;
}

function qualifiedSettingsFieldId(identity: StablePluginSettingsIdentity, contributionId: string, fieldId: string): string {
    return `${identity.qualifiedId}/${encodeURIComponent(contributionId)}/fields/${encodeURIComponent(fieldId)}`;
}

export function createStablePluginSettingsModel(params: Readonly<{
    pluginId: string;
    contribution?: PluginSettingsContributionV2;
    contributions?: readonly PluginSettingsContributionV2[];
}>): StablePluginSettingsModel {
    const pluginId = PluginIdSchema.parse(params.pluginId);
    if ((params.contribution === undefined) === (params.contributions === undefined)) {
        throw settingsError(
            'plugin_settings_declaration_invalid',
            `Plugin settings declarations for '${pluginId}' are invalid`,
        );
    }
    const inputContributions = params.contributions ?? [params.contribution!];
    if (inputContributions.length === 0) {
        throw settingsError('plugin_settings_declaration_invalid', `Plugin settings declarations for '${pluginId}' are empty`);
    }
    const contributions = inputContributions.map((input, index) => {
        const plainContribution = clonePlainData(input, `contributions[${index}]`);
        if (!PluginSettingsContributionV2Schema.safeParse(plainContribution).success) {
            throw settingsError(
                'plugin_settings_declaration_invalid',
                `Plugin settings declaration for '${pluginId}' is invalid`,
            );
        }
        // Keep the accessor-free clone rather than Zod's reconstructed objects so JSON keys such
        // as `__proto__` retain exact own-property semantics after validation.
        return plainContribution;
    });
    const scope = contributions[0]!.scope;
    if (contributions.some((contribution) => contribution.scope !== scope)) {
        throw settingsError(
            'plugin_settings_scope_mixed',
            `Plugin settings declarations for '${pluginId}' span multiple persistence scopes`,
        );
    }
    const identity = Object.freeze({
        pluginId,
        qualifiedId: qualifiedSettingsId(pluginId, scope),
    });
    const validators = new Map<string, PluginJsonSchemaValidator>();
    const perActiveServerMapFieldIds = new Set(
        contributions.flatMap((contribution) => contribution.fields.flatMap((field) => (
            field.presentation?.binding?.kind === 'perActiveServer'
                ? [field.presentation.binding.byServerIdSettingId]
                : []
        ))),
    );
    const fields = contributions.flatMap((contribution) => contribution.fields.map((field): StablePluginSettingsField => {
        const qualifiedId = qualifiedSettingsFieldId(identity, contribution.id, field.id);
        if (validators.has(field.id)) {
            throw settingsError(
                'plugin_settings_field_id_conflict',
                `Plugin setting '${field.id}' is declared by multiple settings contributions for '${pluginId}'`,
            );
        }
        let validate: PluginJsonSchemaValidator;
        try {
            validate = compilePluginJsonSchema(field.schema);
        } catch {
            throw settingsError(
                'plugin_settings_invalid_schema',
                `Plugin setting '${qualifiedId}' has an invalid schema`,
            );
        }
        if (!isSecretSettingField(field) && field.default !== undefined
            && (!isValidPluginJsonSchemaValue(validate, field.default)
                || (perActiveServerMapFieldIds.has(field.id)
                    && !isBoundedPluginPerActiveServerValueV1(field.default)))) {
            throw settingsError(
                'plugin_settings_invalid_default',
                `Plugin setting '${qualifiedId}' has an invalid default`,
            );
        }
        validators.set(field.id, validate);
        return Object.freeze({
            id: field.id,
            contributionId: contribution.id,
            qualifiedId,
            descriptor: descriptorForField(contribution, field, pluginId),
        });
    }));
    const model: StablePluginSettingsModel = Object.freeze({
        identity,
        scope,
        descriptors: Object.freeze(fields.map((field) => field.descriptor)),
        fields: Object.freeze(fields),
    });
    validatorsByModel.set(model, validators);
    perActiveServerMapFieldIdsByModel.set(model, perActiveServerMapFieldIds);
    return model;
}

/**
 * Builds one independent model per natural Settings scope.  This is the
 * canonical partition point: callers cannot flatten Account and daemon
 * values into one revision, record, or watch stream.
 */
export function createStablePluginSettingsModels(params: Readonly<{
    pluginId: string;
    contributions: readonly PluginSettingsContributionV2[];
}>): ReadonlyMap<StablePluginSettingsScope, StablePluginSettingsModel> {
    const pluginId = PluginIdSchema.parse(params.pluginId);
    const byScope = new Map<StablePluginSettingsScope, PluginSettingsContributionV2[]>();
    const secretById = new Map<string, Readonly<{ scope: StablePluginSettingsScope; contributionId: string }>>();
    const nonSecretById = new Map<string, Readonly<{ scope: StablePluginSettingsScope; contributionId: string }>>();

    for (const contribution of params.contributions) {
        const group = byScope.get(contribution.scope) ?? [];
        group.push(contribution);
        byScope.set(contribution.scope, group);
        for (const field of contribution.fields) {
            const existingSecret = secretById.get(field.id);
            const existingNonSecret = nonSecretById.get(field.id);
            if (isSecretSettingField(field)) {
                if (existingSecret || existingNonSecret) {
                    throw settingsError(
                        'plugin_settings_field_id_conflict',
                        `Plugin secret setting '${field.id}' is not plugin-global unique for '${pluginId}'`,
                    );
                }
                secretById.set(field.id, Object.freeze({
                    scope: contribution.scope,
                    contributionId: contribution.id,
                }));
            } else {
                if (existingSecret) {
                    throw settingsError(
                        'plugin_settings_field_id_conflict',
                        `Plugin setting '${field.id}' conflicts with a declared plugin secret for '${pluginId}'`,
                    );
                }
                if (!existingNonSecret) {
                    nonSecretById.set(field.id, Object.freeze({
                        scope: contribution.scope,
                        contributionId: contribution.id,
                    }));
                }
            }
        }
    }

    return new Map(
        [...byScope.entries()].map(([scope, contributions]) => [
            scope,
            createStablePluginSettingsModel({ pluginId, contributions }),
        ]),
    );
}

export function validateStablePluginSettingValue(
    model: StablePluginSettingsModel,
    settingId: string,
    value: JsonValue,
): boolean {
    const validator = validatorsByModel.get(model)?.get(settingId);
    if (!validator) {
        throw settingsError(
            'plugin_settings_model_invalid',
            `Plugin setting '${model.identity.qualifiedId}/fields/${settingId}' is not part of this stable model`,
        );
    }
    const plainValue = clonePlainData(value, 'settingValue');
    return validator(plainValue) === true
        && (perActiveServerMapFieldIdsByModel.get(model)?.has(settingId) !== true
            || isBoundedPluginPerActiveServerValueV1(plainValue));
}

export function createPluginStorageBackedSettingsRecordStore(params: Readonly<{
    storageForPlugin(pluginId: string): PluginStorageOwnerScope;
    scope?: PluginSettingsContributionV2['scope'];
    isAvailable?(): boolean;
}>): StablePluginSettingsRecordStore {
    const supportedScope = params.scope ?? 'daemon';
    return Object.freeze({
        supports(model) {
            return model.scope === supportedScope && (params.isAvailable?.() ?? true);
        },
        async read(model): Promise<unknown | null> {
            try {
                return await params.storageForPlugin(model.identity.pluginId).get(PLUGIN_SETTINGS_STORAGE_KEY);
            } catch (error) {
                if (isPluginError(error)) throw error;
                throw settingsError(
                    'plugin_settings_persistence_unavailable',
                    'Plugin settings persistence is unavailable',
                );
            }
        },
        async update<T>(model: StablePluginSettingsModel, operation: (
            current: unknown | null,
        ) => Readonly<{ record: CanonicalPluginSettingsRecord; result: T }>): Promise<T> {
            try {
                return await updatePluginStorageScopeValueAtomically({
                    scope: params.storageForPlugin(model.identity.pluginId),
                    key: PLUGIN_SETTINGS_STORAGE_KEY,
                    operation: (current) => {
                        const next = operation(current);
                        return Object.freeze({ value: next.record, result: next.result });
                    },
                });
            } catch (error) {
                if (isPluginError(error)) throw error;
                throw settingsError(
                    'plugin_settings_persistence_unavailable',
                    'Plugin settings persistence is unavailable',
                );
            }
        },
    });
}

export type PluginAccountSettingsRecordRead =
    | Readonly<{
        status: 'present';
        revision: number;
        values: Readonly<Record<string, JsonValue>>;
    }>
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'deleted'; revision: number }>
    | Readonly<{ status: 'unavailable' }>;

export type PluginAccountSettingsRecordWriteResult =
    | Readonly<{ status: 'updated'; revision: number }>
    | Readonly<{ status: 'conflict'; revision: number }>
    | Readonly<{ status: 'unavailable' }>;

export type PluginAccountSettingsRecordAdapter = Readonly<{
    readRecord(
        model: StablePluginSettingsModel,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginAccountSettingsRecordRead>;
    writeRecord(
        model: StablePluginSettingsModel,
        request: Readonly<{
            expectedRevision: number | 'absent';
            values: Readonly<Record<string, JsonValue>>;
        }>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginAccountSettingsRecordWriteResult>;
    watchRecord?(
        model: StablePluginSettingsModel,
        listener: (hint: Readonly<{ revision?: number }>) => void,
    ): () => void;
    isAvailable?(): boolean;
}>;

type AccountPluginSettingsRecordState = Readonly<{
    record: CanonicalPluginSettingsRecord;
    expectedRevision: number | 'absent';
}>;

function isAccountSettingsModel(model: StablePluginSettingsModel): boolean {
    return model.scope === 'account';
}

function settingsScopeRef(model: StablePluginSettingsModel): SettingsScopeRef {
    return Object.freeze({ kind: model.scope });
}

function assertAccountSettingsModel(model: StablePluginSettingsModel): void {
    if (!isAccountSettingsModel(model)) {
        throw settingsError(
            'plugin_settings_scope_unavailable',
            `Plugin settings scope '${model.scope}' has no bound account persistence owner`,
            { scope: model.scope },
        );
    }
}

async function readAccountPluginSettingsRecord(
    model: StablePluginSettingsModel,
    adapter: PluginAccountSettingsRecordAdapter,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<AccountPluginSettingsRecordState> {
    const source = await adapter.readRecord(model, options);
    if (source.status === 'unavailable') {
        throw settingsError(
            'plugin_settings_persistence_unavailable',
            'Account plugin settings persistence is unavailable',
        );
    }
    if (source.status === 'absent') {
        return Object.freeze({ record: emptyRecord(), expectedRevision: 'absent' });
    }
    if (source.status === 'deleted') {
        return Object.freeze({
            record: Object.freeze({
                t: SETTINGS_RECORD_TYPE,
                revision: source.revision,
                values: Object.freeze({}),
            }),
            expectedRevision: source.revision,
        });
    }
    return Object.freeze({
        record: validateRecordForModel(model, parseCanonicalPluginSettingsRecord({
            t: SETTINGS_RECORD_TYPE,
            revision: source.revision,
            values: source.values,
        })),
        expectedRevision: source.revision,
    });
}

function publishAccountPluginSettingsChange(
    model: StablePluginSettingsModel,
    previous: CanonicalPluginSettingsRecord,
    next: CanonicalPluginSettingsRecord,
    listener: (change: SettingsChange) => void,
): void {
    const changedIds = model.fields
        .filter((field) => field.descriptor.secret !== true)
        .filter((field) => !isDeepStrictEqual(
            previous.values[field.id],
            next.values[field.id],
        ))
        .map((field) => field.id)
        .sort();
    if (previous.revision === next.revision && changedIds.length === 0) return;
    listener(Object.freeze({
        scope: settingsScopeRef(model),
        revision: String(next.revision),
        changedIds: Object.freeze(changedIds),
        values: visibleValues(model, next),
    }));
}

/**
 * The Account model is one reserved `(accountId, pluginId)` record. Its
 * adapter owns HTTP/envelope/CAS mechanics; this owner keeps field validation,
 * defaults, revisions, and watch projection out of the host preference blob.
 */
export function createAccountSettingsBackedSettingsRecordStore(
    adapter: PluginAccountSettingsRecordAdapter,
): StablePluginSettingsRecordStore {
    return Object.freeze({
        supports(model) {
            return isAccountSettingsModel(model) && (adapter.isAvailable?.() ?? true);
        },
        async read(model, options): Promise<unknown | null> {
            assertAccountSettingsModel(model);
            return (await readAccountPluginSettingsRecord(model, adapter, options)).record;
        },
        async update<T>(
            model: StablePluginSettingsModel,
            operation: (
                current: unknown | null,
            ) => Readonly<{ record: CanonicalPluginSettingsRecord; result: T }>,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<T> {
            assertAccountSettingsModel(model);
            const current = await readAccountPluginSettingsRecord(model, adapter, options);
            const next = operation(current.record);
            const record = validateRecordForModel(
                model,
                parseCanonicalPluginSettingsRecord(next.record),
            );
            const response = await adapter.writeRecord(
                model,
                {
                    expectedRevision: current.expectedRevision,
                    values: record.values,
                },
                options,
            );
            if (response.status === 'unavailable') {
                throw settingsError(
                    'plugin_settings_persistence_unavailable',
                    'Account plugin settings persistence is unavailable',
                );
            }
            if (response.status === 'conflict') {
                throw settingsError(
                    'plugin_settings_revision_conflict',
                    'Plugin settings revision does not match the current Account revision',
                    { currentRevision: String(response.revision) },
                );
            }
            if (response.revision !== record.revision) {
                throw settingsError(
                    'plugin_settings_persistence_unavailable',
                    'Account plugin settings write returned an inconsistent revision',
                );
            }
            return next.result;
        },
        watch(model, listener): Disposable {
            if (!isAccountSettingsModel(model) || !adapter.watchRecord) {
                return Object.freeze({ dispose() {} });
            }
            let closed = false;
            let previous: CanonicalPluginSettingsRecord | null = null;
            let serial = Promise.resolve();
            const baseline = readAccountPluginSettingsRecord(model, adapter)
                .then((state) => {
                    previous = state.record;
                })
                .catch(() => undefined);
            const refresh = (): void => {
                serial = serial.then(async () => {
                    await baseline;
                    if (closed) return;
                    try {
                        const next = (await readAccountPluginSettingsRecord(model, adapter)).record;
                        const before = previous ?? emptyRecord();
                        if (next.revision < before.revision) return;
                        previous = next;
                        publishAccountPluginSettingsChange(model, before, next, listener);
                    } catch {
                        // A content-free hint never carries a safe fallback value.
                    }
                });
            };
            const unsubscribe = adapter.watchRecord(model, () => refresh());
            return Object.freeze({
                dispose() {
                    if (closed) return;
                    closed = true;
                    unsubscribe();
                },
            });
        },
    });
}

export function createRoutedPluginSettingsRecordStore(
    stores: readonly StablePluginSettingsRecordStore[],
): StablePluginSettingsRecordStore {
    function resolve(model: StablePluginSettingsModel): StablePluginSettingsRecordStore {
        const store = stores.find((candidate) => candidate.supports?.(model) === true);
        if (!store) {
            throw settingsError(
                'plugin_settings_scope_unavailable',
                `Plugin settings scope '${model.scope}' has no bound daemon persistence owner`,
                { scope: model.scope },
            );
        }
        return store;
    }
    return Object.freeze({
        supports(model) {
            return stores.some((store) => store.supports?.(model) === true);
        },
        read(model, options) {
            return resolve(model).read(model, options);
        },
        update(model, operation, options) {
            return resolve(model).update(model, operation, options);
        },
        watch(model, listener) {
            return resolve(model).watch?.(model, listener)
                ?? Object.freeze({ dispose() {} });
        },
    });
}

function emptyRecord(): CanonicalPluginSettingsRecord {
    return Object.freeze({ t: SETTINGS_RECORD_TYPE, revision: 0, values: Object.freeze({}) });
}

export function parseCanonicalPluginSettingsRecord(value: unknown): CanonicalPluginSettingsRecord {
    if (value === null) return emptyRecord();
    const plain = clonePlainData(value, 'settingsRecord');
    if (!plain || typeof plain !== 'object' || Array.isArray(plain)) {
        throw settingsError('plugin_settings_record_invalid', 'Plugin settings record is invalid');
    }
    const record = plain as Readonly<Record<string, unknown>>;
    const recordKeys = Object.keys(record);
    const isEnvelope = record.t === SETTINGS_RECORD_TYPE
        && Object.prototype.hasOwnProperty.call(record, 'revision')
        && Object.prototype.hasOwnProperty.call(record, 'values');
    if (!isEnvelope) {
        throw settingsError(
            'plugin_settings_record_invalid',
            'Plugin settings record is invalid',
        );
    }
    if (record.t !== SETTINGS_RECORD_TYPE
        || recordKeys.some((key) => !['t', 'revision', 'values'].includes(key))
        || !Number.isSafeInteger(record.revision)
        || (record.revision as number) < 0
        || !record.values
        || typeof record.values !== 'object'
        || Array.isArray(record.values)) {
        throw settingsError('plugin_settings_record_invalid', 'Plugin settings record is invalid');
    }
    return Object.freeze({
        t: SETTINGS_RECORD_TYPE,
        revision: record.revision as number,
        values: clonePlainData(record.values) as Readonly<Record<string, JsonValue>>,
    });
}

function assertCurrent(seed: PluginInvocationServicesSeed, signal?: AbortSignal): void {
    if (signal?.aborted || seed.signal.aborted || !seed.isGenerationCurrent()) {
        throw settingsError(
            'plugin_settings_generation_retired',
            'Plugin settings invocation generation is no longer current',
        );
    }
}

function fieldOrThrow(model: StablePluginSettingsModel, id: string): StablePluginSettingsField {
    const field = model.fields.find((candidate) => candidate.id === id);
    if (!field) {
        throw settingsError(
            'plugin_settings_unknown_id',
            `Plugin setting '${model.identity.qualifiedId}/fields/${id}' is not declared`,
        );
    }
    return field;
}

function validateFieldValue(model: StablePluginSettingsModel, id: string, value: JsonValue): boolean {
    const validate = validatorsByModel.get(model)?.get(id);
    if (!validate) {
        throw settingsError(
            'plugin_settings_model_invalid',
            `Plugin settings model '${model.identity.qualifiedId}' has no validator for '${id}'`,
        );
    }
    return isValidPluginJsonSchemaValue(validate, value)
        && (perActiveServerMapFieldIdsByModel.get(model)?.has(id) !== true
            || isBoundedPluginPerActiveServerValueV1(value));
}

function assertExpectedRevision(record: CanonicalPluginSettingsRecord, expectedRevision?: string): void {
    if (expectedRevision !== undefined && expectedRevision !== String(record.revision)) {
        throw settingsError(
            'plugin_settings_revision_conflict',
            'Plugin settings revision does not match the current daemon revision',
            { currentRevision: String(record.revision) },
        );
    }
}

function visibleValues(
    model: StablePluginSettingsModel,
    record: CanonicalPluginSettingsRecord,
): Readonly<Record<string, JsonValue>> {
    const values: Record<string, JsonValue> = {};
    for (const [id, value] of Object.entries(record.values)) {
        const field = model.fields.find((candidate) => candidate.id === id);
        if (field && field.descriptor.secret !== true) values[id] = clonePlainData(value);
    }
    return Object.freeze(values);
}

function validateRecordForModel(
    model: StablePluginSettingsModel,
    record: CanonicalPluginSettingsRecord,
): CanonicalPluginSettingsRecord {
    for (const [id, value] of Object.entries(record.values)) {
        const field = model.fields.find((candidate) => candidate.id === id);
        if (!field || field.descriptor.secret === true || !validateFieldValue(model, id, value)) {
            throw settingsError(
                'plugin_settings_record_invalid',
                `Plugin settings record '${model.identity.qualifiedId}' contains an invalid field value`,
            );
        }
    }
    return record;
}

function assertSupportedScope(
    model: StablePluginSettingsModel,
    store: StablePluginSettingsRecordStore,
): void {
    if (store.supports?.(model) !== true) {
        throw settingsError(
            'plugin_settings_scope_unavailable',
            `Plugin settings scope '${model.scope}' has no bound daemon persistence owner`,
            { scope: model.scope },
        );
    }
}

export function createStablePluginSettingsOwner(params: Readonly<{
    recordStore: StablePluginSettingsRecordStore;
    broker: StablePluginEventsBroker;
}>) {
    return Object.freeze({
        async applyActionPatch(input: Readonly<{
            model: StablePluginSettingsModel;
            seed: PluginInvocationServicesSeed;
            contributionId: string;
            allowedFieldIds: readonly string[];
            patch: Readonly<Record<string, JsonValue>>;
            expectedRevision?: string;
            signal?: AbortSignal;
        }>): Promise<Readonly<{
            scope: SettingsScopeRef;
            revision: string;
            changedIds: readonly string[];
            values: Readonly<Record<string, JsonValue>>;
        }>> {
            const { model, seed } = input;
            assertSupportedScope(model, params.recordStore);
            assertCurrent(seed, input.signal);
            const patch = clonePlainData(input.patch, 'settingsActionPatch');
            const changedIds = Object.keys(patch).sort();
            if (changedIds.length === 0 || changedIds.length > MAX_SETTINGS_ACTION_PATCH_FIELDS) {
                throw settingsError(
                    'plugin_settings_action_patch_bounded',
                    'Plugin settings action patch must contain between 1 and 16 fields',
                );
            }
            if (Buffer.byteLength(JSON.stringify(patch), 'utf8') > MAX_SETTINGS_ACTION_PATCH_BYTES) {
                throw settingsError(
                    'plugin_settings_action_patch_bounded',
                    'Plugin settings action patch exceeds the canonical JSON byte limit',
                );
            }
            const allowedIds = new Set(input.allowedFieldIds);
            for (const id of changedIds) {
                const field = fieldOrThrow(model, id);
                if (field.contributionId !== input.contributionId
                    || field.descriptor.secret === true
                    || !allowedIds.has(id)) {
                    throw settingsError(
                        'plugin_settings_action_patch_forbidden',
                        `Plugin settings action cannot patch '${field.qualifiedId}'`,
                    );
                }
                if (!validateFieldValue(model, id, patch[id]!)) {
                    throw settingsError(
                        'plugin_settings_validation_failed',
                        `Plugin setting '${field.qualifiedId}' failed schema validation`,
                    );
                }
            }
            const change = await params.recordStore.update(model, (raw) => {
                assertCurrent(seed, input.signal);
                const record = validateRecordForModel(model, parseCanonicalPluginSettingsRecord(raw));
                assertExpectedRevision(record, input.expectedRevision);
                const nextRevision = record.revision + 1;
                if (!Number.isSafeInteger(nextRevision)) {
                    throw settingsError('plugin_settings_revision_exhausted', 'Plugin settings revision is exhausted');
                }
                const values = { ...record.values, ...patch };
                const next = Object.freeze({
                    t: SETTINGS_RECORD_TYPE,
                    revision: nextRevision,
                    values: Object.freeze(values),
                });
                return Object.freeze({
                    record: next,
                    result: Object.freeze({
                        scope: settingsScopeRef(model),
                        revision: String(nextRevision),
                        changedIds: Object.freeze(changedIds),
                        values: visibleValues(model, next),
                    }),
                });
            }, { signal: input.signal });
            assertCurrent(seed, input.signal);
            await params.broker.emit({
                event: {
                    ref: SETTINGS_CHANGED_REF,
                    payload: {
                        settings: { pluginId: model.identity.pluginId, scope: model.scope },
                        revision: change.revision,
                        changedIds: change.changedIds,
                        values: change.values,
                    },
                },
                identity: Object.freeze({
                    pluginId: seed.plugin.id,
                    pluginVersion: seed.plugin.version,
                    contributionId: seed.contribution.id,
                    contributionQualifiedId: seed.contribution.qualifiedId,
                    generation: seed.generation,
                    correlationId: seed.correlationId,
                    surface: seed.surface,
                }),
            }).catch(() => undefined);
            return change;
        },
        bind(binding: Readonly<{
            model: StablePluginSettingsModel;
            seed: PluginInvocationServicesSeed;
        }>): ScopedSettingsService {
            const { model, seed } = binding;
            const eventIdentity = Object.freeze({
                pluginId: seed.plugin.id,
                pluginVersion: seed.plugin.version,
                contributionId: seed.contribution.id,
                contributionQualifiedId: seed.contribution.qualifiedId,
                generation: seed.generation,
                correlationId: seed.correlationId,
                surface: seed.surface,
            });

            async function read(signal?: AbortSignal): Promise<CanonicalPluginSettingsRecord> {
                assertSupportedScope(model, params.recordStore);
                assertCurrent(seed, signal);
                const record = validateRecordForModel(
                    model,
                    parseCanonicalPluginSettingsRecord(await params.recordStore.read(model, { signal })),
                );
                assertCurrent(seed, signal);
                return record;
            }

            async function mutate(input: Readonly<{
                id: string;
                expectedRevision?: string;
                signal?: AbortSignal;
                reset: boolean;
                value?: JsonValue;
            }>): Promise<Readonly<{ scope: SettingsScopeRef; revision: string }>> {
                assertSupportedScope(model, params.recordStore);
                assertCurrent(seed, input.signal);
                const field = fieldOrThrow(model, input.id);
                if (field.descriptor.secret === true) {
                    throw settingsError(
                        'plugin_settings_secret_materialization_required',
                        `Plugin setting '${field.qualifiedId}' is owned by services.secrets`,
                    );
                }
                const normalizedValue = input.reset ? undefined : clonePlainData(input.value, 'settingValue');
                if (!input.reset && !validateFieldValue(model, input.id, normalizedValue!)) {
                    throw settingsError(
                        'plugin_settings_validation_failed',
                        `Plugin setting '${field.qualifiedId}' failed schema validation`,
                    );
                }
                const change = await params.recordStore.update(model, (raw) => {
                    assertCurrent(seed, input.signal);
                    const record = validateRecordForModel(model, parseCanonicalPluginSettingsRecord(raw));
                    assertExpectedRevision(record, input.expectedRevision);
                    const nextRevision = record.revision + 1;
                    if (!Number.isSafeInteger(nextRevision)) {
                        throw settingsError('plugin_settings_revision_exhausted', 'Plugin settings revision is exhausted');
                    }
                    const values = { ...record.values };
                    if (input.reset) delete values[input.id];
                    else values[input.id] = normalizedValue!;
                    const visible = Object.freeze({ ...values });
                    if (Buffer.byteLength(JSON.stringify(visible), 'utf8') > MAX_SETTINGS_EVENT_VALUE_BYTES) {
                        throw settingsError(
                            'plugin_settings_values_too_large',
                            'Plugin settings values exceed the daemon change-event limit',
                        );
                    }
                    const next = Object.freeze({
                        t: SETTINGS_RECORD_TYPE,
                        revision: nextRevision,
                        values: Object.freeze(values),
                    });
                    return Object.freeze({
                        record: next,
                        result: Object.freeze({
                            scope: settingsScopeRef(model),
                            revision: String(nextRevision),
                            changedIds: Object.freeze([input.id]),
                            values: visibleValues(model, next),
                        }),
                    });
                }, { signal: input.signal });
                // Plugin events are daemon-local and non-durable. Persistence remains authoritative
                // when transient broker backpressure prevents this at-most-once notification.
                await params.broker.emit({
                    event: {
                        ref: SETTINGS_CHANGED_REF,
                        payload: {
                        settings: { pluginId: model.identity.pluginId, scope: model.scope },
                            revision: change.revision,
                            changedIds: change.changedIds,
                            values: change.values,
                        },
                    },
                    identity: eventIdentity,
                }).catch(() => undefined);
                return Object.freeze({ scope: settingsScopeRef(model), revision: change.revision });
            }

            const service: ScopedSettingsService = {
                async snapshot(options?: { signal?: AbortSignal }) {
                    const record = await read(options?.signal);
                    return Object.freeze({
                        scope: settingsScopeRef(model),
                        revision: String(record.revision),
                        values: visibleValues(model, record),
                    });
                },
                async get<T extends JsonValue = JsonValue>(id: string, options?: { signal?: AbortSignal }) {
                    const field = fieldOrThrow(model, id);
                    if (field.descriptor.secret === true) {
                        throw settingsError(
                            'plugin_settings_secret_materialization_required',
                            `Plugin setting '${field.qualifiedId}' is owned by services.secrets`,
                        );
                    }
                    const record = await read(options?.signal);
                    if (Object.prototype.hasOwnProperty.call(record.values, id)) {
                        return clonePlainData(record.values[id]) as T;
                    }
                    return field.descriptor.default === undefined
                        ? null
                        : clonePlainData(field.descriptor.default) as T;
                },
                async set(
                    id: string,
                    value: JsonValue,
                    options?: { expectedRevision?: string; signal?: AbortSignal },
                ) {
                    return await mutate({ id, value, reset: false, ...options });
                },
                async reset(id: string, options?: { expectedRevision?: string; signal?: AbortSignal }) {
                    return await mutate({ id, reset: true, ...options });
                },
                describe() {
                    assertCurrent(seed);
                    return model.descriptors;
                },
                watch(listener: (change: SettingsChange) => void) {
                    assertSupportedScope(model, params.recordStore);
                    assertCurrent(seed);
                    let lastDeliveredRevision: string | null = null;
                    const deliver = (change: SettingsChange): void => {
                        if (change.scope.kind !== model.scope) return;
                        if (lastDeliveredRevision === change.revision) return;
                        lastDeliveredRevision = change.revision;
                        listener(change);
                    };
                    const subscription = params.broker.subscribe({
                        ref: SETTINGS_CHANGED_REF,
                        identity: eventIdentity,
                        isCurrent: () => !seed.signal.aborted && seed.isGenerationCurrent(),
                        listener(event) {
                            const payload = event.payload;
                            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
                            const settings = Reflect.get(payload, 'settings');
                            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
                            if (Reflect.get(settings, 'pluginId') !== model.identity.pluginId
                                || Reflect.get(settings, 'scope') !== model.scope) return;
                            const revision = Reflect.get(payload, 'revision');
                            const changedIds = Reflect.get(payload, 'changedIds');
                            const values = Reflect.get(payload, 'values');
                            if (typeof revision !== 'string'
                                || !Array.isArray(changedIds)
                                || !changedIds.every((id) => typeof id === 'string')
                                || !values
                                || typeof values !== 'object'
                                || Array.isArray(values)) return;
                            deliver(Object.freeze({
                                scope: settingsScopeRef(model),
                                revision,
                                changedIds: Object.freeze([...changedIds]),
                                values: clonePlainData(values) as SettingsChange['values'],
                            }));
                        },
                    });
                    const externalSubscription = params.recordStore.watch?.(model, deliver);
                    let disposed = false;
                    const dispose = (): void | Promise<void> => {
                        if (disposed) return;
                        disposed = true;
                        seed.signal.removeEventListener('abort', abort);
                        const brokerResult = subscription.dispose();
                        const externalResult = externalSubscription?.dispose();
                        if (brokerResult instanceof Promise || externalResult instanceof Promise) {
                            return Promise.all([brokerResult, externalResult]).then(() => undefined);
                        }
                    };
                    const abort = (): void => {
                        const result = dispose();
                        if (result instanceof Promise) void result.catch(() => undefined);
                    };
                    seed.signal.addEventListener('abort', abort, { once: true });
                    if (seed.signal.aborted) abort();
                    return Object.freeze({ dispose });
                },
            };
            return Object.freeze(service);
        },
    });
}

export type StablePluginSettingsHost = Readonly<{
    hasPlugin(pluginId: string): boolean;
    bind(seed: PluginInvocationServicesSeed): SettingsService | null;
}>;

function unavailableScopedSettingsService(
    scope: string,
): ScopedSettingsService {
    const unavailable = (): never => {
        throw settingsError(
            'plugin_settings_scope_unavailable',
            `Plugin settings scope '${scope}' has no bound persistence owner`,
            { scope },
        );
    };
    return Object.freeze({
        snapshot: unavailable,
        get: unavailable,
        set: unavailable,
        reset: unavailable,
        describe: unavailable,
        watch: unavailable,
    });
}

function readSettingsScope(ref: SettingsScopeRef): StablePluginSettingsScope | null {
    return ref?.kind === 'account' || ref?.kind === 'daemon' ? ref.kind : null;
}

export function createStablePluginSettingsHost(params: Readonly<{
    declarations: readonly Readonly<{
        pluginId: string;
        contribution: PluginSettingsContributionV2;
    }>[];
    recordStore: StablePluginSettingsRecordStore;
    broker: StablePluginEventsBroker;
    /**
     * Reports a plugin whose declared settings this host could not model, so the
     * caller can tell the operator which plugin lost its Settings service. The
     * host itself owns no logging channel. A caller whose declaration set covers
     * a single plugin can rethrow to keep the precise authoring error.
     */
    onPluginSettingsUnavailable?(input: Readonly<{ pluginId: string; error: unknown }>): void;
}>): StablePluginSettingsHost {
    const declarationsByPluginId = new Map<string, PluginSettingsContributionV2[]>();
    for (const declaration of params.declarations) {
        const existing = declarationsByPluginId.get(declaration.pluginId) ?? [];
        existing.push(declaration.contribution);
        declarationsByPluginId.set(declaration.pluginId, existing);
    }
    const modelsByPluginId = new Map<string, ReturnType<typeof createStablePluginSettingsModels>>();
    for (const [pluginId, contributions] of declarationsByPluginId) {
        try {
            modelsByPluginId.set(pluginId, createStablePluginSettingsModels({ pluginId, contributions }));
        } catch (error) {
            // One plugin's unmodellable settings declaration must not deny every
            // other plugin its Settings service. Omitting the plugin is strictly
            // more closed than admitting a partially modelled one: `hasPlugin`
            // reports false and `bind` returns null, so no read, write, or patch
            // path can reach an unvalidated field.
            params.onPluginSettingsUnavailable?.({ pluginId, error });
        }
    }
    const owner = createStablePluginSettingsOwner({ recordStore: params.recordStore, broker: params.broker });
    return Object.freeze({
        hasPlugin(pluginId) {
            return modelsByPluginId.has(pluginId);
        },
        bind(seed) {
            const models = modelsByPluginId.get(seed.plugin.id);
            if (!models) return null;
            return Object.freeze({
                forScope(scopeRef: SettingsScopeRef): ScopedSettingsService {
                    const scope = readSettingsScope(scopeRef);
                    if (!scope) return unavailableScopedSettingsService('invalid');
                    const model = models.get(scope);
                    return model && params.recordStore.supports?.(model) === true
                        ? owner.bind({ model, seed })
                        : unavailableScopedSettingsService(scope);
                },
            });
        },
    });
}
