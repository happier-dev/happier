import type {
    PluginConnectedAccountRuntimeConfiguration,
    PluginContributionRef,
} from '@happier-dev/plugin-sdk/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    PluginConnectedAccountAuthenticationModeV2,
} from '@happier-dev/protocol';

import {
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
} from '@/plugins/runtime/invocation/services/jsonSchemaValidation';

import type { ConnectedAccountAttemptConfigurationAdmission } from './authenticationAttemptOwner';
import { normalizeConnectedAccountConfiguredOrigin } from './configuredOrigins';

type MaybePromise<T> = T | Promise<T>;
type GenerationIdentity = Readonly<{
    generation: string;
    immutableGenerationId: string;
}>;
type ConnectedAccountModeConfiguration =
    Extract<
        PluginConnectedAccountAuthenticationModeV2,
        { kind: 'oauthAuthorizationCode' | 'oauthDeviceCode' }
    >['configuration'];
type ConnectedAccountConfigurationField =
    NonNullable<ConnectedAccountModeConfiguration>['fields'][number];

export type ConnectedAccountConfigurationTarget =
    PluginConnectedAccountRuntimeConfiguration['target'];

export type ConnectedAccountConfigurationRecord = Readonly<{
    revision: string;
    values: Readonly<Record<string, JsonValue>>;
    secretRefs: Readonly<Record<string, string>>;
    /**
     * Account/attempt-scoped secret bytes. Persistence must keep this field
     * inside the existing opaque configuration/attempt envelope; service
     * targets use Account Settings SavedSecret references instead.
     */
    secretValues?: Readonly<Record<string, string>>;
}>;

export function parseConnectedAccountConfigurationRecordContent(
    input: unknown,
    revision: string,
): ConnectedAccountConfigurationRecord {
    assertBoundedIdentity(revision, 'Connected-account configuration revision');
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw invalid('Connected-account configuration content must be a plain object');
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        throw invalid('Connected-account configuration content must be plain data');
    }
    const keys = Reflect.ownKeys(input);
    if (
        (keys.length !== 2 && keys.length !== 3)
        || !keys.includes('values')
        || !keys.includes('secretRefs')
        || (keys.length === 3 && !keys.includes('secretValues'))
    ) {
        throw invalid('Connected-account configuration content has an invalid shape');
    }
    const valuesProperty = Object.getOwnPropertyDescriptor(input, 'values');
    const secretRefsProperty = Object.getOwnPropertyDescriptor(input, 'secretRefs');
    const secretValuesProperty = Object.getOwnPropertyDescriptor(input, 'secretValues');
    if (
        !valuesProperty?.enumerable
        || !('value' in valuesProperty)
        || !secretRefsProperty?.enumerable
        || !('value' in secretRefsProperty)
        || (
            secretValuesProperty !== undefined
            && (
                !secretValuesProperty.enumerable
                || !('value' in secretValuesProperty)
            )
        )
    ) {
        throw invalid('Connected-account configuration content must be plain data');
    }
    const values = cloneOwnRecord(
        valuesProperty.value as Readonly<Record<string, unknown>>,
        (entry) => cloneJsonValue(entry, { nodes: 0 }),
    );
    const secretRefs = cloneOwnRecord(
        secretRefsProperty.value as Readonly<Record<string, unknown>>,
        (entry, key) => {
            if (
                typeof entry !== 'string'
                || entry.length === 0
                || entry.length > MAX_SECRET_REFERENCE_LENGTH
            ) {
                throw invalid(`Configuration secret reference '${key}' is invalid`);
            }
            return entry;
        },
    );
    const secretValues = secretValuesProperty === undefined
        ? undefined
        : cloneOwnRecord(
            secretValuesProperty.value as Readonly<Record<string, unknown>>,
            (entry, key) => {
                if (
                    typeof entry !== 'string'
                    || entry.length === 0
                    || entry.length > MAX_SECRET_VALUE_LENGTH
                ) {
                    throw invalid(`Inline configuration secret '${key}' is invalid`);
                }
                return entry;
            },
        );
    return Object.freeze({
        revision,
        values,
        secretRefs,
        ...(secretValues ? { secretValues } : {}),
    });
}

type ConfigurationReplacement = Readonly<{
    values: Readonly<Record<string, unknown>>;
    secretRefs: Readonly<Record<string, unknown>>;
    secretValues?: Readonly<Record<string, unknown>>;
}>;

type SnapshotMetadata = Readonly<{
    mode: PluginConnectedAccountAuthenticationModeV2;
    generation: GenerationIdentity;
    target: ConnectedAccountConfigurationTarget;
    revision: string;
    secretRefs: Readonly<Record<string, string>>;
    secretValues: Readonly<Record<string, string>>;
    unconfigured: boolean;
}>;

