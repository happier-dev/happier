import type { ValidateFunction } from 'ajv';
import { isDeepStrictEqual } from 'node:util';

import {
    PluginIdSchema,
    PluginSettingsContributionV2Schema,
    type PluginSettingFieldV2,
    type PluginSettingsContributionV2,
} from '@happier-dev/protocol';
import { PluginError, type Disposable, type JsonValue } from '@happier-dev/plugin-sdk';
import { type PluginSettingDescriptor, type PluginSettingsChange, type PluginSettingsService } from '@happier-dev/plugin-sdk/runtime';

import type { StablePluginEventsBroker } from './events';
import { clonePluginPlainData } from '../../plainData';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from './jsonSchemaValidation';
import type { PluginInvocationServicesSeed } from './types';
import {
    PLUGIN_HOST_STORAGE_KEY_PREFIX,
    updatePluginStorageScopeValueAtomically,
    type PluginStorageOwnerScope,
} from '../../context/storage';

export const PLUGIN_SETTINGS_STORAGE_KEY = `${PLUGIN_HOST_STORAGE_KEY_PREFIX}settings/v1`;
const SETTINGS_RECORD_TYPE = 'happier_plugin_settings_record_v1';
const MAX_SETTINGS_EVENT_VALUE_BYTES = 512 * 1024;
const MAX_SETTINGS_PLAIN_DATA_DEPTH = 64;
const MAX_SETTINGS_PLAIN_DATA_NODES = 32_768;
const MAX_SETTINGS_PLAIN_DATA_STRING_BYTES = MAX_SETTINGS_EVENT_VALUE_BYTES + (256 * 1024);
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
    descriptor: PluginSettingDescriptor;
}>;

export type StablePluginSettingsModel = Readonly<{
    identity: StablePluginSettingsIdentity;
    scope: PluginSettingsContributionV2['scope'];
    descriptors: readonly PluginSettingDescriptor[];
    fields: readonly StablePluginSettingsField[];
}>;

const validatorsByModel = new WeakMap<object, ReadonlyMap<string, ValidateFunction>>();

export type StablePluginSettingsRecordStore = Readonly<{
    supports?(model: StablePluginSettingsModel): boolean;
    read(model: StablePluginSettingsModel): Promise<unknown | null>;
    update<T>(
        model: StablePluginSettingsModel,
        operation: (current: unknown | null) => Readonly<{ record: CanonicalPluginSettingsRecord; result: T }>,
    ): Promise<T>;
    watch?(
        model: StablePluginSettingsModel,
        listener: (change: PluginSettingsChange) => void,
    ): Disposable;
}>;

function settingsError(code: string, message: string, details?: JsonValue): PluginError {
    return new PluginError({ code, message, ...(details === undefined ? {} : { details }) });
}

function clonePlainData<T>(value: T, path = 'value'): T {
    return clonePluginPlainData(value, {
        path,
        limits: {
            maxDepth: MAX_SETTINGS_PLAIN_DATA_DEPTH,
            maxNodes: MAX_SETTINGS_PLAIN_DATA_NODES,
            maxStringBytes: MAX_SETTINGS_PLAIN_DATA_STRING_BYTES,
        },
        invalid: (message) => settingsError('plugin_settings_invalid_plain_data', message),
        limitExceeded: (message) => settingsError('plugin_settings_plain_data_bounded', message),
    });
}

function localizedText(value: string | Readonly<{ key: string; fallback: string }>): string {
    return typeof value === 'string' ? value : value.fallback;
}

function normalizeTarget(
    pluginId: string,
    target: PluginSettingsContributionV2['target'],
): PluginSettingDescriptor['target'] {
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
): PluginSettingDescriptor {
    const base = {
        id: field.id,
        title: localizedText(field.title),
        ...(field.description ? { description: localizedText(field.description) } : {}),
        target: normalizeTarget(pluginId, contribution.target),
        scope: contribution.scope,
        // The protocol schema validates every schema leaf as JSON before this narrow bridge.
        schema: clonePlainData(field.schema) as JsonValue,
    };
    return field.secret === true
        ? Object.freeze({ ...base, secret: true as const })
        : Object.freeze({
            ...base,
            ...(field.default === undefined ? {} : { default: clonePlainData(field.default) }),
        });
}

