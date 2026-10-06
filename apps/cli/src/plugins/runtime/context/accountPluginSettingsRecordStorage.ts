import axios from 'axios';
import { randomBytes as nodeRandomBytes } from 'node:crypto';

import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1, PluginAccountSettingsMutationResponseV1Schema, PluginAccountSettingsReadResponseV1Schema, PluginAccountSettingsStorageUnavailableV1Schema, PluginAccountSettingsValuesV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
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
        timeout: 15_000,
        validateStatus: () => true,
        ...(signal ? { signal } : {}),
    };
}

function unavailableRead(): PluginAccountSettingsRecordRead {
    return Object.freeze({ status: 'unavailable' as const });
}

function unavailableWrite(): PluginAccountSettingsRecordWriteResult {
    return Object.freeze({ status: 'unavailable' as const });
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
    const parsed = PluginAccountSettingsValuesV1Schema.safeParse(value);
    return parsed.success ? parsed.data.values as Readonly<Record<string, JsonValue>> : null;
}

function parseAccountRecordResponse(
    value: unknown,
    credentials: StoredCredentials,
    mode: 'plain' | 'e2ee',
): PluginAccountSettingsRecordRead {
    const parsed = PluginAccountSettingsReadResponseV1Schema.safeParse(value);
    if (!parsed.success) return unavailableRead();
    if (parsed.data.status === 'absent' || parsed.data.status === 'deleted') return parsed.data;
    const content = parsed.data.content;
    if (mode === 'plain') {
        if (content.t !== 'plain') return unavailableRead();
        const values = parseValues(content.v);
        return values === null
            ? unavailableRead()
            : Object.freeze({
                status: 'present' as const,
                revision: parsed.data.revision,
                values,
            });
    }
    if (content.t !== 'encrypted') return unavailableRead();
    if (!credentials.encryption) return unavailableRead();
    const opened = openAccountScopedBlobCiphertext({
        kind: PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
        material: resolveMaterial(credentials),
        ciphertext: content.c,
    });
    const values = opened ? parseValues(opened.value) : null;
    return values === null
        ? unavailableRead()
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
    isCurrentAccount?: (credentials: StoredCredentials) => boolean;
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

        function isStillCurrent(signal?: AbortSignal): boolean {
            signal?.throwIfAborted();
            return credentials !== null
                && lifetime === getActiveAccountSettingsSnapshotLifetimeToken()
                && baseUrl === resolveBaseUrl()
                && isCurrentAccount(credentials);
        }

        async function readRecord(
            model: StablePluginSettingsModel,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<PluginAccountSettingsRecordRead> {
            if (!credentials || !isStillCurrent(options?.signal)) return unavailableRead();
            try {
                const response = await http.get(
                    `${baseUrl}/v1/account/plugin-settings/${encodePluginId(model.identity.pluginId)}`,
                    requestConfig(credentials, options?.signal),
                );
                if (!isStillCurrent(options?.signal)) return unavailableRead();
                if (response.status < 200 || response.status >= 300) return unavailableRead();
                const mode = await readAccountEncryptionModeOnce({
                    request: async () => await http.get(
                        `${baseUrl}/v1/account/encryption`,
                        requestConfig(credentials, options?.signal),
                    ),
                });
                if (!isStillCurrent(options?.signal)) return unavailableRead();
                if (mode.kind !== 'resolved') return unavailableRead();
                return parseAccountRecordResponse(response.data, credentials, mode.mode);
            } catch (error) {
                options?.signal?.throwIfAborted();
                void error;
                return unavailableRead();
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
            if (!credentials || !isStillCurrent(options?.signal)) return unavailableWrite();
            let values: ReturnType<typeof PluginAccountSettingsValuesV1Schema.parse>;
            try {
                values = PluginAccountSettingsValuesV1Schema.parse({ v: 1, values: request.values });
            } catch {
                throw accountSettingsRecordError('Account plugin settings values exceed their canonical record bounds');
            }
            let issued = false;
            try {
                const mode = await readAccountEncryptionModeOnce({
                    request: async () => await http.get(
                        `${baseUrl}/v1/account/encryption`,
                        requestConfig(credentials, options?.signal),
                    ),
                });
                if (!isStillCurrent(options?.signal)) return unavailableWrite();
                if (mode.kind !== 'resolved') return unavailableWrite();
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
                    return unavailableWrite();
                }
                if (response.status < 200 || response.status >= 300) return outcomeUnknownWrite();
                const parsed = PluginAccountSettingsMutationResponseV1Schema.safeParse(response.data);
                if (parsed.success) return parsed.data;
                return outcomeUnknownWrite();
            } catch (error) {
                if (isPluginError(error)) throw error;
                if (issued) return outcomeUnknownWrite();
                options?.signal?.throwIfAborted();
                return unavailableWrite();
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
