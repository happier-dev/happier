import axios from '@/api/client/credentialAxios';
import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1, PluginAccountSettingsMutationResponseV1Schema, PluginAccountSettingsReadResponseV1Schema, PluginAccountSettingsStorageUnavailableV1Schema, PluginAccountSettingsValuesV1Schema, PluginAccountSettingsValuesV1StoredSchema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol';
import { isPluginError, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { readStoredCredentials, type Credentials, type StoredCredentials } from '@/persistence';
import {
    getActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { requireAccountSettingsEncryptionCredentials } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveAccountSettingsHttpBaseUrl } from '@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import {
    subscribePluginAccountSettingsWatchInvalidation,
    type PluginAccountSettingsWatchInvalidation,
} from './pluginAccountSettingsChangeBroker';

import type {
    PluginAccountSettingsRecordAdapter,
    PluginAccountSettingsRecordAccess,
    PluginAccountSettingsRecordRead,
    PluginAccountSettingsRecordWriteResult,
    StablePluginSettingsModel,
} from '../invocation/services/settings';

type AccountPluginSettingsHttpClient = Readonly<{
    get(url: string, config: Readonly<Record<string, unknown>>): Promise<Readonly<{
        status: number;
        data: unknown;
    }>>;
    post(url: string, body: unknown, config: Readonly<Record<string, unknown>>): Promise<Readonly<{
        status: number;
        data: unknown;
    }>>;
}>;

export type PluginAccountSettingsChangeHint = PluginAccountSettingsWatchInvalidation;

function resolveMaterial(credentials: Credentials): AccountScopedCryptoMaterial {
    return credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: credentials.encryption.secret }
        : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function requestConfig(credentials: StoredCredentials, signal?: AbortSignal): Readonly<Record<string, unknown>> {
    return {
        headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        validateStatus: () => true,
        ...(signal ? { signal } : {}),
    };
}

