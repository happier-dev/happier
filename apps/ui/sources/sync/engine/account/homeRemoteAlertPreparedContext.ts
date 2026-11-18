import { resolveAccountContentSecretKey, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

import { subscribeHomeCredentialMutations, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { subscribeAccountSettingsPersistenceMutations } from '@/sync/domains/state/accountSettingsPersistence';
import { subscribeLocalAttentionSettingsMutations } from '@/sync/domains/state/settingsPersistence';
import { subscribeAccountEncryptionModeCacheInvalidation } from '@/sync/api/account/apiAccountEncryptionMode';
import {
    clearActivityNotificationContext,
    prepareActivityNotificationContext,
    removeActivityNotificationContext,
} from '../../../../modules/happier-activity-notifications';

export type HomeRemoteAlertPreparedContextV1 = Readonly<{
    v: 1;
    serverId: string;
    apiEndpoint: string;
    accountId: string;
    credential:
        | Readonly<{ token: string; encryptionMode: 'plain' }>
        | Readonly<{ token: string; encryptionMode: 'legacy_e2ee'; machineKey: string }>
        | Readonly<{ token: string; encryptionMode: 'e2ee'; machineKey: string }>;
    settingsVersion: number;
    accountEncryptionVersion: number;
    registrationId: string;
    pushToken: string;
    previewCeiling: 'status_only' | 'title_only' | 'include_preview';
}>;

export type HomeRemoteAlertPreparedContextEnvelopeV1 = Readonly<{
    v: 1;
    homes: readonly HomeRemoteAlertPreparedContextV1[];
}>;

type Mutation =
    | Readonly<{ kind: 'upsert'; context: HomeRemoteAlertPreparedContextV1 }>
    | Readonly<{ kind: 'remove'; serverId: string; accountId: string; registrationId?: string }>
    | Readonly<{ kind: 'remove_home'; serverId: string }>;

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : null;
}

function parseCredential(value: unknown): HomeRemoteAlertPreparedContextV1['credential'] | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const token = text(row.token);
    if (!token) return null;
    if (row.encryptionMode === 'plain' && Object.keys(row).sort().join(',') === 'encryptionMode,token') {
        return { token, encryptionMode: 'plain' };
    }
    const machineKey = text(row.machineKey);
    if (machineKey && Object.keys(row).sort().join(',') === 'encryptionMode,machineKey,token') {
        if (row.encryptionMode === 'legacy_e2ee') return { token, encryptionMode: 'legacy_e2ee', machineKey };
        if (row.encryptionMode === 'e2ee') return { token, encryptionMode: 'e2ee', machineKey };
    }
    return null;
}

function parseContext(value: unknown): HomeRemoteAlertPreparedContextV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'accountEncryptionVersion,accountId,apiEndpoint,credential,previewCeiling,pushToken,registrationId,serverId,settingsVersion,v') return null;
    const serverId = text(row.serverId);
    const apiEndpoint = text(row.apiEndpoint);
    const accountId = text(row.accountId);
    const registrationId = text(row.registrationId);
    const pushToken = text(row.pushToken);
    const credential = parseCredential(row.credential);
    const settingsVersion = typeof row.settingsVersion === 'number' && Number.isSafeInteger(row.settingsVersion) && row.settingsVersion >= 0
        ? row.settingsVersion : null;
    const accountEncryptionVersion = typeof row.accountEncryptionVersion === 'number'
        && Number.isSafeInteger(row.accountEncryptionVersion) && row.accountEncryptionVersion >= 0
        ? row.accountEncryptionVersion : null;
    const previewCeiling = row.previewCeiling === 'status_only' || row.previewCeiling === 'title_only' || row.previewCeiling === 'include_preview'
        ? row.previewCeiling : null;
    if (row.v !== 1 || !serverId || !apiEndpoint || !accountId || !registrationId || !pushToken || !credential
        || settingsVersion === null || accountEncryptionVersion === null || !previewCeiling) return null;
    try {
        const url = new URL(apiEndpoint);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    } catch {
        return null;
    }
    return { v: 1, serverId, apiEndpoint, accountId, credential, settingsVersion, accountEncryptionVersion,
        registrationId, pushToken, previewCeiling };
}

