import {
    createStablePluginSettingsModel as createProtocolSettingsModel,
    createStablePluginSettingsModels as createProtocolSettingsModels,
    PluginUiDeclarationProjectionErrorV1,
    type StablePluginSettingsField,
    type StablePluginSettingsModel,
    type StablePluginSettingsScope,
} from '@happier-dev/protocol/plugins/contributions/ui/settingsDescriptors';
import { readReleasedFlatPluginSettingValue } from '@happier-dev/protocol/account/settings/releasedFlatPluginSettings';
import { PluginAccountSettingsValuesV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { isBoundedPluginPerActiveServerValueV1 } from '@happier-dev/protocol/plugins/contributions/settings';
import type { PluginJsonSchemaValidator, PluginSettingsContributionV2 } from '@happier-dev/protocol';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { containsEquivalentPluginJsonValue } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import {
    isPluginError,
    PluginError,
    type Disposable,
    type JsonValue,
} from '@happier-dev/plugin-sdk';
import type {
    ScopedSettingsService,
    SettingsChange,
    SettingsScopeRef,
    SettingsService,
} from '@happier-dev/plugin-sdk/settings';

import type { StablePluginEventsBroker } from './events';
import { clonePluginPlainData } from '../../plainData';
import type { PluginInvocationServicesSeed } from './types';
import {
    admitLocalSettingsDeclarations,
    resolveLocalSettingsDeclarations,
    PluginLocalSettingsDeclarationError,
} from '@/plugins/settings/localSettingsContributions';
import { compilePluginSettingFieldSchema } from '@/plugins/settings/fieldSchemaValidation';
import {
    PLUGIN_HOST_STORAGE_KEY_PREFIX,
    updatePluginStorageScopeValueAtomically,
    type PluginStorageOwnerScope,
} from '../../context/storage';

export type {
    StablePluginSettingsIdentity,
    StablePluginSettingsField,
    StablePluginSettingsModel,
    StablePluginSettingsScope,
} from '@happier-dev/protocol/plugins/contributions/ui/settingsDescriptors';

export const PLUGIN_SETTINGS_STORAGE_KEY = `${PLUGIN_HOST_STORAGE_KEY_PREFIX}settings/v1`;
const SETTINGS_RECORD_TYPE = 'happier_plugin_settings_record_v1';
const CanonicalPluginSettingsRecordSchema = z.strictObject({
    t: z.literal(SETTINGS_RECORD_TYPE), revision: z.number().check(z.int(), z.nonnegative()),
    values: z.record(z.string(), z.unknown()),
});
const StoredPluginSettingsRecordSchema = createStoredReadSchema(CanonicalPluginSettingsRecordSchema);
const SETTINGS_CHANGED_REF = Object.freeze({
    pluginId: '@happier',
    localId: 'runtime/plugin-settings-changed',
});

export type CanonicalPluginSettingsRecord = Readonly<{
    t: typeof SETTINGS_RECORD_TYPE;
    revision: number;
    values: Readonly<Record<string, JsonValue>>;
}>;

const modelsByService = new WeakMap<ScopedSettingsService, StablePluginSettingsModel>();
const validatorsByModel = new WeakMap<object, ReadonlyMap<string, PluginJsonSchemaValidator>>();
const storedValueReadersByModel = new WeakMap<object, ReadonlyMap<string, ReturnType<typeof createPluginJsonSchemaZodValueAdapter>>>();
const perActiveServerMapFieldIdsByModel = new WeakMap<object, ReadonlySet<string>>();

function isValidStablePluginSettingValue(
    validator: PluginJsonSchemaValidator,
    isPerActiveServerMap: boolean,
    value: unknown,
): boolean {
    return isValidPluginJsonSchemaValue(validator, value)
        && (!isPerActiveServerMap || isBoundedPluginPerActiveServerValueV1(value));
}

export type StablePluginSettingsRecordStore = Readonly<{
    supports?(model: StablePluginSettingsModel): boolean;
    read(model: StablePluginSettingsModel, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown | null>;
    update<T>(
        model: StablePluginSettingsModel,
        operation: (current: unknown | null) => Readonly<{
            record: CanonicalPluginSettingsRecord;
            result: T;
            /** The computed record equals the stored one; the store must not persist or round-trip. */
            skipWrite?: boolean;
        }>,
        options?: Readonly<{
            signal?: AbortSignal;
            /** Pure postcondition projection after one ambiguous Account write readback. */
            settleOutcomeUnknown?(current: CanonicalPluginSettingsRecord): T | undefined;
            /** Pure postcondition projection after one losing CAS readback; never retries the write. */
            settleConflict?(current: CanonicalPluginSettingsRecord): T | undefined;
        }>,
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

export function createStablePluginSettingsModel(params: Parameters<typeof createProtocolSettingsModel>[0]): StablePluginSettingsModel {
    let model: StablePluginSettingsModel;
    try {
        model = createProtocolSettingsModel(params);
    } catch (error) {
        if (error instanceof PluginUiDeclarationProjectionErrorV1) {
            throw settingsError(error.code, error.message);
        }
        throw error;
    }
    return attachSettingsRuntimeValidators(model, resolveRuntimeSettingsDeclarations(params.pluginId, params.contributions ?? [params.contribution!]));
}

function resolveRuntimeSettingsDeclarations(pluginId: string, contributions: readonly PluginSettingsContributionV2[]) {
    try {
        return resolveLocalSettingsDeclarations({ settings: contributions.map(definition => ({ pluginId, definition })) })
            .map(declaration => declaration.definition);
    } catch (error) {
        if (!(error instanceof PluginLocalSettingsDeclarationError)) throw error;
        // Preserve the existing direct model-construction error vocabulary;
        // declaration admission and its diagnostics retain attributed typed errors.
        const code = error.code === 'PLUGIN_SETTINGS_DEFAULT_INVALID' ? 'plugin_settings_invalid_default'
            : error.code === 'PLUGIN_SETTINGS_SCHEMA_INVALID' ? 'plugin_settings_invalid_schema'
            : 'plugin_settings_declaration_invalid';
        throw settingsError(code, error.message);
    }
}

function attachSettingsRuntimeValidators(
    model: StablePluginSettingsModel,
    inputContributions: readonly PluginSettingsContributionV2[],
): StablePluginSettingsModel {
    const contributions = inputContributions;
    const perActiveServerMapFieldIds = new Set(contributions.flatMap((contribution) => contribution.fields.flatMap((field) => (
        field.presentation?.binding?.kind === 'perActiveServer' ? [field.presentation.binding.byServerIdSettingId] : []
    ))));
    const validators = new Map<string, PluginJsonSchemaValidator>();
    const storedValueReaders = new Map<string, ReturnType<typeof createPluginJsonSchemaZodValueAdapter>>();
    const admittedFields = new Map(contributions.flatMap(contribution => contribution.fields.map(field => [field.id, field] as const)));
    for (const field of model.fields) {
        validators.set(field.id, compilePluginSettingFieldSchema(admittedFields.get(field.id)!));
        storedValueReaders.set(field.id, createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(field.descriptor.schema)));
    }
    validatorsByModel.set(model, validators);
    storedValueReadersByModel.set(model, storedValueReaders);
    perActiveServerMapFieldIdsByModel.set(model, perActiveServerMapFieldIds);
    return model;
}

/**
 * Consumes the canonical descriptive scope partition and attaches runtime
 * validators without changing record or watch-stream custody.
 */
export function createStablePluginSettingsModels(params: Readonly<{
    pluginId: string;
    contributions: readonly PluginSettingsContributionV2[];
}>): ReadonlyMap<StablePluginSettingsScope, StablePluginSettingsModel> {
    return createSettingsModelsForAdmittedDeclarations(params.pluginId,
        resolveRuntimeSettingsDeclarations(params.pluginId, params.contributions));
}

function createSettingsModelsForAdmittedDeclarations(
    pluginId: string,
    contributions: readonly PluginSettingsContributionV2[],
): ReadonlyMap<StablePluginSettingsScope, StablePluginSettingsModel> {
    let models: ReadonlyMap<StablePluginSettingsScope, StablePluginSettingsModel>;
    try {
        models = createProtocolSettingsModels({ pluginId, contributions });
    } catch (error) {
        if (error instanceof PluginUiDeclarationProjectionErrorV1) {
            throw settingsError(error.code, error.message);
        }
        throw error;
    }

    return new Map(
        [...models.entries()].map(([scope, model]) => [
            scope,
            attachSettingsRuntimeValidators(model, contributions.filter(contribution => contribution.scope === scope)),
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
    return isValidStablePluginSettingValue(
        validator,
        perActiveServerMapFieldIdsByModel.get(model)?.has(settingId) === true,
        plainValue,
    );
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
        ) => Readonly<{
            record: CanonicalPluginSettingsRecord;
            result: T;
            skipWrite?: boolean;
        }>): Promise<T> {
            try {
                return await updatePluginStorageScopeValueAtomically({
                    scope: params.storageForPlugin(model.identity.pluginId),
                    key: PLUGIN_SETTINGS_STORAGE_KEY,
                    operation: (current) => {
                        const next = operation(current);
                        return Object.freeze({
                            value: next.record,
                            result: next.result,
                            ...(next.skipWrite === true ? { skipWrite: true } : {}),
                        });
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
    | Readonly<{ status: 'unavailable'; error?: PluginError }>;

export type PluginAccountSettingsRecordWriteResult =
    | Readonly<{ status: 'updated'; revision: number }>
    | Readonly<{ status: 'conflict'; revision: number }>
    | Readonly<{ status: 'outcomeUnknown' }>
    | Readonly<{ status: 'unavailable'; error?: PluginError }>;

export type PluginAccountSettingsRecordAccess = Readonly<{
    readRecord(
        model: StablePluginSettingsModel,
        /** `reuseHeld`: a plain read may take the adapter's held record; CAS and watch reads stay fresh. */
        options?: Readonly<{ signal?: AbortSignal; reuseHeld?: boolean }>,
    ): Promise<PluginAccountSettingsRecordRead>;
    writeRecord(
        model: StablePluginSettingsModel,
        request: Readonly<{
            expectedRevision: number | 'absent';
            values: Readonly<Record<string, JsonValue>>;
        }>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginAccountSettingsRecordWriteResult>;
}>;

export type PluginAccountSettingsRecordAdapter = Readonly<{
    /** Pins one Account/server lifetime across the read, CAS, and reconciliation. */
    bindOperation(options?: Readonly<{ signal?: AbortSignal }>): Promise<PluginAccountSettingsRecordAccess>;
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
    adapter: PluginAccountSettingsRecordAccess,
    options?: Readonly<{ signal?: AbortSignal; reuseHeld?: boolean }>,
): Promise<AccountPluginSettingsRecordState> {
    const source = await adapter.readRecord(model, options);
    if (source.status === 'unavailable') {
        if (source.error) throw source.error;
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
        record: normalizeStoredRecordForModel(model, parseStoredPluginSettingsRecord({
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
    const haveEquivalentValues = (left: JsonValue | undefined, right: JsonValue | undefined): boolean => (
        left === undefined
            ? right === undefined
            : right !== undefined && containsEquivalentPluginJsonValue([left], right)
    );
    const changedIds = model.fields
        .filter((field) => field.descriptor.secret !== true)
        .filter((field) => !haveEquivalentValues(
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
            const access = await adapter.bindOperation(options);
            return (await readAccountPluginSettingsRecord(model, access, { ...options, reuseHeld: true })).record;
        },
        async update<T>(
            model: StablePluginSettingsModel,
            operation: (
                current: unknown | null,
            ) => Readonly<{
                record: CanonicalPluginSettingsRecord;
                result: T;
                skipWrite?: boolean;
            }>,
            options?: Readonly<{
                signal?: AbortSignal;
                settleOutcomeUnknown?(current: CanonicalPluginSettingsRecord): T | undefined;
                settleConflict?(current: CanonicalPluginSettingsRecord): T | undefined;
            }>,
        ): Promise<T> {
            assertAccountSettingsModel(model);
            const access = await adapter.bindOperation(options);
            const current = await readAccountPluginSettingsRecord(model, access, options);
            const next = operation(current.record);
            // A raced pruning writer found nothing left to remove: the stored
            // bytes already satisfy the postcondition, so no CAS write, no
            // revision bump, and no history entry may follow.
            if (next.skipWrite === true) return next.result;
            const record = validateRecordForModel(
                model,
                parseCanonicalPluginSettingsRecord(next.record),
            );
            const response = await access.writeRecord(
                model,
                {
                    expectedRevision: current.expectedRevision,
                    values: record.values,
                },
                options,
            );
            if (response.status === 'unavailable') {
                if (response.error) throw response.error;
                throw settingsError(
                    'plugin_settings_persistence_unavailable',
                    'Account plugin settings persistence is unavailable',
                );
            }
            if (response.status === 'conflict') {
                const readback = options?.settleConflict
                    ? await readAccountPluginSettingsRecord(model, access).catch(() => null)
                    : null;
                const settled = readback
                    ? options?.settleConflict?.(readback.record)
                    : undefined;
                if (settled !== undefined) return settled;
                throw settingsError(
                    'plugin_settings_revision_conflict',
                    'Plugin settings revision does not match the current Account revision',
                    { currentRevision: String(response.revision) },
                );
            }
            if (response.status === 'outcomeUnknown') {
                const readback = await readAccountPluginSettingsRecord(model, access)
                    .catch(() => null);
                const settled = readback
                    ? options?.settleOutcomeUnknown?.(readback.record)
                    : undefined;
                if (settled !== undefined) return settled;
                throw settingsError(
                    'plugin_settings_outcome_unknown',
                    'Account plugin settings may have been updated, but the result is unknown',
                    { lastKnownRevision: String(readback?.record.revision ?? current.record.revision) },
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
            const access = adapter.bindOperation();
            const baseline = access.then((bound) => readAccountPluginSettingsRecord(model, bound))
                .then((state) => {
                    previous = state.record;
                })
                .catch(() => undefined);
            const refresh = (): void => {
                serial = serial.then(async () => {
                    await baseline;
                    if (closed) return;
                    try {
                        const next = (await readAccountPluginSettingsRecord(model, await access)).record;
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
    return parseSettingsRecord(value, false);
}

function parseStoredPluginSettingsRecord(value: unknown): CanonicalPluginSettingsRecord {
    return parseSettingsRecord(value, true);
}

function parseSettingsRecord(value: unknown, stored: boolean): CanonicalPluginSettingsRecord {
    if (value === null) return emptyRecord();
    const plain = clonePlainData(value, 'settingsRecord');
    const parsed = (stored ? StoredPluginSettingsRecordSchema : CanonicalPluginSettingsRecordSchema).safeParse(plain);
    if (!parsed.success) {
        throw settingsError('plugin_settings_record_invalid', 'Plugin settings record is invalid');
    }
    return Object.freeze({
        t: SETTINGS_RECORD_TYPE,
        revision: parsed.data.revision,
        values: clonePlainData(parsed.data.values) as Readonly<Record<string, JsonValue>>,
    });
}

function assertCurrent(seed: PluginInvocationServicesSeed, signal?: AbortSignal): void {
    if (signal?.aborted || seed.signal.aborted || !seed.isOccurrenceCurrent()) {
        throw settingsError(
            'plugin_settings_generation_retired',
            'Plugin settings invocation occurrenceId is no longer current',
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

/**
 * Returns the one scoped Settings snapshot an Agent may consume at launch.
 * `snapshot()` intentionally contains only persisted values; launch behavior
 * also needs the declaration defaults, so fill those from the same bound
 * descriptor list and never include secret fields.
 */
export async function readPluginSettingsValuesWithDefaults(
    service: ScopedSettingsService,
    options?: Readonly<{
        signal?: AbortSignal;
        releasedAccountSettings?: Readonly<{
            settings: Readonly<Record<string, unknown>> | null;
            hostDefaults: Readonly<Record<string, unknown>>;
        }>;
    }>,
): Promise<Readonly<Record<string, JsonValue>>> {
    const snapshot = await service.snapshot(options);
    const values: Record<string, JsonValue> = { ...snapshot.values };
    const model = modelsByService.get(service);
    for (const descriptor of service.describe()) {
        if (descriptor.secret === true || Object.hasOwn(values, descriptor.id)) continue;
        if (model?.scope === 'account' && options?.releasedAccountSettings) {
            const released = readReleasedFlatPluginSettingValue({
                ...options.releasedAccountSettings, localId: descriptor.id,
            });
            if (released !== undefined) {
                const parsed = storedValueReadersByModel.get(model)?.get(descriptor.id)?.safeParse(released);
                if (!parsed?.success || !validateStablePluginSettingValue(model, descriptor.id, parsed.data)) {
                    throw settingsError('plugin_settings_record_invalid', `Plugin settings record '${model.identity.qualifiedId}' contains an invalid field value`);
                }
                values[descriptor.id] = parsed.data;
                continue;
            }
        }
        if (descriptor.default !== undefined) values[descriptor.id] = clonePlainData(descriptor.default);
    }
    return Object.freeze(values);
}

function recordSatisfiesSettingsPostcondition(
    record: CanonicalPluginSettingsRecord,
    input: Readonly<{
        values?: Readonly<Record<string, JsonValue>>;
        absentIds?: readonly string[];
    }>,
): boolean {
    if (input.absentIds?.some((id) => record.values[id] !== undefined)) return false;
    return Object.entries(input.values ?? {}).every(([id, expected]) => {
        const observed = record.values[id];
        return observed !== undefined
            && containsEquivalentPluginJsonValue([expected], observed);
    });
}

/**
 * The one canonical Settings record bounds check for a record this owner is
 * about to grow, read from the single Protocol owner for BOTH scopes.
 *
 * `PluginAccountSettingsValuesV1Schema` enforces the declared scoped-record
 * contract — field count, per-field canonical bytes, JSON depth and total
 * canonical record bytes (SET-09) — and is the same schema the Account record
 * adapter and the server storage boundary parse through, so no writer can
 * disagree with the wire boundary about what a scoped record admits. Scope
 * changes persistence/transport, never the Settings value contract. This runs
 * on every growing write. Reset is deliberately excluded: a record that is
 * already outside the current bounds must stay readable and stay shrinkable.
 */
function settingsValuesWithinCanonicalBounds(
    values: Readonly<Record<string, JsonValue>>,
): boolean {
    return PluginAccountSettingsValuesV1Schema.safeParse({ v: 1, values }).success;
}

function assertSettingsValuesWithinCanonicalBounds(
    values: Readonly<Record<string, JsonValue>>,
): void {
    if (!settingsValuesWithinCanonicalBounds(values)) {
        throw settingsError(
            'plugin_settings_values_too_large',
            'Plugin settings values exceed their canonical record bounds',
        );
    }
}

function validateRecordForModel(
    model: StablePluginSettingsModel,
    record: CanonicalPluginSettingsRecord,
): CanonicalPluginSettingsRecord {
    // Validate the current descriptor projection, not every raw persisted key.
    // A field removed from the current declaration remains opaque evidence in
    // the raw record and is preserved by unrelated writes, while get/snapshot
    // cannot expose it. If that id becomes current again, it is validated
    // below against the new current schema before any read or write succeeds.
    for (const field of model.fields) {
        if (!Object.hasOwn(record.values, field.id)) continue;
        const value = record.values[field.id]!;
        if (field.descriptor.secret === true
            || !validateStablePluginSettingValue(model, field.id, value)) {
            throw settingsError(
                'plugin_settings_record_invalid',
                `Plugin settings record '${model.identity.qualifiedId}' contains an invalid field value`,
            );
        }
    }
    return record;
}

function normalizeStoredRecordForModel(
    model: StablePluginSettingsModel,
    record: CanonicalPluginSettingsRecord,
): CanonicalPluginSettingsRecord {
    const values = { ...record.values };
    const readers = storedValueReadersByModel.get(model);
    for (const field of model.fields) {
        if (!Object.hasOwn(values, field.id)) continue;
        const parsed = readers?.get(field.id)?.safeParse(values[field.id]);
        if (!parsed?.success) {
            throw settingsError('plugin_settings_record_invalid', `Plugin settings record '${model.identity.qualifiedId}' contains an invalid field value`);
        }
        values[field.id] = parsed.data;
    }
    return validateRecordForModel(model, Object.freeze({ ...record, values: Object.freeze(values) }));
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
                if (!validateStablePluginSettingValue(model, id, patch[id]!)) {
                    throw settingsError(
                        'plugin_settings_validation_failed',
                        `Plugin setting '${field.qualifiedId}' failed schema validation`,
                    );
                }
            }
            const settlePatchReadback = (record: CanonicalPluginSettingsRecord) => {
                if (!recordSatisfiesSettingsPostcondition(record, { values: patch })) return undefined;
                return Object.freeze({
                    scope: settingsScopeRef(model),
                    revision: String(record.revision),
                    changedIds: Object.freeze(changedIds),
                    values: visibleValues(model, record),
                });
            };
            const change = await params.recordStore.update(model, (raw) => {
                assertCurrent(seed, input.signal);
                const record = normalizeStoredRecordForModel(model, parseStoredPluginSettingsRecord(raw));
                assertExpectedRevision(record, input.expectedRevision);
                const nextRevision = record.revision + 1;
                if (!Number.isSafeInteger(nextRevision)) {
                    throw settingsError('plugin_settings_revision_exhausted', 'Plugin settings revision is exhausted');
                }
                const values = { ...record.values, ...patch };
                assertSettingsValuesWithinCanonicalBounds(values);
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
            }, {
                signal: input.signal,
                ...(input.expectedRevision === undefined
                    ? { settleOutcomeUnknown: settlePatchReadback }
                    : {}),
            });
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
                    occurrenceId: seed.occurrenceId,
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
                occurrenceId: seed.occurrenceId,
                correlationId: seed.correlationId,
                surface: seed.surface,
            });

            async function read(signal?: AbortSignal): Promise<CanonicalPluginSettingsRecord> {
                assertSupportedScope(model, params.recordStore);
                assertCurrent(seed, signal);
                const record = normalizeStoredRecordForModel(
                    model,
                    parseStoredPluginSettingsRecord(await params.recordStore.read(model, { signal })),
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
                if (!input.reset
                    && !validateStablePluginSettingValue(model, input.id, normalizedValue!)) {
                    throw settingsError(
                        'plugin_settings_validation_failed',
                        `Plugin setting '${field.qualifiedId}' failed schema validation`,
                    );
                }
                const settleMutationReadback = (record: CanonicalPluginSettingsRecord) => {
                    if (!recordSatisfiesSettingsPostcondition(record, input.reset
                        ? { absentIds: [input.id] }
                        : { values: { [input.id]: normalizedValue! } })) return undefined;
                    return Object.freeze({
                        scope: settingsScopeRef(model),
                        revision: String(record.revision),
                        changedIds: Object.freeze([input.id]),
                        values: visibleValues(model, record),
                    });
                };
                const change = await params.recordStore.update(model, (raw) => {
                    assertCurrent(seed, input.signal);
                    const record = normalizeStoredRecordForModel(model, parseStoredPluginSettingsRecord(raw));
                    assertExpectedRevision(record, input.expectedRevision);
                    const nextRevision = record.revision + 1;
                    if (!Number.isSafeInteger(nextRevision)) {
                        throw settingsError('plugin_settings_revision_exhausted', 'Plugin settings revision is exhausted');
                    }
                    const values = { ...record.values };
                    if (input.reset) delete values[input.id];
                    else values[input.id] = normalizedValue!;
                    // A reset only shrinks the record, so it must stay available
                    // on a record that is already outside the current bounds.
                    if (!input.reset) assertSettingsValuesWithinCanonicalBounds(values);
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
                }, {
                    signal: input.signal,
                    ...(input.expectedRevision === undefined
                        ? { settleOutcomeUnknown: settleMutationReadback }
                        : {}),
                });
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
                        isCurrent: () => !seed.signal.aborted && seed.isOccurrenceCurrent(),
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
            modelsByService.set(service, model);
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
     * Reports each excluded group with its attributed admission error. Healthy
     * sibling groups retain the plugin's scoped Settings service.
     */
    onPluginSettingsUnavailable?(input: Readonly<{ pluginId: string; error: unknown }>): void;
}>): StablePluginSettingsHost {
    const admission = admitLocalSettingsDeclarations({ settings: params.declarations.map(declaration => ({
        pluginId: declaration.pluginId, definition: declaration.contribution,
    })) });
    for (const error of admission.errors) params.onPluginSettingsUnavailable?.({ pluginId: error.pluginId, error });
    const declarationsByPluginId = new Map<string, PluginSettingsContributionV2[]>();
    for (const declaration of admission.declarations) {
        const existing = declarationsByPluginId.get(declaration.pluginId) ?? [];
        existing.push(declaration.definition);
        declarationsByPluginId.set(declaration.pluginId, existing);
    }
    const modelsByPluginId = new Map<string, ReturnType<typeof createStablePluginSettingsModels>>();
    for (const [pluginId, contributions] of declarationsByPluginId) {
        modelsByPluginId.set(pluginId, createSettingsModelsForAdmittedDeclarations(pluginId, contributions));
    }
    const owner = createStablePluginSettingsOwner({
        recordStore: params.recordStore,
        broker: params.broker,
    });
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
                    // Declarations remain describable before storage is ready.
                    // Each read/write/watch checks current persistence support.
                    return model
                        ? owner.bind({ model, seed })
                        : unavailableScopedSettingsService(scope);
                },
            });
        },
    });
}