export class ConnectedAccountConfigurationError extends Error {
    readonly code:
        | 'connected_account_configuration_invalid'
        | 'connected_account_configuration_secret_field_invalid'
        | 'connected_account_configuration_stale'
        | 'connected_account_configuration_unavailable';

    constructor(code: ConnectedAccountConfigurationError['code'], message: string) {
        super(message);
        this.name = 'ConnectedAccountConfigurationError';
        this.code = code;
    }
}

const MAX_CONFIGURATION_FIELDS = 64;
const MAX_CONFIGURATION_REVISION_LENGTH = 256;
const MAX_SECRET_REFERENCE_LENGTH = 512;
const MAX_SECRET_VALUE_LENGTH = 64 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_STRING_LENGTH = 64 * 1024;

function invalid(message: string): ConnectedAccountConfigurationError {
    return new ConnectedAccountConfigurationError(
        'connected_account_configuration_invalid',
        message,
    );
}

function assertBoundedIdentity(value: string, label: string): void {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_CONFIGURATION_REVISION_LENGTH
    ) {
        throw invalid(`${label} must be a bounded non-empty string`);
    }
}

function sameService(left: PluginContributionRef, right: PluginContributionRef): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function modeConfiguration(
    mode: PluginConnectedAccountAuthenticationModeV2,
): ConnectedAccountModeConfiguration {
    return 'configuration' in mode ? mode.configuration : undefined;
}

function cloneJsonValue(
    value: unknown,
    state: { nodes: number },
    depth = 0,
): JsonValue {
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
        throw invalid('Connected-account configuration value exceeds the bounded JSON budget');
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value.length > MAX_JSON_STRING_LENGTH) {
            throw invalid('Connected-account configuration string exceeds the bounded JSON budget');
        }
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw invalid('Connected-account configuration numbers must be finite');
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') throw invalid('Connected-account configuration must contain JSON values');
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
            throw invalid('Connected-account configuration arrays must be plain data');
        }
        const ownKeys = Reflect.ownKeys(value);
        if (
            ownKeys.length !== value.length + 1
            || ownKeys.some((key) => typeof key !== 'string')
        ) {
            throw invalid('Connected-account configuration arrays must be dense plain data');
        }
        return Object.freeze(value.map((_entry, index) => {
            const property = Object.getOwnPropertyDescriptor(value, String(index));
            if (!property || !property.enumerable || !('value' in property)) {
                throw invalid('Connected-account configuration arrays must be plain data');
            }
            return cloneJsonValue(property.value, state, depth + 1);
        }));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw invalid('Connected-account configuration objects must be plain data');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
        ownKeys.length > MAX_CONFIGURATION_FIELDS
        || ownKeys.some((key) => typeof key !== 'string')
    ) {
        throw invalid('Connected-account configuration object exceeds the field budget');
    }
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of ownKeys as string[]) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !property.enumerable || !('value' in property)) {
            throw invalid('Connected-account configuration objects must be plain data');
        }
        output[key] = cloneJsonValue(property.value, state, depth + 1);
    }
    return Object.freeze(output);
}

function cloneOwnRecord<T>(
    value: Readonly<Record<string, unknown>>,
    clone: (entry: unknown, key: string) => T,
): Readonly<Record<string, T>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw invalid('Connected-account configuration fields must be a plain object');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw invalid('Connected-account configuration fields must be plain data');
    }
    const keys = Reflect.ownKeys(value);
    if (
        keys.length > MAX_CONFIGURATION_FIELDS
        || keys.some((key) => typeof key !== 'string')
    ) {
        throw invalid('Connected-account configuration exceeds the field budget');
    }
    const output: Record<string, T> = Object.create(null) as Record<string, T>;
    for (const key of keys as string[]) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !property.enumerable || !('value' in property)) {
            throw invalid('Connected-account configuration fields must be plain data');
        }
        output[key] = clone(property.value, key);
    }
    return Object.freeze(output);
}

function snapshotTarget(target: ConnectedAccountConfigurationTarget): ConnectedAccountConfigurationTarget {
    const modeId = target.modeId;
    assertBoundedIdentity(modeId, 'Connected-account configuration mode id');
    if (target.kind === 'service') {
        return Object.freeze({
            kind: 'service',
            service: Object.freeze({ ...target.service }),
            modeId,
        });
    }
    if (target.kind === 'attempt') {
        assertBoundedIdentity(target.attemptId, 'Connected-account attempt id');
        return Object.freeze({
            kind: 'attempt',
            attemptId: target.attemptId,
            service: Object.freeze({ ...target.service }),
            modeId,
        });
    }
    assertBoundedIdentity(target.account.accountId, 'Connected-account account id');
    return Object.freeze({
        kind: 'account',
        account: Object.freeze({
            service: Object.freeze({ ...target.account.service }),
            accountId: target.account.accountId,
        }),
        modeId,
    });
}

