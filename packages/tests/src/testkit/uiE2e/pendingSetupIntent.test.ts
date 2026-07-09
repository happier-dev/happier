import { describe, expect, it, vi } from 'vitest';

import { seedDismissedPendingSetupIntent } from './pendingSetupIntent';

type StorageMap = Map<string, string>;

function readRecord(storage: StorageMap, key: string): unknown {
    const raw = storage.get(key);
    return raw ? JSON.parse(raw) : null;
}

function createStoragePage(): {
    page: Parameters<typeof seedDismissedPendingSetupIntent>[0];
    storage: StorageMap;
} {
    const storage = new Map<string, string>();
    const fakeWindow = {
        localStorage: {
            setItem: (key: string, value: string) => {
                storage.set(key, value);
            },
        },
    };

    const runWithWindow = (script: unknown, arg: unknown): void => {
        const previousWindow = (globalThis as { window?: unknown }).window;
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: fakeWindow,
        });
        try {
            const serializedScript = (0, eval)(`(${String(script)})`) as (value: unknown) => void;
            serializedScript(arg);
        } finally {
            if (previousWindow === undefined) {
                Reflect.deleteProperty(globalThis, 'window');
            } else {
                Object.defineProperty(globalThis, 'window', {
                    configurable: true,
                    value: previousWindow,
                });
            }
        }
    };

    const page = {
        addInitScript: vi.fn(async (_script: unknown, _arg?: unknown) => undefined),
        evaluate: vi.fn(async (script: unknown, arg?: unknown) => {
            runWithWindow(script, arg);
        }),
    };

    // Playwright's addInitScript/evaluate overloads accept functions plus args; this fixture only
    // implements that system boundary shape so the helper's storage writes can be asserted directly.
    return { page: page as unknown as Parameters<typeof seedDismissedPendingSetupIntent>[0], storage };
}

describe('seedDismissedPendingSetupIntent', () => {
    it('seeds legacy and current unscoped pending setup dismissal keys', async () => {
        const { page, storage } = createStoragePage();

        await seedDismissedPendingSetupIntent(page, 'repo dev/a1');

        expect(readRecord(storage, 'pending-setup-intent-record')).toMatchObject({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: null,
        });
        expect(readRecord(storage, 'pending-setup-intent-record__repo_dev_a1')).toMatchObject({
            phase: 'dismissed',
        });
        expect(readRecord(storage, 'mmkv.pending-setup-intent\\\\record')).toMatchObject({
            phase: 'dismissed',
        });
        expect(readRecord(storage, 'mmkv.pending-setup-intent__repo_dev_a1\\\\record')).toMatchObject({
            phase: 'dismissed',
        });
    });

    it('seeds current server-account pending setup dismissal keys', async () => {
        const { page, storage } = createStoragePage();

        await seedDismissedPendingSetupIntent(page, 'repo dev/a1', {
            serverUrl: 'http://127.0.0.1:53288/',
            serverIdentityId: 'srv_abc',
            serverId: 'localhost-53288',
            legacyServerIds: ['legacy-relay'],
            accountId: 'acct_123',
        });

        const expectedRecord = {
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'http://localhost:53288',
        };

        expect(readRecord(
            storage,
            'pending-setup-intent-record:v2__repo_dev_a1:7:srv_abc8:acct_123',
        )).toMatchObject(expectedRecord);
        expect(readRecord(
            storage,
            'pending-setup-intent-record:v2__repo_dev_a1:15:localhost-532888:acct_123',
        )).toMatchObject(expectedRecord);
        expect(readRecord(
            storage,
            'pending-setup-intent-record:v2__repo_dev_a1:12:legacy-relay8:acct_123',
        )).toMatchObject(expectedRecord);
        expect(readRecord(
            storage,
            'pending-setup-intent-record:server:v1__repo_dev_a1:22:http://localhost:53288',
        )).toMatchObject(expectedRecord);
    });
});