export function parseHomeRemoteAlertPreparedContextEnvelope(value: unknown): HomeRemoteAlertPreparedContextEnvelopeV1 | null {
    let decoded = value;
    if (typeof decoded === 'string') {
        try {
            decoded = JSON.parse(decoded);
        } catch {
            return null;
        }
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const row = decoded as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'homes,v' || row.v !== 1 || !Array.isArray(row.homes)) return null;
    const homes = row.homes.map(parseContext);
    if (homes.some((home) => home === null)) return null;
    const admitted = homes as HomeRemoteAlertPreparedContextV1[];
    const identities = new Set(admitted.map((home) => `${home.serverId}\u0000${home.accountId}`));
    return identities.size === admitted.length ? { v: 1, homes: admitted } : null;
}

export function applyHomeRemoteAlertPreparedContextMutation(
    current: HomeRemoteAlertPreparedContextEnvelopeV1 | null,
    mutation: Mutation,
): HomeRemoteAlertPreparedContextEnvelopeV1 | null {
    const homes = [...(current?.homes ?? [])].filter((row) => {
        if (mutation.kind === 'remove_home') return row.serverId !== mutation.serverId;
        const serverId = mutation.kind === 'upsert' ? mutation.context.serverId : mutation.serverId;
        const accountId = mutation.kind === 'upsert' ? mutation.context.accountId : mutation.accountId;
        return row.serverId !== serverId
            || row.accountId !== accountId
            || (mutation.kind === 'remove' && mutation.registrationId !== undefined && row.registrationId !== mutation.registrationId);
    });
    if (mutation.kind === 'upsert') homes.push(mutation.context);
    if (homes.length === 0) return null;
    homes.sort((a, b) => `${a.serverId}\u0000${a.accountId}`.localeCompare(`${b.serverId}\u0000${b.accountId}`));
    return { v: 1, homes };
}

/**
 * Atomically mutates the sole native derived projection. TokenStorage remains
 * authoritative; this exact-Home packet is revocable extension custody, not a
 * second credential registry or notification-specific key hierarchy.
 */
export function persistHomeRemoteAlertPreparedContext(mutation: Mutation): boolean {
    if (mutation.kind === 'upsert') {
        return prepareActivityNotificationContext(JSON.stringify({ v: 1, homes: [mutation.context] }));
    }
    return removeActivityNotificationContext(
        mutation.serverId,
        mutation.kind === 'remove' ? mutation.accountId : null,
        mutation.kind === 'remove' ? mutation.registrationId ?? null : null,
    );
}

export function buildHomeRemoteAlertPreparedCredential(
    credentials: AuthCredentials,
    accountEncryptionMode: 'plain' | 'e2ee',
): HomeRemoteAlertPreparedContextV1['credential'] | null {
    if (accountEncryptionMode === 'plain') return { token: credentials.token, encryptionMode: 'plain' };
    if (!('encryption' in credentials) && !('secret' in credentials)) return null;
    let material: AccountScopedCryptoMaterial;
    try {
        material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    } catch {
        return null;
    }
    // Native opens Session data-key envelopes sealed to the Account content public key.
    const machineKey = encodeBase64(resolveAccountContentSecretKey(material), 'base64');
    return { token: credentials.token, encryptionMode: material.type === 'legacy' ? 'legacy_e2ee' : 'e2ee', machineKey };
}

// Credential mutation is the canonical revocation/rotation choke point. Any
// prepared generation for that exact Home becomes unusable immediately; the
// next push reconciliation can republish only after reading current credentials.
subscribeHomeCredentialMutations((event) => {
    try {
        persistHomeRemoteAlertPreparedContext({ kind: 'remove_home', serverId: event.serverId });
    } catch {
        // TokenStorage deliberately isolates observers from credential writes.
        // A failed local projection mutation cannot make removed credentials
        // usable by the Home, so the network boundary remains the final revoke.
    }
});

subscribeAccountSettingsPersistenceMutations((scope) => {
    try {
        persistHomeRemoteAlertPreparedContext({
            kind: 'remove', serverId: scope.serverId, accountId: scope.accountId,
        });
    } catch {
        // The current settings write remains authoritative; a native reader
        // that cannot be invalidated must fail its own loaded-context gate.
    }
});

subscribeLocalAttentionSettingsMutations(() => {
    clearActivityNotificationContext();
});

subscribeAccountEncryptionModeCacheInvalidation(() => {
    clearActivityNotificationContext();
});
