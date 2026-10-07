import {
    combineClientEncryptionRequirements,
    isAccountEncryptionModeAllowedByClientRequirement,
    isSessionEncryptionModeAllowedByClientRequirement,
    type ClientEncryptionRequirement,
} from '@happier-dev/protocol/encryption/clientEncryptionRequirement';

import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';

type SyncedClientEncryptionRequirementSettings = Readonly<{
    clientEncryptionRequirementV1?: ClientEncryptionRequirement;
}>;

type LocalClientEncryptionRequirementSettings = Readonly<{
    clientEncryptionRequirementLocalV1?: ClientEncryptionRequirement;
}>;

export function resolveUiClientEncryptionRequirement(params: Readonly<{
    syncedSettings: SyncedClientEncryptionRequirementSettings;
    localSettings: LocalClientEncryptionRequirementSettings;
}>): ClientEncryptionRequirement {
    return combineClientEncryptionRequirements(
        params.syncedSettings.clientEncryptionRequirementV1 ?? 'follow_account',
        params.localSettings.clientEncryptionRequirementLocalV1 ?? 'follow_account',
    );
}

/**
 * The client encryption requirement of one exact Home/Account reader.
 *
 * Both halves are that Account's own settings: the synced
 * `clientEncryptionRequirementV1` and the local-only minimum persisted for the
 * same scope. The focused Account's live settings projection answers only for the
 * focused Account; a reader serving any other Account (a concurrent secondary
 * Home, an explicitly scoped read) resolves that Account's persisted settings and
 * never borrows the focused projection. A scope with nothing persisted yet
 * resolves to that Account's own defaults.
 */
export function resolveUiClientEncryptionRequirementForScope(params: Readonly<{
    scope: ServerAccountScope;
    focusedSettings: SyncedClientEncryptionRequirementSettings & LocalClientEncryptionRequirementSettings;
}>): ClientEncryptionRequirement {
    if (areServerAccountScopesEqual(params.scope, getActiveServerAccountScope())) {
        return resolveUiClientEncryptionRequirement({
            syncedSettings: params.focusedSettings,
            localSettings: params.focusedSettings,
        });
    }
    const persisted = loadAccountSettings(params.scope).settings;
    const settings: SyncedClientEncryptionRequirementSettings & LocalClientEncryptionRequirementSettings =
        persisted && typeof persisted === 'object' && !Array.isArray(persisted) ? persisted : {};
    return resolveUiClientEncryptionRequirement({ syncedSettings: settings, localSettings: settings });
}

export function assertUiAccountEncryptionModeAllowed(params: Readonly<{
    mode: 'e2ee' | 'plain';
    syncedSettings: SyncedClientEncryptionRequirementSettings;
    localSettings: LocalClientEncryptionRequirementSettings;
}>): void {
    if (isAccountEncryptionModeAllowedByClientRequirement(
        resolveUiClientEncryptionRequirement(params),
        params.mode,
    )) return;
    throw Object.assign(
        new Error('This Happier client requires end-to-end encryption, but the Account settings are stored as plaintext.'),
        { code: 'CLIENT_E2EE_REQUIRED', retryable: false },
    );
}

export function isUiSessionEncryptionModeAllowed(params: Readonly<{
    mode: 'e2ee' | 'plain';
    requirement: ClientEncryptionRequirement;
}>): boolean {
    return isSessionEncryptionModeAllowedByClientRequirement(params.requirement, params.mode);
}

export function assertUiSessionEncryptionModeAllowed(params: Readonly<{
    mode: 'e2ee' | 'plain';
    requirement: ClientEncryptionRequirement;
}>): void {
    if (isUiSessionEncryptionModeAllowed(params)) return;
    throw Object.assign(
        new Error('This Happier client requires end-to-end encryption and will not use a plaintext Session.'),
        { code: 'CLIENT_E2EE_REQUIRED', retryable: false },
    );
}
