import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginUiArtifactDigestV1Schema } from '@happier-dev/protocol/plugins/ui';

import type { PluginReactNativeWatchdogSnapshot } from './watchdog';

vi.mock('react-native-mmkv', () => {
    class MMKV {
        static instances: MMKV[] = [];
        static shouldThrow = false;
        readonly id: string | undefined;
        readonly store = new Map<string, string>();

        constructor(options?: { id?: string }) {
            if (MMKV.shouldThrow) {
                throw new Error('MMKV unavailable');
            }
            this.id = options?.id;
            MMKV.instances.push(this);
        }

        getString(key: string): string | undefined {
            return this.store.get(key);
        }

        set(key: string, value: string): void {
            this.store.set(key, value);
        }
    }
    return { MMKV };
});

function createThrowingStorage() {
    return {
        getItem: () => {
            throw new Error('read failed');
        },
        setItem: () => {
            throw new Error('write failed');
        },
    };
}

function createMemoryStorage() {
    const store = new Map<string, string>();
    return {
        store,
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
    };
}

describe('React Native watchdog persistence', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(() => {
        if (previousScope === undefined) {
            delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        } else {
            process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const pendingFailure = {
        scopeKey: 'server-a\u0000machine-a\u0000account-a',
        token: {
            mount: {
                kind: 'destination',
                destination: { pluginId: 'acme.preview', localId: 'preview-destination' },
            },
            renderer: { pluginId: 'acme.preview', localId: 'native-preview' },
            artifactDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`),
            crashStateEpoch: 4,
        },
        failureOccurrenceId: '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
        failure: 'render_error' as const,
    } satisfies PluginReactNativeWatchdogSnapshot['pending'][number];

    it('roundtrips only V3 target-scoped pending quarantine snapshots and ignores malformed JSON', async () => {
        const { createPluginReactNativeWatchdogStoragePersistence } = await import('./watchdogPersistence');
        const storage = createMemoryStorage();
        const persistence = createPluginReactNativeWatchdogStoragePersistence({
            storage,
            key: 'watchdog',
        });

        // A store that has never been written answers, and holds nothing.
        expect(persistence.readSnapshot()).toEqual({ durability: 'absent' });

        expect(persistence.writeSnapshot({
            v: 3,
            pending: [pendingFailure],
        })).toBe('available');

        expect(persistence.readSnapshot()).toMatchObject({
            durability: 'available',
            snapshot: {
                v: 3,
                pending: [{ failureOccurrenceId: pendingFailure.failureOccurrenceId }],
            },
        });

        // Stored bytes this version cannot interpret are a quarantine it cannot
        // account for, never an absent one.
        storage.store.set('watchdog', '{not-json');
        expect(persistence.readSnapshot()).toEqual({ durability: 'unavailable' });
    });

    it('reports unavailable rather than empty when storage throws', async () => {
        const { createPluginReactNativeWatchdogStoragePersistence } = await import('./watchdogPersistence');
        const persistence = createPluginReactNativeWatchdogStoragePersistence({
            storage: createThrowingStorage(),
            key: 'watchdog',
        });

        expect(persistence.readSnapshot()).toEqual({ durability: 'unavailable' });
        expect(persistence.writeSnapshot({ v: 3, pending: [] })).toBe('unavailable');
    });

    it('uses scoped localStorage on web without constructing MMKV', async () => {
        vi.resetModules();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'stack-1';
        vi.spyOn(Platform, 'OS', 'get').mockReturnValue('web');
        const storage = createMemoryStorage();
        vi.stubGlobal('window', { localStorage: storage });

        const { createDefaultPluginReactNativeWatchdogPersistence } = await import('./watchdogPersistence');
        const persistence = createDefaultPluginReactNativeWatchdogPersistence();

        expect(persistence).toBeDefined();
        persistence?.writeSnapshot({ v: 3, pending: [] });
        expect(storage.store.has('happier:plugin-react-native-watchdog:pending-v3__stack-1')).toBe(true);

        const { MMKV } = await import('react-native-mmkv') as unknown as { MMKV: { instances: unknown[] } };
        expect(MMKV.instances).toHaveLength(0);
    });

    it('uses scoped MMKV storage on native platforms', async () => {
        vi.resetModules();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'native-stack';
        vi.spyOn(Platform, 'OS', 'get').mockReturnValue('ios');

        const { createDefaultPluginReactNativeWatchdogPersistence } = await import('./watchdogPersistence');
        const persistence = createDefaultPluginReactNativeWatchdogPersistence();

        expect(persistence).toBeDefined();
        persistence?.writeSnapshot({ v: 3, pending: [] });

        const { MMKV } = await import('react-native-mmkv') as unknown as { MMKV: { instances: Array<{ id?: string; store: Map<string, string> }> } };
        expect(MMKV.instances.at(-1)?.id).toBe('plugin-react-native-watchdog__native-stack');
        expect(MMKV.instances.at(-1)?.store.has('pending-v3')).toBe(true);
    });

    it('disables persistence instead of throwing when native storage construction fails', async () => {
        vi.resetModules();
        vi.spyOn(Platform, 'OS', 'get').mockReturnValue('ios');
        const { MMKV } = await import('react-native-mmkv') as unknown as { MMKV: { shouldThrow: boolean } };
        MMKV.shouldThrow = true;

        const { createDefaultPluginReactNativeWatchdogPersistence } = await import('./watchdogPersistence');

        expect(createDefaultPluginReactNativeWatchdogPersistence()).toBeUndefined();
    });
});
