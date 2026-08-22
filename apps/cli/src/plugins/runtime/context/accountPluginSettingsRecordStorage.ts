import axios from 'axios';
import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
    AccountEncryptionModeResponseSchema,
    openAccountScopedBlobCiphertext,
    PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
    PluginAccountSettingsMutationResponseV1Schema,
    PluginAccountSettingsReadResponseV1Schema,
    PluginAccountSettingsValuesV1Schema,
    sealAccountScopedBlobCiphertext,
    type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';
import { isPluginError, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readStoredCredentials, type Credentials, type StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { requireAccountSettingsEncryptionCredentials } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { resolveAccountSettingsHttpBaseUrl } from '@/settings/accountSettings/resolveAccountSettingsHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import {
    subscribePluginAccountSettingsWatchInvalidation,
    type PluginAccountSettingsWatchInvalidation,
} from './pluginAccountSettingsChangeBroker';

import type {
    PluginAccountSettingsRecordAdapter,
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

    async function currentCredentials(signal?: AbortSignal): Promise<StoredCredentials | null> {
        signal?.throwIfAborted();
        const credentials = await readCredentials();
        signal?.throwIfAborted();
        return credentials && isCurrentAccount(credentials) ? credentials : null;
    }

    function isStillCurrent(credentials: StoredCredentials, signal?: AbortSignal): boolean {
        signal?.throwIfAborted();
        return isCurrentAccount(credentials);
    }

    async function readRecord(
        model: StablePluginSettingsModel,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginAccountSettingsRecordRead> {
        const credentials = await currentCredentials(options?.signal);
        if (!credentials) return unavailableRead();
        try {
            const response = await http.get(
                `${resolveBaseUrl()}/v1/account/plugin-settings/${encodePluginId(model.identity.pluginId)}`,
                requestConfig(credentials, options?.signal),
            );
            if (!isStillCurrent(credentials, options?.signal)) return unavailableRead();
            if (response.status < 200 || response.status >= 300) return unavailableRead();
            const modeResponse = await http.get(
                `${resolveBaseUrl()}/v1/account/encryption`,
                requestConfig(credentials, options?.signal),
            );
            if (!isStillCurrent(credentials, options?.signal)) return unavailableRead();
            if (modeResponse.status < 200 || modeResponse.status >= 300) return unavailableRead();
            const mode = AccountEncryptionModeResponseSchema.safeParse(modeResponse.data);
            if (!mode.success) return unavailableRead();
            return parseAccountRecordResponse(response.data, credentials, mode.data.mode);
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
        const credentials = await currentCredentials(options?.signal);
        if (!credentials) return unavailableWrite();
        let values: ReturnType<typeof PluginAccountSettingsValuesV1Schema.parse>;
        try {
            values = PluginAccountSettingsValuesV1Schema.parse({ v: 1, values: request.values });
        } catch {
            throw accountSettingsRecordError('Account plugin settings values exceed their canonical record bounds');
        }
        try {
            const modeResponse = await http.get(
                `${resolveBaseUrl()}/v1/account/encryption`,
                requestConfig(credentials, options?.signal),
            );
            if (!isStillCurrent(credentials, options?.signal)) return unavailableWrite();
            if (modeResponse.status < 200 || modeResponse.status >= 300) return unavailableWrite();
            const mode = AccountEncryptionModeResponseSchema.safeParse(modeResponse.data);
            if (!mode.success) return unavailableWrite();
            const content = mode.data.mode === 'plain'
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
            const response = await http.post(
                `${resolveBaseUrl()}/v1/account/plugin-settings/${encodePluginId(model.identity.pluginId)}`,
                { expectedRevision: request.expectedRevision, content },
                requestConfig(credentials, options?.signal),
            );
            if (!isStillCurrent(credentials, options?.signal)) return unavailableWrite();
            if (response.status < 200 || response.status >= 300) return unavailableWrite();
            const parsed = PluginAccountSettingsMutationResponseV1Schema.safeParse(response.data);
            return parsed.success ? parsed.data : unavailableWrite();
        } catch (error) {
            options?.signal?.throwIfAborted();
            if (isPluginError(error)) throw error;
            return unavailableWrite();
        }
    }

    return Object.freeze({
        isAvailable() {
            return getActiveAccountSettingsSnapshot() !== null;
        },
        readRecord,
        writeRecord,
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