function resolveTarget(input: Readonly<{
    intent: 'connect' | 'reconnect';
    service: PluginContributionRef;
    account?: Readonly<{ service: PluginContributionRef; accountId: string }>;
    attemptId?: string;
    mode: PluginConnectedAccountAuthenticationModeV2;
}>): ConnectedAccountConfigurationTarget {
    const configuration = modeConfiguration(input.mode);
    if (!configuration || configuration.scope === 'service') {
        return snapshotTarget({
            kind: 'service',
            service: input.service,
            modeId: input.mode.id,
        });
    }
    if (input.intent === 'connect') {
        if (!input.attemptId) throw invalid('First-connect account configuration requires an exact attempt id');
        return snapshotTarget({
            kind: 'attempt',
            attemptId: input.attemptId,
            service: input.service,
            modeId: input.mode.id,
        });
    }
    if (!input.account || !sameService(input.account.service, input.service)) {
        throw invalid('Reconnect account configuration requires the exact qualified account');
    }
    return snapshotTarget({
        kind: 'account',
        account: input.account,
        modeId: input.mode.id,
    });
}

function assertTargetMatchesMode(
    target: ConnectedAccountConfigurationTarget,
    mode: PluginConnectedAccountAuthenticationModeV2,
): void {
    if (target.modeId !== mode.id) {
        throw invalid('Connected-account configuration target mode does not match its descriptor');
    }
    const scope = modeConfiguration(mode)?.scope;
    if (
        (scope === 'service' && target.kind !== 'service')
        || (scope === 'account' && target.kind === 'service')
    ) {
        throw invalid('Connected-account configuration target scope does not match its descriptor');
    }
}

function descriptorFields(
    mode: PluginConnectedAccountAuthenticationModeV2,
): readonly ConnectedAccountConfigurationField[] {
    return modeConfiguration(mode)?.fields ?? Object.freeze([]);
}

export type ConnectedAccountConfigurationOwner = Readonly<{
    inspect(input: Readonly<{
        target: ConnectedAccountConfigurationTarget;
        mode: PluginConnectedAccountAuthenticationModeV2;
        generation: string;
        immutableGenerationId: string;
    }>): Promise<Readonly<{
        status: 'ready' | 'configurationRequired';
        revision: string | null;
        values: Readonly<Record<string, JsonValue>>;
        configuredSecretFieldIds: readonly string[];
        missingFieldIds: readonly string[];
    }>>;
    replaceForControl(input: Readonly<{
        target: ConnectedAccountConfigurationTarget;
        mode: PluginConnectedAccountAuthenticationModeV2;
        expectedRevision: string | null;
        values: Readonly<Record<string, unknown>>;
        secretValues: Readonly<Record<string, string>>;
        generation: string;
        immutableGenerationId: string;
    }>): Promise<
        | Readonly<{
            status: 'committed';
            snapshot: PluginConnectedAccountRuntimeConfiguration;
        }>
        | Readonly<{
            status: 'conflict' | 'unavailable';
            code: string;
        }>
    >;
    admit(input: Readonly<{
        intent: 'connect' | 'reconnect';
        service: PluginContributionRef;
        account?: Readonly<{ service: PluginContributionRef; accountId: string }>;
        mode: PluginConnectedAccountAuthenticationModeV2;
        attemptId?: string;
        expectedConfigurationRevision?: string;
        generation: string;
        immutableGenerationId: string;
    }>): Promise<ConnectedAccountAttemptConfigurationAdmission>;
    replace(input: Readonly<{
        target: ConnectedAccountConfigurationTarget;
        mode: PluginConnectedAccountAuthenticationModeV2;
        expectedRevision: string | null;
        replacement: ConfigurationReplacement;
        generation: string;
        immutableGenerationId: string;
    }>): Promise<
        | Readonly<{
            status: 'committed';
            snapshot: PluginConnectedAccountRuntimeConfiguration;
        }>
        | Readonly<{
            status: 'conflict' | 'unavailable';
            code: string;
        }>
    >;
    isCurrent(snapshot: PluginConnectedAccountRuntimeConfiguration): Promise<boolean>;
    destroyAttempt(attemptId: string): Promise<void>;
}>;

