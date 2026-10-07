import * as React from 'react';

import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';

import {
    areServerAccountScopesEqual,
    serverAccountScopeKeySuffix,
    serverAccountScopeListKey,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
    loadAccountSettings,
    readAccountSettingsPersistenceMutationToken,
    subscribeAccountSettingsPersistenceMutations,
} from '@/sync/domains/state/accountSettingsPersistence';

/**
 * Persisted Account settings bytes for one Home. Mirrors the canonical delivery
 * plan owner's input type so a caller can hand through either the parsed Account
 * settings or a settings-shaped record.
 */
export type ExactHomeAccountSettings = Partial<AccountSettings> | Readonly<Record<string, unknown>>;

/**
 * Persisted Account settings for one exact `serverId` + `accountId` scope.
 *
 * `null` means this device cannot currently name the Account that owns that Home,
 * so every Activity channel fails closed for it. The active Home's Account policy
 * is never a substitute: switching Homes must not retarget another Home's
 * delivery, privacy, or enrollment behavior.
 */
export type ExactHomeAccountSettingsResolver =
    (serverId: string | null | undefined) => Partial<AccountSettings> | null;

/**
 * The one exact-Home Account settings read behind every delivery decision.
 *
 * `null` fails closed: an unnamed Account, an unwritten scope, or persistence
 * that has never held a synchronized version must never fall back to another
 * Home's policy. Routed (non-React) consumers — the Expo foreground handler —
 * call this directly with a scope resolved by the credential-scope owner.
 */
export function readExactHomeAccountSettings(
    scope: ServerAccountScope | null | undefined,
): Partial<AccountSettings> | null {
    if (!scope || readAccountSettingsPersistenceMutationToken(scope) === null) return null;
    const persisted = loadAccountSettings(scope);
    if (persisted.version === null) return null;
    return accountSettingsParse(persisted.settings);
}

/**
 * The single exact-Home Account settings subscription shared by local
 * notifications, the iOS Activity surfaces, Live Activity remote enrollment and
 * badge composition. Device/platform overrides stay device-global and are
 * composed separately by the canonical delivery-plan owner.
 */
export function useExactHomeAccountSettings(
    audienceScopes: ReadonlyMap<string, ServerAccountScope> | undefined,
): ExactHomeAccountSettingsResolver {
    const scopes = React.useMemo(() => {
        const unique = new Map<string, ServerAccountScope>();
        for (const scope of audienceScopes?.values() ?? []) {
            unique.set(serverAccountScopeKeySuffix(scope), scope);
        }
        return [...unique.values()].sort((left, right) => (
            left.serverId.localeCompare(right.serverId) || left.accountId.localeCompare(right.accountId)
        ));
    }, [audienceScopes]);
    const scopesKey = serverAccountScopeListKey(scopes);
    const subscribe = React.useCallback((listener: () => void) => (
        subscribeAccountSettingsPersistenceMutations((mutatedScope) => {
            if (scopes.some((scope) => areServerAccountScopesEqual(scope, mutatedScope))) listener();
        })
    ), [scopesKey]);
    const readSnapshot = React.useCallback(() => JSON.stringify(scopes.map((scope) => [
        scope.serverId,
        scope.accountId,
        readAccountSettingsPersistenceMutationToken(scope),
    ])), [scopesKey]);
    const persistenceSnapshot = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot);

    return React.useCallback((serverId: string | null | undefined) => {
        const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
        if (!normalizedServerId) return null;
        return readExactHomeAccountSettings(audienceScopes?.get(normalizedServerId));
    }, [audienceScopes, persistenceSnapshot]);
}
