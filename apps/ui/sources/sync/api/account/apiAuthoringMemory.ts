import {
    AUTHORING_MEMORY_ROUTE_V1,
    AuthoringMemoryListResponseV1Schema,
    AuthoringMemoryReadResponseV1Schema,
    AuthoringMemoryMutationResponseV1Schema,
    AuthoringMemoryMutationRequestV1Schema,
} from '@happier-dev/protocol/account/authoringMemory';
import type { AuthoringMemoryTransport } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { LegacyLastUsedProfileSchema } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';
import { importAuthoringMemoryRowAbsent, importLegacyAuthoringMemorySetting } from '@happier-dev/protocol/account/authoringMemoryImport';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { requireOneShotAccountSettingsMutationApplied, retireLegacyAuthoringMemoryKey } from '@/sync/engine/settings/syncSettings';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** Reuses the reserved Account-row route shape with an exact Home/Account request. */
export function createApiAuthoringMemoryTransport(options: Readonly<{
    request(path: string, init?: RequestInit): Promise<Response>;
}>): AuthoringMemoryTransport {
    async function request(path: string, init?: RequestInit): Promise<unknown> {
        const response = await options.request(path, init);
        // CAS conflicts are typed successful domain outcomes, not transport retries.
        if (!response.ok && response.status !== 409) {
            const message = `Authoring memory request failed (${response.status})`;
            // List, read and mutate share the protocol's storage-unavailable response.
            if (response.status === 503) throw new RetryableServerResponseError(response.status, message);
            throw new Error(message);
        }
        return await response.json();
    }
    const path = (key: string) => `${AUTHORING_MEMORY_ROUTE_V1}/${encodeURIComponent(key)}`;
    return {
        list: async () => AuthoringMemoryListResponseV1Schema.parse(await request(AUTHORING_MEMORY_ROUTE_V1)),
        read: async (key) => AuthoringMemoryReadResponseV1Schema.parse(await request(path(key))),
        mutate: async (key, expectedRevision, content) => AuthoringMemoryMutationResponseV1Schema.parse(await request(path(key), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(AuthoringMemoryMutationRequestV1Schema.parse({ expectedRevision, content })),
        })),
    };
}

/** Exact selection evidence without bootstrapping or publishing unrelated memory rows. */
export async function readAuthoringMemoryLastUsedProfileInContext(
    account: LazyActionAccountContext, signal?: AbortSignal,
): Promise<string | null> {
    const assertCurrent = () => { signal?.throwIfAborted(); account.assertCurrent(); };
    assertCurrent();
    const request: typeof account.request = (path, init, options) => account.request(path,
        { ...init, signal }, { ...options, retry: 'none' });
    const { encryption } = await account.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(account.credentials, { encryption, request });
    assertCurrent();
    const cipher = createAuthoringMemoryCipher({ mode: storage.mode,
        material: storage.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(account.credentials),
        randomBytes: getRandomBytes });
    const transport = createApiAuthoringMemoryTransport({ request });
    let row = await transport.read('lastUsedProfile');
    const open = () => {
        assertCurrent();
        return row.status === 'present' ? LegacyLastUsedProfileSchema.parse(cipher.open('lastUsedProfile', row.content)) : null;
    };
    open();
    // The shared importer preserves destination winners and tombstones before retiring the shipped alias.
    await importLegacyAuthoringMemorySetting({ key: 'lastUsedProfile', assertCurrent,
        read: () => readAccountSettingsBaseline({ request, credentials: account.credentials, encryption, accountMode: storage.mode }),
        transfer: async value => {
            row = await importAuthoringMemoryRowAbsent({ key: 'lastUsedProfile', value: LegacyLastUsedProfileSchema.parse(value),
                assertCurrent, read: transport.read, mutate: transport.mutate, seal: cipher.seal });
            open();
        },
        remove: async (key, expectedSettingsVersion) => {
            const result = await retireLegacyAuthoringMemoryKey({ credentials: account.credentials, encryption,
                accountMode: storage.mode, settingsScope: account.accountLifetime.scope,
                requestContext: { scope: account.accountLifetime.scope, endpointUrl: account.endpointUrl, request },
                key, expectedSettingsVersion });
            if (result.status === 'conflict' || result.status === 'outcomeUnknown') return result.status;
            requireOneShotAccountSettingsMutationApplied(result);
            return 'applied';
        },
    });
    return open();
}
