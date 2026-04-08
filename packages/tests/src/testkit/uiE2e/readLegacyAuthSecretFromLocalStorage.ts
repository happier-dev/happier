import type { Page } from '@playwright/test';

export type LocalStorageReadablePage = Pick<Page, 'evaluate'>;
export type AuthBootstrapStorageWritablePage = Pick<Page, 'addInitScript' | 'evaluate'>;
export type AuthBootstrapStorageSnapshot = Readonly<{
    localStorage: Readonly<Record<string, string>>;
    sessionStorage: Readonly<Record<string, string>>;
}>;

function applyAuthBootstrapStorageSnapshot(snapshot: AuthBootstrapStorageSnapshot): void {
    if (typeof window === 'undefined') return;

    const clearMatchingKeys = (storage: Storage | undefined, predicate: (key: string) => boolean): void => {
        if (!storage) return;
        const keysToDelete: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key && predicate(key)) {
                keysToDelete.push(key);
            }
        }
        for (const key of keysToDelete) {
            storage.removeItem(key);
        }
    };

    const applyEntries = (storage: Storage | undefined, entries: Readonly<Record<string, string>>): void => {
        if (!storage) return;
        for (const [key, value] of Object.entries(entries)) {
            if (!key || typeof value !== 'string') continue;
            storage.setItem(key, value);
        }
    };

    const isAuthBootstrapLocalStorageKey = (key: string): boolean =>
        key.includes('server-state-v1') || key === 'auth_credentials' || key.startsWith('auth_credentials__srv_');
    const isAuthBootstrapSessionStorageKey = (key: string): boolean => key === 'activeServerId';

    clearMatchingKeys(window.localStorage, isAuthBootstrapLocalStorageKey);
    clearMatchingKeys(window.sessionStorage, isAuthBootstrapSessionStorageKey);
    applyEntries(window.localStorage, snapshot.localStorage);
    applyEntries(window.sessionStorage, snapshot.sessionStorage);
}

export async function readLegacyAuthSecretFromLocalStorage(page: LocalStorageReadablePage): Promise<string> {
    const secret = await page.evaluate(() => {
        if (typeof window === 'undefined' || !window.localStorage) return null;

        const findLastMatchingSecret = (
            entries: ReadonlyArray<Readonly<{ key: string; secret: string }>>,
            predicate: (entry: Readonly<{ key: string; secret: string }>) => boolean,
        ): string | null => {
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                const entry = entries[index];
                if (entry && predicate(entry)) {
                    return entry.secret;
                }
            }
            return null;
        };

        const legacySecrets: Array<Readonly<{ key: string; secret: string }>> = [];
        let activeServerId: string | null = null;

        for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (!key) continue;
            const raw = window.localStorage.getItem(key);
            if (!raw) continue;

            if (key.includes('server-state-v1')) {
                try {
                    const parsed = JSON.parse(raw) as { activeServerId?: unknown };
                    const candidateActiveServerId =
                        typeof parsed?.activeServerId === 'string' ? parsed.activeServerId.trim() : '';
                    if (candidateActiveServerId) {
                        activeServerId = candidateActiveServerId;
                    }
                } catch {
                    // ignore malformed server state
                }
                continue;
            }

            if (key !== 'auth_credentials' && !key.startsWith('auth_credentials__srv_')) continue;

            try {
                const parsed = JSON.parse(raw) as { secret?: unknown };
                const secret =
                    typeof parsed?.secret === 'string'
                        ? parsed.secret.trim()
                        : '';
                if (!secret) continue;
                legacySecrets.push({ key, secret });
            } catch {
                // ignore malformed credentials
            }
        }

        if (legacySecrets.length === 0) return null;
        if (!activeServerId) return legacySecrets[legacySecrets.length - 1]?.secret ?? null;

        const expectedKeyFragment = `auth_credentials__srv_${activeServerId.toLowerCase()}`;
        const scopedMatch = findLastMatchingSecret(legacySecrets, (entry) =>
            entry.key.toLowerCase().includes(expectedKeyFragment),
        );
        if (scopedMatch) return scopedMatch;

        return findLastMatchingSecret(legacySecrets, (entry) => entry.key === 'auth_credentials');
    });

    if (typeof secret === 'string' && secret.trim()) {
        return secret.trim();
    }

    throw new Error('missing legacy auth secret in localStorage');
}

export async function captureAuthBootstrapStorageSnapshot(_page: LocalStorageReadablePage): Promise<AuthBootstrapStorageSnapshot> {
    const snapshot = await _page.evaluate(() => {
        if (typeof window === 'undefined') {
            return { localStorage: {}, sessionStorage: {} };
        }

        const isAuthBootstrapStorageKey = (key: string): boolean =>
            key.includes('server-state-v1') || key === 'auth_credentials' || key.startsWith('auth_credentials__srv_');
        const isAuthBootstrapSessionStorageKey = (key: string): boolean => key === 'activeServerId';

        const localStorageEntries: Record<string, string> = {};
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (!key || !isAuthBootstrapStorageKey(key)) continue;
            const value = window.localStorage.getItem(key);
            if (typeof value !== 'string' || value.length === 0) continue;
            localStorageEntries[key] = value;
        }

        const sessionStorageEntries: Record<string, string> = {};
        if (window.sessionStorage) {
            for (let index = 0; index < window.sessionStorage.length; index += 1) {
                const key = window.sessionStorage.key(index);
                if (!key || !isAuthBootstrapSessionStorageKey(key)) continue;
                const value = window.sessionStorage.getItem(key);
                if (typeof value !== 'string' || value.length === 0) continue;
                sessionStorageEntries[key] = value;
            }
        }

        return { localStorage: localStorageEntries, sessionStorage: sessionStorageEntries };
    });

    const localStorageEntries = snapshot?.localStorage ?? {};
    const sessionStorageEntries = snapshot?.sessionStorage ?? {};
    const hasAuthCredentials = Object.keys(localStorageEntries).some((key) =>
        key === 'auth_credentials' || key.startsWith('auth_credentials__srv_'),
    );
    if (!hasAuthCredentials) {
        throw new Error('missing auth bootstrap credentials in localStorage');
    }

    return { localStorage: localStorageEntries, sessionStorage: sessionStorageEntries };
}

export async function installAuthBootstrapStorageSnapshot(
    page: AuthBootstrapStorageWritablePage,
    snapshot: AuthBootstrapStorageSnapshot,
): Promise<void> {
    const localStorageEntries = Object.fromEntries(
        Object.entries(snapshot.localStorage).filter(([key, value]) => key && typeof value === 'string' && value.length > 0),
    );
    const sessionStorageEntries = Object.fromEntries(
        Object.entries(snapshot.sessionStorage ?? {}).filter(([key, value]) => key && typeof value === 'string' && value.length > 0),
    );
    const normalizedSnapshot: AuthBootstrapStorageSnapshot = {
        localStorage: localStorageEntries,
        sessionStorage: sessionStorageEntries,
    };

    await page.addInitScript(applyAuthBootstrapStorageSnapshot, normalizedSnapshot);
    try {
        await page.evaluate(applyAuthBootstrapStorageSnapshot, normalizedSnapshot);
    } catch {
        // localStorage may be inaccessible on opaque origins (e.g. about:blank) before navigation.
        // The init script will still apply the snapshot once the page loads the target origin.
    }
}
