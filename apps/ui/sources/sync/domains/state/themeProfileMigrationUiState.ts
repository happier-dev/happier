import { createAccountSettingsScope, type AccountSettingsScope } from '../settings/scope/accountSettingsScope';
import { createPersistentUiState, usePersistentUiStateValue } from './persistentUiState';

function parseScope(value: unknown): AccountSettingsScope | null {
    return value && typeof value === 'object'
        ? createAccountSettingsScope(Reflect.get(value, 'serverId'), Reflect.get(value, 'accountId')) : null;
}

const legacyScope = createPersistentUiState('theme-profile-migration-v1', parseScope);
const legacyScopeKey = 'legacy-account-scope';

/** One device library has one receiving Account, independent of deliberate preferences. */
export function readThemeProfileLegacyAccountScope(): AccountSettingsScope | null {
    return legacyScope.readStrict(legacyScopeKey) ?? null;
}

export function writeThemeProfileLegacyAccountScope(scope: AccountSettingsScope | null): void {
    legacyScope.set(legacyScopeKey, scope);
}

export function useThemeProfileLegacyAccountScope(): AccountSettingsScope | null {
    return usePersistentUiStateValue(legacyScope, legacyScopeKey) ?? null;
}

/** The current 0.2 Settings writer persists this binding alongside its legacy library. */
export function migrateThemeProfileLegacyScopeFromSettings(input: unknown): unknown {
    if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'themeProfileLegacyAccountScope')) return input;
    if (legacyScope.readStrict(legacyScopeKey) === undefined) {
        writeThemeProfileLegacyAccountScope(parseScope(Reflect.get(input, 'themeProfileLegacyAccountScope')));
    }
    const migrated = { ...input };
    Reflect.deleteProperty(migrated, 'themeProfileLegacyAccountScope');
    return migrated;
}
