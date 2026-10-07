import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { HappyError } from '@/utils/errors/errors';
import { openAccountSettingsStoredContent } from '@/sync/domains/settings/accountSettingsNormalization';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountScopedCiphertextFormat } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';

/**
 * Shared Account Settings baseline read seam.
 *
 * This is the one wire reader for the server's Account Settings baseline
 * (v2 with v1 back-compat) plus its canonical stored-content opening. The
 * focused sync loop consumes it for the active server, and per-Home callers
 * (for example push consent) consume it through an explicit Home-targeted
 * request; neither path may duplicate the wire parsing or envelope opening.
 *
 * `accountMode` is the persisted `Account.encryptionMode` authority supplied
 * by the caller. Opening an envelope that disagrees with it, or an encrypted
 * envelope without real E2EE material, fails closed with a typed
 * `AccountSettingsStoredContentUnavailableError`; it never reinterprets
 * content as the other branch or as defaults.
 */
export const SETTINGS_V2_NOT_SUPPORTED = 'settings_v2_not_supported';

export type AccountSettingsBaselineRequest = (path: string, init?: RequestInit) => Promise<Response>;

export type AccountSettingsBaselineContent = Readonly<{
    api: 'v2' | 'v1';
    content: AccountSettingsStoredContentEnvelope | null;
    version: number;
    raw: Record<string, unknown> | null;
    format: AccountScopedCiphertextFormat | 'plain' | 'empty';
}>;

async function fetchSettingsV2Content(params: Readonly<{
    request: AccountSettingsBaselineRequest;
    credentials: AuthCredentials;
}>): Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }> {
    const response = await params.request('/v2/account/settings', {
        headers: {
            'Authorization': `Bearer ${params.credentials.token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        if (response.status === 404) {
            // Back-compat: old servers only support v1.
            throw Object.assign(new Error(SETTINGS_V2_NOT_SUPPORTED), { code: SETTINGS_V2_NOT_SUPPORTED });
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new HappyError(`Failed to fetch settings (${response.status})`, false);
        }
        throw new Error(`Failed to fetch settings: ${response.status}`);
    }

    const data: unknown = await response.json();
    const parsed = AccountSettingsV2GetResponseSchema.safeParse(data);
    if (!parsed.success) {
        throw new Error('Failed to parse account settings v2 response');
    }
    return { content: parsed.data.content, version: parsed.data.version };
}

async function fetchSettingsV1Content(params: Readonly<{
    request: AccountSettingsBaselineRequest;
    credentials: AuthCredentials;
}>): Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }> {
    const response = await params.request('/v1/account/settings', {
        headers: {
            'Authorization': `Bearer ${params.credentials.token}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            throw new HappyError(`Failed to fetch settings (${response.status})`, false);
        }
        throw new Error(`Failed to fetch settings: ${response.status}`);
    }

    const data = (await response.json()) as { settings: string | null; settingsVersion: number };
    return { content: data.settings ? { t: 'encrypted', c: data.settings } : null, version: data.settingsVersion };
}

export async function readAccountSettingsBaseline(params: Readonly<{
    request: AccountSettingsBaselineRequest;
    credentials: AuthCredentials;
    encryption: Encryption | null;
    accountMode: 'plain' | 'e2ee';
}>): Promise<AccountSettingsBaselineContent> {
    try {
        const fetched = await fetchSettingsV2Content(params);
        const opened = openAccountSettingsStoredContent({
            content: fetched.content,
            encryption: params.encryption,
            expectedMode: params.accountMode,
        });
        return {
            api: 'v2',
            content: fetched.content,
            version: fetched.version,
            raw: opened.raw,
            format: opened.format,
        };
    } catch (error) {
        if ((error as { code?: unknown })?.code !== SETTINGS_V2_NOT_SUPPORTED) throw error;
        if (params.accountMode === 'plain') {
            throw new Error('Settings v2 is required but not supported by this server');
        }
        const fetched = await fetchSettingsV1Content(params);
        const opened = openAccountSettingsStoredContent({
            content: fetched.content,
            encryption: params.encryption,
            expectedMode: 'e2ee',
        });
        return {
            api: 'v1',
            content: fetched.content,
            version: fetched.version,
            raw: opened.raw,
            format: opened.format,
        };
    }
}