function persistenceFailure(code: string, phase: string, httpStatus?: number): PluginError {
    return new PluginError({ code,
        message: `Account plugin settings ${phase} failed: ${code}${httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`}` });
}

function unavailableRead(error: PluginError): PluginAccountSettingsRecordRead {
    return Object.freeze({ status: 'unavailable' as const, error });
}

function unavailableWrite(error: PluginError): PluginAccountSettingsRecordWriteResult {
    return Object.freeze({ status: 'unavailable' as const, error });
}

/** Boundary exception codes are non-content; never copy messages, request config or bodies. */
function boundaryFailure(error: unknown, phase: string): PluginError {
    if (isPluginError(error)) return error;
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code : 'plugin_settings_transport_error';
    return persistenceFailure(code, phase);
}

function outcomeUnknownWrite(): PluginAccountSettingsRecordWriteResult {
    return Object.freeze({ status: 'outcomeUnknown' as const });
}

function accountSettingsRecordError(message: string): PluginError {
    return new PluginError({
        code: 'plugin_settings_record_bounded',
        message,
    });
}

function parseValues(value: unknown): Readonly<Record<string, JsonValue>> | null {
    const parsed = PluginAccountSettingsValuesV1StoredSchema.safeParse(value);
    return parsed.success ? parsed.data.values as Readonly<Record<string, JsonValue>> : null;
}

function parseAccountRecordResponse(
    value: unknown,
    credentials: StoredCredentials,
    mode: 'plain' | 'e2ee',
    httpStatus: number,
): PluginAccountSettingsRecordRead {
    const parsed = PluginAccountSettingsReadResponseV1Schema.safeParse(value);
    if (!parsed.success) return unavailableRead(persistenceFailure('plugin_settings_record_invalid', 'record read', httpStatus));
    if (parsed.data.status === 'absent' || parsed.data.status === 'deleted') return parsed.data;
    const content = parsed.data.content;
    if (mode === 'plain') {
        if (content.t !== 'plain') return unavailableRead(persistenceFailure('plugin_settings_mode_envelope_mismatch', 'record read', httpStatus));
        const values = parseValues(content.v);
        return values === null
            ? unavailableRead(persistenceFailure('plugin_settings_values_invalid', 'record read', httpStatus))
            : Object.freeze({
                status: 'present' as const,
                revision: parsed.data.revision,
                values,
            });
    }
    if (content.t !== 'encrypted') return unavailableRead(persistenceFailure('plugin_settings_mode_envelope_mismatch', 'record read', httpStatus));
    const opened = openAccountScopedBlobCiphertext({
        kind: PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
        material: resolveMaterial(requireAccountSettingsEncryptionCredentials(credentials)),
        ciphertext: content.c,
    });
    if (!opened) return unavailableRead(persistenceFailure('plugin_settings_record_decryption_failed', 'record read', httpStatus));
    const values = parseValues(opened.value);
    return values === null
        ? unavailableRead(persistenceFailure('plugin_settings_values_invalid', 'record read', httpStatus))
        : Object.freeze({
            status: 'present' as const,
            revision: parsed.data.revision,
            values,
        });
}

function encodePluginId(pluginId: string): string {
    return encodeURIComponent(pluginId);
}

/**
 * The only CLI adapter for the reserved Account Settings record. It speaks the
 * explicit envelope/CAS route and never reads or writes Account preference
 * roots, generic KV, or a daemon-local fallback.
 */
export function createAccountPluginSettingsRecordStorage(params: Readonly<{
    readCredentials?: () => Promise<StoredCredentials | null>;
    isCurrentAccount?: (credentials: StoredCredentials) => boolean | Promise<boolean>;
    http?: AccountPluginSettingsHttpClient;
    resolveBaseUrl?: () => string;
    randomBytes?: (length: number) => Uint8Array;
    subscribeChanges?: (listener: (hint: PluginAccountSettingsChangeHint) => void) => () => void;
}> = {}): PluginAccountSettingsRecordAdapter {
    const readCredentials = params.readCredentials ?? readStoredCredentials;
    const http: AccountPluginSettingsHttpClient = params.http ?? axios;
    const resolveBaseUrl = params.resolveBaseUrl ?? resolveAccountSettingsHttpBaseUrl;
    const isCurrentAccount = params.isCurrentAccount ?? ((credentials: StoredCredentials): boolean => {
        const active = getActiveAccountSettingsSnapshot();
        if (!active) return false;
        return !active.scopeKey || active.scopeKey === resolveAccountSettingsScopeKey(credentials);
    });
    const randomBytes = params.randomBytes ?? ((length: number) => new Uint8Array(nodeRandomBytes(length)));
    const subscribeChanges = params.subscribeChanges ?? subscribePluginAccountSettingsWatchInvalidation;

    async function bindOperation(options?: Readonly<{ signal?: AbortSignal }>): Promise<PluginAccountSettingsRecordAccess> {
        options?.signal?.throwIfAborted();
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const baseUrl = resolveBaseUrl();
        const credentials = await readCredentials();
        options?.signal?.throwIfAborted();

        async function isStillCurrent(signal?: AbortSignal): Promise<boolean> {
            signal?.throwIfAborted();
            if (!credentials || lifetime !== getActiveAccountSettingsSnapshotLifetimeToken()
                || baseUrl !== resolveBaseUrl()) return false;
            const current = await isCurrentAccount(credentials);
            signal?.throwIfAborted();
            return current && lifetime === getActiveAccountSettingsSnapshotLifetimeToken()
                && baseUrl === resolveBaseUrl();
        }

        async function readRecord(
            model: StablePluginSettingsModel,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<PluginAccountSettingsRecordRead> {
            if (!credentials) return unavailableRead(persistenceFailure('plugin_settings_credentials_unavailable', 'record read'));
            if (!await isStillCurrent(options?.signal)) return unavailableRead(persistenceFailure('plugin_settings_account_context_changed', 'record read'));
            let phase = 'record read';
            try {
                const response = await http.get(
                    `${baseUrl}/v1/account/plugin-settings/${encodePluginId(model.identity.pluginId)}`,
                    requestConfig(credentials, options?.signal),
                );
                if (!await isStillCurrent(options?.signal)) return unavailableRead(persistenceFailure('plugin_settings_account_context_changed', phase));
                if (response.status < 200 || response.status >= 300) {
                    const unavailable = PluginAccountSettingsStorageUnavailableV1Schema.safeParse(response.data);
                    return unavailableRead(persistenceFailure(unavailable.success ? unavailable.data.error : 'plugin_settings_record_http_error', phase, response.status));
                }
                phase = 'encryption mode read';
                const mode = await readAccountEncryptionModeOnce({
                    credentials,
                    request: async () => await http.get(
                        `${baseUrl}/v1/account/encryption`,
                        requestConfig(credentials, options?.signal),
                    ),
                });
                if (!await isStillCurrent(options?.signal)) return unavailableRead(persistenceFailure('plugin_settings_account_context_changed', phase));
                if (mode.kind !== 'resolved') return unavailableRead(persistenceFailure(`plugin_settings_mode_${mode.kind}`, phase, mode.status));
                phase = 'record decode';
                return parseAccountRecordResponse(response.data, credentials, mode.mode, response.status);
            } catch (error) {
                options?.signal?.throwIfAborted();
                return unavailableRead(boundaryFailure(error, phase));
            }
        }

        async function writeRecord(
            model: StablePluginSettingsModel,
            request: Readonly<{
                expectedRevision: number | 'absent';
                values: Readonly<Record<string, JsonValue>>;
            }>,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<PluginAccountSettingsRecordWriteResult> {
            if (!credentials) return unavailableWrite(persistenceFailure('plugin_settings_credentials_unavailable', 'record write'));
            if (!await isStillCurrent(options?.signal)) return unavailableWrite(persistenceFailure('plugin_settings_account_context_changed', 'record write'));
            let values: ReturnType<typeof PluginAccountSettingsValuesV1Schema.parse>;
            try {
                values = PluginAccountSettingsValuesV1Schema.parse({ v: 1, values: request.values });
            } catch {
                throw accountSettingsRecordError('Account plugin settings values exceed their canonical record bounds');
            }
            let issued = false;
            try {
                const mode = await readAccountEncryptionModeOnce({
                    credentials,
                    request: async () => await http.get(
                        `${baseUrl}/v1/account/encryption`,
                        requestConfig(credentials, options?.signal),
                    ),
                });
                if (!await isStillCurrent(options?.signal)) return unavailableWrite(persistenceFailure('plugin_settings_account_context_changed', 'encryption mode read'));
                if (mode.kind !== 'resolved') return unavailableWrite(persistenceFailure(`plugin_settings_mode_${mode.kind}`, 'encryption mode read', mode.status));
                const content = mode.mode === 'plain'
                    ? { t: 'plain' as const, v: values }
                    : {
                        t: 'encrypted' as const,
                        c: sealAccountScopedBlobCiphertext({
                            kind: PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
                            material: resolveMaterial(requireAccountSettingsEncryptionCredentials(credentials)),
                            payload: values,
                            randomBytes,
                        }),
                    };
                issued = true;
                const response = await http.post(
                    `${baseUrl}/v1/account/plugin-settings/${encodePluginId(model.identity.pluginId)}`,
                    { expectedRevision: request.expectedRevision, content },
                    requestConfig(credentials, options?.signal),
                );
                if (
                    response.status === 503
                    && PluginAccountSettingsStorageUnavailableV1Schema.safeParse(response.data).success
                ) {
                    return unavailableWrite(persistenceFailure('plugin_account_settings_storage_unavailable', 'record write', response.status));
                }
                if (response.status < 200 || response.status >= 300) return outcomeUnknownWrite();
                const parsed = PluginAccountSettingsMutationResponseV1Schema.safeParse(response.data);
                if (parsed.success) return parsed.data;
                return outcomeUnknownWrite();
            } catch (error) {
                if (isPluginError(error)) throw error;
                if (issued) return outcomeUnknownWrite();
                options?.signal?.throwIfAborted();
                return unavailableWrite(boundaryFailure(error, 'record write preparation'));
            }
        }

        return Object.freeze({ readRecord, writeRecord });
    }

    return Object.freeze({
        isAvailable() {
            return getActiveAccountSettingsSnapshot() !== null;
        },
        bindOperation,
        watchRecord(model: StablePluginSettingsModel, listener: (hint: Readonly<{ revision?: number }>) => void) {
            return subscribeChanges((hint) => {
                if (hint.kind === 'full') {
                    listener({});
                } else if (hint.pluginId === model.identity.pluginId) {
                    listener({ revision: hint.revision });
                }
            });
        },
    });
}