export function createConnectedAccountConfigurationOwner(params: Readonly<{
    read(target: ConnectedAccountConfigurationTarget): Promise<ConnectedAccountConfigurationRecord | null>;
    replace(input: Readonly<{
        target: ConnectedAccountConfigurationTarget;
        expectedRevision: string | null;
        replacement: Omit<ConnectedAccountConfigurationRecord, 'revision'>;
        generation: string;
        immutableGenerationId: string;
    }>): Promise<
        | Readonly<{ status: 'committed'; record: ConnectedAccountConfigurationRecord }>
        | Readonly<{ status: 'conflict' | 'unavailable'; code?: string }>
    >;
    replaceForControl?(input: Readonly<{
        target: ConnectedAccountConfigurationTarget;
        expectedRevision: string | null;
        values: Readonly<Record<string, JsonValue>>;
        currentSecretRefs: Readonly<Record<string, string>>;
        secretValues: Readonly<Record<string, string>>;
        generation: string;
        immutableGenerationId: string;
    }>): Promise<
        | Readonly<{ status: 'committed'; record: ConnectedAccountConfigurationRecord }>
        | Readonly<{ status: 'conflict' | 'unavailable'; code?: string }>
    >;
    destroyAttempt(attemptId: string): MaybePromise<void>;
    secrets: Readonly<{
        has(secretId: string): Promise<boolean>;
        read(secretId: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<string | null>;
    }>;
    isGenerationCurrent(input: Readonly<{
        pluginId: string;
        generation: string;
        immutableGenerationId: string;
    }>): MaybePromise<boolean>;
}>): ConnectedAccountConfigurationOwner {
    const snapshotMetadata = new WeakMap<PluginConnectedAccountRuntimeConfiguration, SnapshotMetadata>();

    async function assertGenerationCurrent(
        service: PluginContributionRef,
        generation: GenerationIdentity,
    ): Promise<void> {
        if (!await params.isGenerationCurrent({ pluginId: service.pluginId, ...generation })) {
            throw new ConnectedAccountConfigurationError(
                'connected_account_configuration_stale',
                'Connected-account plugin generation is no longer current',
            );
        }
    }

    async function isTargetRevisionCurrent(
        service: PluginContributionRef,
        generation: GenerationIdentity,
        target: ConnectedAccountConfigurationTarget,
        expectedRevision: string | null,
    ): Promise<boolean> {
        await assertGenerationCurrent(service, generation);
        const current = await params.read(target);
        await assertGenerationCurrent(service, generation);
        return (current?.revision ?? null) === expectedRevision;
    }

    async function normalize(input: Readonly<{
        target: ConnectedAccountConfigurationTarget;
        mode: PluginConnectedAccountAuthenticationModeV2;
        record: ConnectedAccountConfigurationRecord | null;
        replacement?: ConfigurationReplacement;
    }>): Promise<Readonly<{
        revision: string | null;
        values: Readonly<Record<string, JsonValue>>;
        secretRefs: Readonly<Record<string, string>>;
        secretValues: Readonly<Record<string, string>>;
        missingFieldIds: readonly string[];
    }>> {
        const fields = descriptorFields(input.mode);
        const fieldsById = new Map(fields.map((field) => [field.id, field]));
        const sourceValues = input.replacement?.values ?? input.record?.values ?? Object.freeze({});
        const sourceSecretRefs = input.replacement?.secretRefs ?? input.record?.secretRefs ?? Object.freeze({});
        const sourceSecretValues =
            input.replacement?.secretValues
            ?? input.record?.secretValues
            ?? Object.freeze({});
        const values = cloneOwnRecord(sourceValues, (entry, key) => {
            const field = fieldsById.get(key);
            if (!field || field.secret === true) {
                throw invalid(`Undeclared or secret configuration field '${key}' was supplied as plaintext`);
            }
            const cloned = cloneJsonValue(entry, { nodes: 0 });
            const validate = compilePluginJsonSchema(field.schema);
            if (!isValidPluginJsonSchemaValue(validate, cloned)) {
                throw invalid(`Configuration field '${key}' does not match its declared schema`);
            }
            if (field.semantic === 'connectedAccountOrigin') {
                try {
                    if (typeof cloned !== 'string') throw new TypeError('Origin must be a string');
                    normalizeConnectedAccountConfiguredOrigin(cloned);
                } catch {
                    throw invalid(
                        `Configuration field '${key}' must be an exact credential-free HTTPS origin`,
                    );
                }
            }
            return cloned;
        });
        const secretRefs = cloneOwnRecord(sourceSecretRefs, (entry, key) => {
            const field = fieldsById.get(key);
            if (!field || field.secret !== true) {
                throw invalid(`Undeclared or non-secret configuration field '${key}' was supplied as a secret`);
            }
            if (
                typeof entry !== 'string'
                || entry.length === 0
                || entry.length > MAX_SECRET_REFERENCE_LENGTH
            ) {
                throw invalid(`Configuration secret reference '${key}' is invalid`);
            }
            return entry;
        });
        const secretValues = cloneOwnRecord(sourceSecretValues, (entry, key) => {
            const field = fieldsById.get(key);
            if (!field || field.secret !== true) {
                throw invalid(`Undeclared or non-secret inline configuration field '${key}' was supplied`);
            }
            if (
                typeof entry !== 'string'
                || entry.length === 0
                || entry.length > MAX_SECRET_VALUE_LENGTH
            ) {
                throw invalid(`Inline configuration secret '${key}' is invalid`);
            }
            return entry;
        });
        if (
            Object.keys(secretRefs).some((fieldId) =>
                Object.prototype.hasOwnProperty.call(secretValues, fieldId))
        ) {
            throw invalid('A configuration secret field cannot have both inline bytes and a SavedSecret reference');
        }
        if (input.target.kind === 'service' && Object.keys(secretValues).length > 0) {
            throw invalid('Service configuration secrets must use Account Settings SavedSecret references');
        }
        if (input.target.kind !== 'service' && Object.keys(secretRefs).length > 0) {
            throw invalid('Account and attempt configuration secrets must stay inline with their owning record');
        }
        const normalizedValues: Record<string, JsonValue> = { ...values };
        const missingFieldIds: string[] = [];
        for (const field of fields) {
            if (field.secret === true) {
                const reference = secretRefs[field.id];
                const inlineSecret = secretValues[field.id];
                const referencedSecretPresent =
                    reference !== undefined && await params.secrets.has(reference);
                if (reference !== undefined && !referencedSecretPresent) {
                    throw invalid(`Configuration secret reference '${field.id}' is dangling`);
                }
                const present =
                    referencedSecretPresent
                    || inlineSecret !== undefined;
                if (field.required === true && !present) missingFieldIds.push(field.id);
                continue;
            }
            if (normalizedValues[field.id] === undefined && field.default !== undefined) {
                const clonedDefault = cloneJsonValue(field.default, { nodes: 0 });
                const validate = compilePluginJsonSchema(field.schema);
                if (!isValidPluginJsonSchemaValue(validate, clonedDefault)) {
                    throw invalid(`Configuration default '${field.id}' does not match its declared schema`);
                }
                normalizedValues[field.id] = clonedDefault;
            }
            if (field.required === true && normalizedValues[field.id] === undefined) {
                missingFieldIds.push(field.id);
            }
        }
        const revision = input.record?.revision ?? null;
        if (revision !== null) assertBoundedIdentity(revision, 'Connected-account configuration revision');
        return Object.freeze({
            revision,
            values: Object.freeze(normalizedValues),
            secretRefs,
            secretValues,
            missingFieldIds: Object.freeze(missingFieldIds.sort()),
        });
    }

    function serviceForTarget(target: ConnectedAccountConfigurationTarget): PluginContributionRef {
        return target.kind === 'account' ? target.account.service : target.service;
    }

    function createSnapshot(input: Readonly<{
        target: ConnectedAccountConfigurationTarget;
        mode: PluginConnectedAccountAuthenticationModeV2;
        generation: GenerationIdentity;
        revision: string;
        values: Readonly<Record<string, JsonValue>>;
        secretRefs: Readonly<Record<string, string>>;
        secretValues?: Readonly<Record<string, string>>;
        unconfigured?: boolean;
    }>): PluginConnectedAccountRuntimeConfiguration {
        const secretFields = new Set(
            descriptorFields(input.mode)
                .filter((field) => field.secret === true)
                .map((field) => field.id),
        );
        let snapshot!: PluginConnectedAccountRuntimeConfiguration;
        snapshot = Object.freeze({
            target: input.target,
            revision: input.revision,
            values: input.values,
            async getSecret(fieldId, options) {
                if (!secretFields.has(fieldId)) {
                    throw new ConnectedAccountConfigurationError(
                        'connected_account_configuration_secret_field_invalid',
                        'Connected-account configuration secret field is not declared',
                    );
                }
                if (options?.signal?.aborted) throw options.signal.reason ?? new Error('Operation aborted');
                if (!await owner.isCurrent(snapshot)) {
                    throw new ConnectedAccountConfigurationError(
                        'connected_account_configuration_stale',
                        'Connected-account configuration is no longer current',
                    );
                }
                const inlineSecret = input.secretValues?.[fieldId];
                const secretId = input.secretRefs[fieldId];
                if (inlineSecret === undefined && !secretId) return null;
                const secret = inlineSecret
                    ?? await params.secrets.read(secretId!, options);
                if (
                    secret !== null
                    && (typeof secret !== 'string' || secret.length > MAX_SECRET_VALUE_LENGTH)
                ) {
                    throw new ConnectedAccountConfigurationError(
                        'connected_account_configuration_unavailable',
                        'Connected-account configuration secret is invalid',
                    );
                }
                if (!await owner.isCurrent(snapshot)) {
                    throw new ConnectedAccountConfigurationError(
                        'connected_account_configuration_stale',
                        'Connected-account configuration changed during secret retrieval',
                    );
                }
                return secret;
            },
        });
        snapshotMetadata.set(snapshot, Object.freeze({
            mode: input.mode,
            generation: input.generation,
            target: input.target,
            revision: input.revision,
            secretRefs: input.secretRefs,
            secretValues: input.secretValues ?? Object.freeze({}),
            unconfigured: input.unconfigured === true,
        }));
        return snapshot;
    }

    const owner = {
        async inspect(input: Readonly<{
            target: ConnectedAccountConfigurationTarget;
            mode: PluginConnectedAccountAuthenticationModeV2;
            generation: string;
            immutableGenerationId: string;
        }>) {
            const target = snapshotTarget(input.target);
            assertTargetMatchesMode(target, input.mode);
            if (!modeConfiguration(input.mode)) {
                throw invalid('A mode without configuration has no configuration record');
            }
            const service = serviceForTarget(target);
            const generationIdentity = Object.freeze({
                generation: input.generation,
                immutableGenerationId: input.immutableGenerationId,
            });
            await assertGenerationCurrent(service, generationIdentity);
            const record = await params.read(target);
            await assertGenerationCurrent(service, generationIdentity);
            const normalized = await normalize({ target, mode: input.mode, record });
            if (!await isTargetRevisionCurrent(
                service,
                generationIdentity,
                target,
                normalized.revision,
            )) {
                throw new ConnectedAccountConfigurationError(
                    'connected_account_configuration_stale',
                    'Connected-account configuration changed during inspection',
                );
            }
            return Object.freeze({
                status: normalized.revision !== null
                    && normalized.missingFieldIds.length === 0
                    ? 'ready' as const
                    : 'configurationRequired' as const,
                revision: normalized.revision,
                values: normalized.values,
                configuredSecretFieldIds: Object.freeze(
                    [...new Set([
                        ...Object.keys(normalized.secretRefs),
                        ...Object.keys(normalized.secretValues),
                    ])].sort(),
                ),
                missingFieldIds: normalized.missingFieldIds,
            });
        },

        async replaceForControl(input: Readonly<{
            target: ConnectedAccountConfigurationTarget;
            mode: PluginConnectedAccountAuthenticationModeV2;
            expectedRevision: string | null;
            values: Readonly<Record<string, unknown>>;
            secretValues: Readonly<Record<string, string>>;
            generation: string;
            immutableGenerationId: string;
        }>) {
            const target = snapshotTarget(input.target);
            assertTargetMatchesMode(target, input.mode);
            if (!modeConfiguration(input.mode)) {
                throw invalid('A mode without configuration cannot persist a configuration record');
            }
            const service = serviceForTarget(target);
            const generationIdentity = Object.freeze({
                generation: input.generation,
                immutableGenerationId: input.immutableGenerationId,
            });
            await assertGenerationCurrent(service, generationIdentity);
            const current = await params.read(target);
            await assertGenerationCurrent(service, generationIdentity);
            if ((current?.revision ?? null) !== input.expectedRevision) {
                return Object.freeze({
                    status: 'conflict' as const,
                    code: 'connected_account_configuration_changed',
                });
            }
            const preview = await normalize({
                target,
                mode: input.mode,
                record: current,
                replacement: {
                    values: input.values,
                    secretRefs: current?.secretRefs ?? Object.freeze({}),
                    secretValues: current?.secretValues ?? Object.freeze({}),
                },
            });
            if (!await isTargetRevisionCurrent(
                service,
                generationIdentity,
                target,
                input.expectedRevision,
            )) {
                return Object.freeze({
                    status: 'conflict' as const,
                    code: 'connected_account_configuration_changed',
                });
            }
            const secretFields = new Set(
                descriptorFields(input.mode)
                    .filter((field) => field.secret === true)
                    .map((field) => field.id),
            );
            const replacements = cloneOwnRecord(
                input.secretValues,
                (entry, fieldId) => {
                    if (
                        !secretFields.has(fieldId)
                        || typeof entry !== 'string'
                        || entry.length === 0
                        || entry.length > MAX_SECRET_VALUE_LENGTH
                    ) {
                        throw invalid(`Configuration secret replacement '${fieldId}' is invalid`);
                    }
                    return entry;
                },
            );
            await assertGenerationCurrent(service, generationIdentity);
            const result = await (async () => {
                if (target.kind !== 'service') {
                    return params.replace({
                        target,
                        expectedRevision: input.expectedRevision,
                        replacement: Object.freeze({
                            values: preview.values,
                            secretRefs: Object.freeze(
                                Object.fromEntries(
                                    Object.entries(current?.secretRefs ?? {})
                                        .filter(([fieldId]) => !Object.prototype.hasOwnProperty.call(
                                            replacements,
                                            fieldId,
                                        )),
                                ),
                            ),
                            secretValues: Object.freeze({
                                ...(current?.secretValues ?? {}),
                                ...replacements,
                            }),
                        }),
                        ...generationIdentity,
                    });
                }
                if (!params.replaceForControl) {
                    return Object.freeze({
                        status: 'unavailable' as const,
                        code: 'connected_account_configuration_atomic_persistence_unavailable',
                    });
                }
                return params.replaceForControl({
                    target,
                    expectedRevision: input.expectedRevision,
                    values: preview.values,
                    currentSecretRefs: current?.secretRefs ?? Object.freeze({}),
                    secretValues: replacements,
                    ...generationIdentity,
                });
            })();
            if (result.status !== 'committed') {
                return Object.freeze({
                    status: result.status,
                    code: result.code ?? (
                        result.status === 'conflict'
                            ? 'connected_account_configuration_changed'
                            : 'connected_account_configuration_unavailable'
                    ),
                });
            }
            await assertGenerationCurrent(service, generationIdentity);
            const committed = await normalize({
                target,
                mode: input.mode,
                record: result.record,
            });
            if (committed.revision === null || committed.missingFieldIds.length > 0) {
                throw new ConnectedAccountConfigurationError(
                    'connected_account_configuration_unavailable',
                    'Configuration persistence returned an invalid committed record',
                );
            }
            if (!await isTargetRevisionCurrent(
                service,
                generationIdentity,
                target,
                committed.revision,
            )) {
                return Object.freeze({
                    status: 'conflict' as const,
                    code: 'connected_account_configuration_changed',
                });
            }
            const snapshot = createSnapshot({
                target,
                mode: input.mode,
                generation: generationIdentity,
                revision: committed.revision,
                values: committed.values,
                secretRefs: committed.secretRefs,
                secretValues: committed.secretValues,
            });
            return Object.freeze({ status: 'committed' as const, snapshot });
        },

        async admit(input: Readonly<{
            intent: 'connect' | 'reconnect';
            service: PluginContributionRef;
            account?: Readonly<{ service: PluginContributionRef; accountId: string }>;
            mode: PluginConnectedAccountAuthenticationModeV2;
            attemptId?: string;
            expectedConfigurationRevision?: string;
            generation: string;
            immutableGenerationId: string;
        }>): Promise<ConnectedAccountAttemptConfigurationAdmission> {
            const generationIdentity = Object.freeze({
                generation: input.generation,
                immutableGenerationId: input.immutableGenerationId,
            });
            await assertGenerationCurrent(input.service, generationIdentity);
            const target = resolveTarget(input);
            const configuration = modeConfiguration(input.mode);
            if (!configuration) {
                const snapshot = createSnapshot({
                    target,
                    mode: input.mode,
                    generation: generationIdentity,
                    revision: 'unconfigured',
                    values: Object.freeze({}),
                    secretRefs: Object.freeze({}),
                    unconfigured: true,
                });
                return Object.freeze({ status: 'ready', snapshot });
            }
            const record = await params.read(target);
            await assertGenerationCurrent(input.service, generationIdentity);
            const normalized = await normalize({ target, mode: input.mode, record });
            if (!await isTargetRevisionCurrent(
                input.service,
                generationIdentity,
                target,
                normalized.revision,
            )) {
                return Object.freeze({
                    status: 'conflict',
                    code: 'connected_account_configuration_changed',
                });
            }
            if (
                input.expectedConfigurationRevision !== undefined
                && normalized.revision !== input.expectedConfigurationRevision
            ) {
                return Object.freeze({
                    status: 'conflict',
                    code: 'connected_account_configuration_changed',
                });
            }
            if (normalized.missingFieldIds.length > 0) {
                return Object.freeze({
                    status: 'configurationRequired',
                    target,
                    missingFieldIds: normalized.missingFieldIds,
                });
            }
            if (normalized.revision === null) {
                return Object.freeze({
                    status: 'configurationRequired',
                    target,
                    missingFieldIds: Object.freeze([]),
                });
            }
            const snapshot = createSnapshot({
                target,
                mode: input.mode,
                generation: generationIdentity,
                revision: normalized.revision,
                values: normalized.values,
                secretRefs: normalized.secretRefs,
                secretValues: normalized.secretValues,
            });
            return Object.freeze({
                status: 'ready',
                snapshot,
                ...(target.kind === 'attempt' ? {
                    stagedAccountConfigurationContent: Object.freeze({
                        values: normalized.values,
                        secretRefs: normalized.secretRefs,
                        ...(Object.keys(normalized.secretValues).length > 0
                            ? { secretValues: normalized.secretValues }
                            : {}),
                    }),
                } : {}),
            });
        },

        async replace(input: Readonly<{
            target: ConnectedAccountConfigurationTarget;
            mode: PluginConnectedAccountAuthenticationModeV2;
            expectedRevision: string | null;
            replacement: ConfigurationReplacement;
            generation: string;
            immutableGenerationId: string;
        }>) {
            const target = snapshotTarget(input.target);
            assertTargetMatchesMode(target, input.mode);
            const configuration = modeConfiguration(input.mode);
            if (!configuration) {
                throw invalid('A mode without configuration cannot persist a configuration record');
            }
            const service = serviceForTarget(target);
            const generationIdentity = Object.freeze({
                generation: input.generation,
                immutableGenerationId: input.immutableGenerationId,
            });
            await assertGenerationCurrent(service, generationIdentity);
            const normalized = await normalize({
                target,
                mode: input.mode,
                record: null,
                replacement: input.replacement,
            });
            if (normalized.missingFieldIds.length > 0) {
                throw invalid(`Required configuration fields are missing: ${normalized.missingFieldIds.join(', ')}`);
            }
            if (!await isTargetRevisionCurrent(
                service,
                generationIdentity,
                target,
                input.expectedRevision,
            )) {
                return Object.freeze({
                    status: 'conflict' as const,
                    code: 'connected_account_configuration_changed',
                });
            }
            const result = await params.replace({
                target,
                expectedRevision: input.expectedRevision,
                replacement: Object.freeze({
                    values: normalized.values,
                    secretRefs: normalized.secretRefs,
                    ...(Object.keys(normalized.secretValues).length > 0
                        ? { secretValues: normalized.secretValues }
                        : {}),
                }),
                ...generationIdentity,
            });
            if (result.status !== 'committed') {
                return Object.freeze({
                    status: result.status,
                    code: result.code ?? (
                        result.status === 'conflict'
                            ? 'connected_account_configuration_changed'
                            : 'connected_account_configuration_unavailable'
                    ),
                });
            }
            const committed = await normalize({ target, mode: input.mode, record: result.record });
            if (committed.revision === null || committed.missingFieldIds.length > 0) {
                throw new ConnectedAccountConfigurationError(
                    'connected_account_configuration_unavailable',
                    'Configuration persistence returned an invalid committed record',
                );
            }
            if (!await isTargetRevisionCurrent(
                service,
                generationIdentity,
                target,
                committed.revision,
            )) {
                return Object.freeze({
                    status: 'conflict' as const,
                    code: 'connected_account_configuration_changed',
                });
            }
            const snapshot = createSnapshot({
                target,
                mode: input.mode,
                generation: generationIdentity,
                revision: committed.revision,
                values: committed.values,
                secretRefs: committed.secretRefs,
                secretValues: committed.secretValues,
            });
            return Object.freeze({ status: 'committed' as const, snapshot });
        },

        async isCurrent(snapshot: PluginConnectedAccountRuntimeConfiguration): Promise<boolean> {
            const metadata = snapshotMetadata.get(snapshot);
            if (!metadata) return false;
            const service = serviceForTarget(metadata.target);
            try {
                if (!await params.isGenerationCurrent({ pluginId: service.pluginId, ...metadata.generation })) {
                    return false;
                }
                if (metadata.unconfigured) return true;
                return await isTargetRevisionCurrent(
                    service,
                    metadata.generation,
                    metadata.target,
                    metadata.revision,
                );
            } catch {
                return false;
            }
        },

        async destroyAttempt(attemptId: string): Promise<void> {
            assertBoundedIdentity(attemptId, 'Connected-account attempt id');
            await params.destroyAttempt(attemptId);
        },
    };
    return Object.freeze(owner);
}