function qualifiedSettingsId(pluginId: string): string {
    return `${pluginId}/settings`;
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
        qualifiedId: qualifiedSettingsId(pluginId),
    });
    const validators = new Map<string, ValidateFunction>();
    const fields = contributions.flatMap((contribution) => contribution.fields.map((field): StablePluginSettingsField => {
        const qualifiedId = qualifiedSettingsFieldId(identity, contribution.id, field.id);
        if (validators.has(field.id)) {
            throw settingsError(
                'plugin_settings_field_id_conflict',
                `Plugin setting '${field.id}' is declared by multiple settings contributions for '${pluginId}'`,
            );
        }
        let validate: ValidateFunction;
        try {
            validate = compilePluginJsonSchema(field.schema);
        } catch {
            throw settingsError(
                'plugin_settings_invalid_schema',
                `Plugin setting '${qualifiedId}' has an invalid schema`,
            );
        }
        if (field.secret !== true && field.default !== undefined && !isValidPluginJsonSchemaValue(validate, field.default)) {
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
    return model;
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
    return validator(clonePlainData(value, 'settingValue')) === true;
}

export function createPluginStorageBackedSettingsRecordStore(params: Readonly<{
    storageForPlugin(pluginId: string): PluginStorageOwnerScope;
    scope?: PluginSettingsContributionV2['scope'];
    isAvailable?(): boolean;
}>): StablePluginSettingsRecordStore {
    const supportedScope = params.scope ?? 'local';
    return Object.freeze({
        supports(model) {
            return model.scope === supportedScope && (params.isAvailable?.() ?? true);
        },
        async read(model): Promise<unknown | null> {
            try {
                return await params.storageForPlugin(model.identity.pluginId).get(PLUGIN_SETTINGS_STORAGE_KEY);
            } catch (error) {
                if (error instanceof PluginError) throw error;
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
                if (error instanceof PluginError) throw error;
                throw settingsError(
                    'plugin_settings_persistence_unavailable',
                    'Plugin settings persistence is unavailable',
                );
            }
        },
    });
}

export const PLUGIN_SETTINGS_ACCOUNT_STATE_KEY = 'pluginSettingsStateV1';

type PluginSettingsAccountState = Readonly<{
    t: typeof SETTINGS_RECORD_TYPE;
    revision: number;
}>;

function isSyncedAgentSettingsModel(model: StablePluginSettingsModel): boolean {
    return model.scope === 'synced'
        && model.descriptors.length > 0
        && model.descriptors.every((descriptor) => descriptor.target.kind === 'agent');
}

function accountSettingsRecord(
    model: StablePluginSettingsModel,
    settings: Readonly<Record<string, unknown>>,
): CanonicalPluginSettingsRecord {
    const stateByPlugin = settings[PLUGIN_SETTINGS_ACCOUNT_STATE_KEY];
    const candidateState = stateByPlugin
        && typeof stateByPlugin === 'object'
        && !Array.isArray(stateByPlugin)
        ? Reflect.get(stateByPlugin, model.identity.pluginId)
        : undefined;
    const state = candidateState === undefined
        ? { t: SETTINGS_RECORD_TYPE, revision: 0 }
        : candidateState;
    const values: Record<string, JsonValue> = {};
    for (const field of model.fields) {
        if (field.descriptor.secret === true) continue;
        if (Object.prototype.hasOwnProperty.call(settings, field.id)) {
            values[field.id] = clonePlainData(settings[field.id], `accountSettings.${field.id}`) as JsonValue;
        }
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw settingsError('plugin_settings_record_invalid', 'Plugin settings account revision state is invalid');
    }
    return parseCanonicalPluginSettingsRecord({
        ...(state as Readonly<Record<string, unknown>>),
        values,
    });
}

function accountStateForRecord(record: CanonicalPluginSettingsRecord): PluginSettingsAccountState {
    return Object.freeze({
        t: SETTINGS_RECORD_TYPE,
        revision: record.revision,
    });
}

export function createAccountSettingsBackedSettingsRecordStore(params: Readonly<{
    readSettings(): Readonly<Record<string, unknown>> | null | Promise<Readonly<Record<string, unknown>> | null>;
    isAvailable?(): boolean;
    subscribeSettings?(
        listener: (
            previous: Readonly<Record<string, unknown>> | null,
            next: Readonly<Record<string, unknown>>,
        ) => void,
    ): () => void;
    updateSettings(
        mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>,
    ): Promise<Readonly<Record<string, unknown>>>;
}>): StablePluginSettingsRecordStore {
    return Object.freeze({
        supports(model) {
            return isSyncedAgentSettingsModel(model) && (params.isAvailable?.() ?? true);
        },
        async read(model): Promise<unknown | null> {
            if (!isSyncedAgentSettingsModel(model)) {
                throw settingsError(
                    'plugin_settings_scope_unavailable',
                    `Plugin settings scope '${model.scope}' has no bound account persistence owner`,
                    { scope: model.scope },
                );
            }
            const settings = await params.readSettings();
            if (!settings) {
                throw settingsError(
                    'plugin_settings_persistence_unavailable',
                    'Synced Agent settings require an active account settings snapshot',
                );
            }
            return accountSettingsRecord(model, settings);
        },
        async update<T>(
            model: StablePluginSettingsModel,
            operation: (
                current: unknown | null,
            ) => Readonly<{ record: CanonicalPluginSettingsRecord; result: T }>,
        ): Promise<T> {
            if (!isSyncedAgentSettingsModel(model)) {
                throw settingsError(
                    'plugin_settings_scope_unavailable',
                    `Plugin settings scope '${model.scope}' has no bound account persistence owner`,
                    { scope: model.scope },
                );
            }
            let result: T | undefined;
            let operated = false;
            await params.updateSettings((settings) => {
                const current = accountSettingsRecord(model, settings);
                const next = operation(current);
                result = next.result;
                operated = true;
                const output: Record<string, unknown> = { ...settings };
                for (const field of model.fields) {
                    if (field.descriptor.secret === true) continue;
                    if (Object.prototype.hasOwnProperty.call(next.record.values, field.id)) {
                        output[field.id] = clonePlainData(next.record.values[field.id], `settings.${field.id}`);
                    } else {
                        delete output[field.id];
                    }
                }
                const currentStateByPlugin = settings[PLUGIN_SETTINGS_ACCOUNT_STATE_KEY];
                const stateByPlugin = currentStateByPlugin
                    && typeof currentStateByPlugin === 'object'
                    && !Array.isArray(currentStateByPlugin)
                    ? { ...(currentStateByPlugin as Readonly<Record<string, unknown>>) }
                    : {};
                stateByPlugin[model.identity.pluginId] = accountStateForRecord(next.record);
                output[PLUGIN_SETTINGS_ACCOUNT_STATE_KEY] = stateByPlugin;
                return output;
            });
            if (!operated) {
                throw settingsError(
                    'plugin_settings_persistence_unavailable',
                    'Synced Agent settings update did not reach the account settings owner',
                );
            }
            return result as T;
        },
        watch(model, listener): Disposable {
            if (!isSyncedAgentSettingsModel(model) || !params.subscribeSettings) {
                return Object.freeze({ dispose() {} });
            }
            const unsubscribe = params.subscribeSettings((previousSettings, nextSettings) => {
                try {
                    const previous = previousSettings
                        ? validateRecordForModel(model, accountSettingsRecord(model, previousSettings))
                        : emptyRecord();
                    const next = validateRecordForModel(model, accountSettingsRecord(model, nextSettings));
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
                        revision: String(next.revision),
                        changedIds: Object.freeze(changedIds),
                        values: visibleValues(model, next),
                    }));
                } catch {
                    // Corrupt synced state remains fail-closed on the next direct read.
                }
            });
            return Object.freeze({ dispose: unsubscribe });
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
        read(model) {
            return resolve(model).read(model);
        },
        update(model, operation) {
            return resolve(model).update(model, operation);
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
        return Object.freeze({
            t: SETTINGS_RECORD_TYPE,
            revision: 0,
            values: clonePlainData(record) as Readonly<Record<string, JsonValue>>,
        });
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
    return isValidPluginJsonSchemaValue(validate, value);
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
        bind(binding: Readonly<{
            model: StablePluginSettingsModel;
            seed: PluginInvocationServicesSeed;
        }>): PluginSettingsService {
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
                    parseCanonicalPluginSettingsRecord(await params.recordStore.read(model)),
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
            }>): Promise<{ revision: string }> {
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
                            revision: String(nextRevision),
                            changedIds: Object.freeze([input.id]),
                            values: visibleValues(model, next),
                        }),
                    });
                });
                // Plugin events are daemon-local and non-durable. Persistence remains authoritative
                // when transient broker backpressure prevents this at-most-once notification.
                await params.broker.emit({
                    event: {
                        ref: SETTINGS_CHANGED_REF,
                        payload: {
                            settings: { pluginId: model.identity.pluginId },
                            revision: change.revision,
                            changedIds: change.changedIds,
                            values: change.values,
                        },
                    },
                    identity: eventIdentity,
                }).catch(() => undefined);
                return Object.freeze({ revision: change.revision });
            }

            const service: PluginSettingsService = {
                async snapshot(options?: { signal?: AbortSignal }) {
                    const record = await read(options?.signal);
                    return Object.freeze({
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
                watch(listener: (change: PluginSettingsChange) => void) {
                    assertSupportedScope(model, params.recordStore);
                    assertCurrent(seed);
                    let lastDeliveredRevision: string | null = null;
                    const deliver = (change: PluginSettingsChange): void => {
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
                            if (Reflect.get(settings, 'pluginId') !== model.identity.pluginId) return;
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
                                revision,
                                changedIds: Object.freeze([...changedIds]),
                                values: clonePlainData(values) as PluginSettingsChange['values'],
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
    bind(seed: PluginInvocationServicesSeed): PluginSettingsService | null;
}>;

export function createStablePluginSettingsHost(params: Readonly<{
    declarations: readonly Readonly<{
        pluginId: string;
        contribution: PluginSettingsContributionV2;
    }>[];
    recordStore: StablePluginSettingsRecordStore;
    broker: StablePluginEventsBroker;
}>): StablePluginSettingsHost {
    const declarationsByPluginId = new Map<string, PluginSettingsContributionV2[]>();
    for (const declaration of params.declarations) {
        const existing = declarationsByPluginId.get(declaration.pluginId) ?? [];
        existing.push(declaration.contribution);
        declarationsByPluginId.set(declaration.pluginId, existing);
    }
    const modelsByPluginId = new Map(
        [...declarationsByPluginId].map(([pluginId, contributions]) => [
            pluginId,
            createStablePluginSettingsModel({ pluginId, contributions }),
        ]),
    );
    const owner = createStablePluginSettingsOwner({ recordStore: params.recordStore, broker: params.broker });
    return Object.freeze({
        hasPlugin(pluginId) {
            return modelsByPluginId.has(pluginId);
        },
        bind(seed) {
            const model = modelsByPluginId.get(seed.plugin.id);
            return model && params.recordStore.supports?.(model) === true
                ? owner.bind({ model, seed })
                : null;
        },
    });
}
