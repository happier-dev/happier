import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDefaultServerUrl, getServerUrl, isUsingCustomServer, setServerUrl } from './serverConfig';
import * as profiles from './serverProfiles';

function randomScope(): string {
    return `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function stubWebRuntime(origin: string) {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => void store.clear(),
    });
    const hostname = (() => {
        try {
            return new URL(origin).hostname;
        } catch {
            return '';
        }
    })();
    vi.stubGlobal('window', { location: { origin, hostname } });
    vi.stubGlobal('document', {});
    const lockTails = new Map<string, Promise<void>>();
    vi.stubGlobal('navigator', {
        locks: {
            request: <T>(name: string, callback: () => T | PromiseLike<T>): Promise<T> => {
                const previous = lockTails.get(name) ?? Promise.resolve();
                const result = previous.then(callback);
                lockTails.set(name, result.then(() => undefined, () => undefined));
                return result;
            },
        },
    });
}

function restoreEnvVar(key: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[key];
        return;
    }
    process.env[key] = value;
}

function clearServerEnv(): void {
    delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
    delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    delete process.env.EXPO_PUBLIC_SERVER_URL;
    delete process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
}

describe('getServerUrl', () => {
    const previousCanonicalEnv = process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
    const previousEnv = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    const previousLegacyGenericEnv = process.env.EXPO_PUBLIC_SERVER_URL;
    const previousContext = process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT;
    const previousPreconfigured = process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    beforeEach(() => {
        clearServerEnv();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = randomScope();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        restoreEnvVar('EXPO_PUBLIC_HAPPIER_SERVER_URL', previousCanonicalEnv);
        restoreEnvVar('EXPO_PUBLIC_HAPPY_SERVER_URL', previousEnv);
        restoreEnvVar('EXPO_PUBLIC_SERVER_URL', previousLegacyGenericEnv);
        restoreEnvVar('EXPO_PUBLIC_HAPPY_SERVER_CONTEXT', previousContext);
        restoreEnvVar('EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS', previousPreconfigured);
        restoreEnvVar('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', previousScope);
        profiles.resetServerProfilesRuntimeForTests();
    });

    it('uses window.location.origin on web when EXPO_PUBLIC_HAPPY_SERVER_URL is empty', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        expect(getServerUrl()).toBe('https://stack.example.test');
    });

    it('prefers injected web runtime config serverUrl over window.location.origin when env is empty', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');
        vi.stubGlobal('window', {
            location: { origin: 'https://stack.example.test', hostname: 'stack.example.test' },
            __HAPPIER_WEB_RUNTIME_CONFIG__: { serverUrl: 'https://server-override.example.test' },
        });

        expect(getServerUrl()).toBe('https://server-override.example.test');
    });

    it('falls back to an empty value when no server can be resolved', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('null');

        expect(getServerUrl()).toBe('');
    });

    it('leaves native source builds without a default Home', async () => {
        delete process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
        delete process.env.EXPO_PUBLIC_SERVER_URL;
        delete process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS;

        expect(getDefaultServerUrl()).toBe('');
        expect(getServerUrl()).toBe('');
    });

    it('keeps the build default independent of the remembered active server', async () => {
        try {
            await setServerUrl('https://remembered.example.test');
            expect(getServerUrl()).toBe('https://remembered.example.test');
            expect(getDefaultServerUrl()).toBe('');
        } finally {
            await setServerUrl(null);
        }
    });

    it('uses the custom build Home independently of its Account service', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({
            accountService: { url: 'https://accounts.example.test' },
            home: { url: 'https://home.example.test' },
        }));
        try { expect(getDefaultServerUrl()).toBe('https://home.example.test'); }
        finally { vi.unstubAllEnvs(); }
    });

    it('trims EXPO_PUBLIC_HAPPY_SERVER_URL to avoid whitespace issues', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = ' https://stack.example.test ';

        expect(getServerUrl()).toBe('https://stack.example.test');
    });

    it('prefers a custom server URL over EXPO_PUBLIC_HAPPY_SERVER_URL', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        try {
            await setServerUrl('https://custom.example.test');
            expect(getServerUrl()).toBe('https://custom.example.test');
        } finally {
            await setServerUrl(null);
        }
    });

    it('canonicalizes custom server URL by stripping userinfo and query/hash', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        try {
            await setServerUrl('https://admin:secret@custom.example.test:9443/path/?token=abc#frag');
            expect(getServerUrl()).toBe('https://custom.example.test:9443/path');
        } finally {
            await setServerUrl(null);
        }
    });

    it('ignores stale sessionStorage server id override when that id is missing', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = '';
        stubWebRuntime('https://stack.example.test');

        const created = await profiles.upsertServerProfile({ serverUrl: 'https://device.example.test', name: 'Device' });
        await profiles.setActiveServerId(created.id, { scope: 'device' });
        await profiles.setActiveServerId('missing-server', { scope: 'tab' });

        expect(getServerUrl()).toBe('https://device.example.test');
    });

    it('resetting a custom server returns to the stack default server (no built-in remote profile in stack context)', async () => {
        process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT = 'stack';
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL = 'http://localhost:3013/';

        expect(getServerUrl()).toBe('http://localhost:3013');
        expect(isUsingCustomServer()).toBe(false);

        await setServerUrl('https://custom.example.test/');
        expect(getServerUrl()).toBe('https://custom.example.test');
        expect(isUsingCustomServer()).toBe(true);

        // Reset should return to the stack default server.
        await setServerUrl(null);
        expect(getServerUrl()).toBe('http://localhost:3013');
        expect(isUsingCustomServer()).toBe(false);

        expect(profiles.listServerProfiles().some((p) => p.serverUrl === 'http://localhost:3013')).toBe(true);
    });

});
