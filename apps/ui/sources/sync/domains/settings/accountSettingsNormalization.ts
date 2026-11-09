import {
    AccountSettingsStoredContentEnvelopeSchema,
    type AccountSettingsStoredContentEnvelope,
} from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { openAccountScopedBlobCiphertext, type AccountScopedCiphertextFormat, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

import type { Encryption } from '@/sync/encryption/encryption';
import {
    assertNoUnsealedSettingsSecretValues,
    resealSecretsDeep,
    sealSecretsDeep,
    unsealSecretsDeepWithKeys,
} from '@/sync/encryption/secretSettings';

import { stripLocalOnlyAccountSettings } from './localOnlyAccountSettings';
import { parseLocalAccountSettings } from './registry/local/localAccountSettingDefinitions';
import {
    projectRuntimeAccountSettings,
    settingsDefaults,
    settingsParse,
    type Settings,
} from './settings';

export type AccountSettingsStorageMode = 'plain' | 'e2ee';

export class AccountSettingsStoredContentUnavailableError extends Error {
    readonly code:
        | 'account_settings_content_invalid'
        | 'account_settings_encryption_material_unavailable'
        | 'account_settings_content_unreadable';

    constructor(
        code:
            | 'account_settings_content_invalid'
            | 'account_settings_encryption_material_unavailable'
            | 'account_settings_content_unreadable',
        message: string,
    ) {
        super(message);
        this.name = 'AccountSettingsStoredContentUnavailableError';
        this.code = code;
    }
}

export type OpenedAccountSettingsStoredContent = Readonly<{
    mode: AccountSettingsStorageMode;
    raw: Record<string, unknown> | null;
    format: AccountScopedCiphertextFormat | 'plain' | 'empty';
}>;

type OpenAccountSettingsStoredContentParams = Readonly<{
    content: unknown;
    expectedMode?: AccountSettingsStorageMode;
}> & (Readonly<{ encryption: Encryption | null; material?: never }>
    | Readonly<{ material: AccountScopedCryptoMaterial | null; encryption?: never }>);

export function openAccountSettingsStoredContent(
    params: OpenAccountSettingsStoredContentParams & Readonly<{ content: AccountSettingsStoredContentEnvelope }>,
): OpenedAccountSettingsStoredContent & Readonly<{ raw: Record<string, unknown> }>;
export function openAccountSettingsStoredContent(
    params: OpenAccountSettingsStoredContentParams,
): OpenedAccountSettingsStoredContent;
export function openAccountSettingsStoredContent(
    params: OpenAccountSettingsStoredContentParams,
): OpenedAccountSettingsStoredContent {
    if (params.content === null) {
        return {
            mode: params.expectedMode ?? 'plain',
            raw: null,
            format: 'empty',
        };
    }

    const parsed = AccountSettingsStoredContentEnvelopeSchema.safeParse(params.content);
    if (!parsed.success) {
        throw new AccountSettingsStoredContentUnavailableError(
            'account_settings_content_invalid',
            'Invalid account settings stored content',
        );
    }
    const content = parsed.data;
    const mode: AccountSettingsStorageMode = content.t === 'plain' ? 'plain' : 'e2ee';
    if (params.expectedMode && mode !== params.expectedMode) {
        throw new AccountSettingsStoredContentUnavailableError(
            'account_settings_content_invalid',
            'Account settings stored content does not match the account encryption mode',
        );
    }
    if (content.t === 'plain') {
        return { mode, raw: content.v, format: 'plain' };
    }
    const material = params.material ?? (params.encryption ? {
        type: 'dataKey' as const,
        machineKey: params.encryption.getContentPrivateKey(),
    } : null);
    if (!material) {
        throw new AccountSettingsStoredContentUnavailableError(
            'account_settings_encryption_material_unavailable',
            'Account settings encryption material is unavailable',
        );
    }

    const opened = openAccountScopedBlobCiphertext({
        kind: 'account_settings',
        material,
        ciphertext: content.c,
    });
    if (!opened?.value || typeof opened.value !== 'object' || Array.isArray(opened.value)) {
        throw new AccountSettingsStoredContentUnavailableError(
            'account_settings_content_unreadable',
            'Account settings ciphertext has no authenticated settings domain',
        );
    }
    return {
        mode,
        raw: opened.value as Record<string, unknown>,
        format: opened.format,
    };
}

export function normalizeAccountSettingsForLocalStorage(params: Readonly<{
    raw: Record<string, unknown> | null;
    mode: AccountSettingsStorageMode;
    settingsSecretsKey: Uint8Array | null;
    settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
    localSettings?: unknown;
    normalizeServerRaw?: (raw: Record<string, unknown>) => Record<string, unknown>;
}>): Settings {
    const serverRaw = params.raw
        ? (params.normalizeServerRaw?.(params.raw) ?? params.raw)
        : { ...settingsDefaults };
    const parsed = settingsParse(serverRaw);
    const locallySealed = params.mode === 'plain'
        ? sealSecretsDeep(parsed, params.settingsSecretsKey)
        : params.settingsSecretsKey
            ? resealSecretsDeep(parsed, {
                readKeys: params.settingsSecretsReadKeys ?? [params.settingsSecretsKey],
                writeKey: params.settingsSecretsKey,
            }).value as Settings
            : sealSecretsDeep(parsed, null);
    const localOnly = parseLocalAccountSettings(params.localSettings);
    return projectRuntimeAccountSettings({
        ...locallySealed,
        ...localOnly,
    }) as Settings;
}

export function normalizeAccountSettingsForServerStorage(params: Readonly<{
    raw: Settings | Record<string, unknown>;
    mode: AccountSettingsStorageMode;
    settingsSecretsKey: Uint8Array | null;
    settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
    normalizeServerRaw?: (raw: Record<string, unknown>) => Record<string, unknown>;
}>): Readonly<{ value: Record<string, unknown>; secretsChanged: boolean }> {
    const localOnlyStripped = stripLocalOnlyAccountSettings(params.raw) as Record<string, unknown>;
    const normalized = params.normalizeServerRaw?.(localOnlyStripped) ?? localOnlyStripped;
    // A write must not commit a document this device cannot seal for local persistence.
    // This admission needs the raw secret carriers, not another Settings schema parse.
    if (!params.settingsSecretsKey) assertNoUnsealedSettingsSecretValues(normalized);
    if (params.mode === 'plain') {
        const unsealed = unsealSecretsDeepWithKeys(
            normalized,
            params.settingsSecretsReadKeys ?? (params.settingsSecretsKey ? [params.settingsSecretsKey] : []),
        ) as Record<string, unknown>;
        return { value: unsealed, secretsChanged: unsealed !== normalized };
    }
    if (!params.settingsSecretsKey) {
        return { value: normalized, secretsChanged: false };
    }
    const resealed = resealSecretsDeep(normalized, {
        readKeys: params.settingsSecretsReadKeys ?? [params.settingsSecretsKey],
        writeKey: params.settingsSecretsKey,
    });
    return {
        value: resealed.value as Record<string, unknown>,
        secretsChanged: resealed.changed,
    };
}

export function hydrateAccountSettingsFromLocalPersistence<T>(input: T): T {
    assertNoUnsealedSettingsSecretValues(input);
    return input;
}
