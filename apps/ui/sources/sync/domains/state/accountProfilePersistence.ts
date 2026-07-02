import { purchasesDefaults, purchasesParse, type Purchases } from '@/sync/domains/purchases/purchases';
import { profileDefaults, profileParse, type Profile } from '@/sync/domains/profiles/profile';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { getPersistenceStorage } from './persistenceStorage';
import { loadProfile } from './profilePersistence';
import { loadPurchases } from './settingsPersistence';

const ACCOUNT_PROFILE_KEY_PREFIX = 'account-profile:v1';
const ACCOUNT_PURCHASES_KEY_PREFIX = 'account-purchases:v1';

function scopedKey(prefix: string, scope: ServerAccountScope): string {
    return serverAccountScopedStorageKey(prefix, scope);
}

function scopedValueExists(prefix: string, scope: ServerAccountScope): boolean {
    return typeof getPersistenceStorage().getString(scopedKey(prefix, scope)) === 'string';
}

function findFirstLegacyScopeWithValue(
    prefix: string,
    legacyScopes: readonly ServerAccountScope[],
): ServerAccountScope | null {
    for (const legacyScope of legacyScopes) {
        if (scopedValueExists(prefix, legacyScope)) return legacyScope;
    }
    return null;
}

export function loadAccountProfile(scope: ServerAccountScope): Profile {
    const raw = getPersistenceStorage().getString(scopedKey(ACCOUNT_PROFILE_KEY_PREFIX, scope));
    if (!raw) return { ...profileDefaults };
    try {
        return profileParse(JSON.parse(raw) as unknown);
    } catch {
        return { ...profileDefaults };
    }
}

export function saveAccountProfile(scope: ServerAccountScope, profile: Profile): void {
    getPersistenceStorage().set(scopedKey(ACCOUNT_PROFILE_KEY_PREFIX, scope), JSON.stringify(profile));
}

export function prepareAccountProfileScopeForActivation(
    scope: ServerAccountScope,
    legacyScopes: readonly ServerAccountScope[] = [],
): void {
    const storage = getPersistenceStorage();
    const scopedProfileExists = typeof storage.getString(scopedKey(ACCOUNT_PROFILE_KEY_PREFIX, scope)) === 'string';
    const legacyProfileExists = typeof storage.getString('profile') === 'string';
    const scopedPurchasesExists = typeof storage.getString(scopedKey(ACCOUNT_PURCHASES_KEY_PREFIX, scope)) === 'string';
    const legacyPurchasesExists = typeof storage.getString('purchases') === 'string';

    if (!scopedProfileExists && legacyProfileExists) {
        saveAccountProfile(scope, loadProfile());
    }

    if (!scopedPurchasesExists && legacyPurchasesExists) {
        saveAccountPurchases(scope, loadPurchases());
    }

    if (!scopedProfileExists && !legacyProfileExists) {
        const legacyProfileScope = findFirstLegacyScopeWithValue(ACCOUNT_PROFILE_KEY_PREFIX, legacyScopes);
        if (legacyProfileScope) {
            saveAccountProfile(scope, loadAccountProfile(legacyProfileScope));
        }
    }

    if (!scopedPurchasesExists && !legacyPurchasesExists) {
        const legacyPurchasesScope = findFirstLegacyScopeWithValue(ACCOUNT_PURCHASES_KEY_PREFIX, legacyScopes);
        if (legacyPurchasesScope) {
            saveAccountPurchases(scope, loadAccountPurchases(legacyPurchasesScope));
        }
    }

    if (legacyProfileExists) {
        storage.delete('profile');
    }
    if (legacyPurchasesExists) {
        storage.delete('purchases');
    }
}

export function loadAccountPurchases(scope: ServerAccountScope): Purchases {
    const raw = getPersistenceStorage().getString(scopedKey(ACCOUNT_PURCHASES_KEY_PREFIX, scope));
    if (!raw) return { ...purchasesDefaults };
    try {
        return purchasesParse(JSON.parse(raw) as unknown);
    } catch {
        return { ...purchasesDefaults };
    }
}

export function saveAccountPurchases(scope: ServerAccountScope, purchases: Purchases): void {
    getPersistenceStorage().set(scopedKey(ACCOUNT_PURCHASES_KEY_PREFIX, scope), JSON.stringify(purchases));
}
