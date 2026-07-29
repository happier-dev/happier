import { afterEach, describe, expect, it, vi } from 'vitest';
import { MMKV } from 'react-native-mmkv';

import { scopedStorageId } from '@/utils/system/storageScope';

function randomScope(): string {
    return `demopersist_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function readRealPersistedState(scope: string): string | undefined {
    // A fresh MMKV handle for the same id reads the durable backing store that a
    // hard exit would see on the next boot — the in-memory demo scratch never
    // reaches it.
    const backing = new MMKV({ id: scopedStorageId('server-profiles', scope) });
    return backing.getString('server-state-v1');
}

async function importFresh() {
    vi.resetModules();
    return await import('./serverProfiles');
}

describe('serverProfiles demo persistence suspend', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    afterEach(() => {
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('redirects demo-mode server-profile writes away from durable storage so a hard exit leaves the real profile intact', async () => {
        const scope = randomScope();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
        const mod = await importFresh();

        // Establish a real, explicitly-selected profile the way a signed-in user would.
        mod.upsertServerProfile({ serverUrl: 'https://real.example.test', name: 'Real', source: 'manual' });
        const realProfile = mod.listServerProfiles().find((p) => p.serverUrl === 'https://real.example.test/')
            ?? mod.listServerProfiles().find((p) => p.name === 'Real');
        expect(realProfile).toBeTruthy();
        mod.setActiveServerId(realProfile!.id, { scope: 'device' });

        const realBackingBefore = readRealPersistedState(scope);
        expect(realBackingBefore).toBeTruthy();
        expect(realBackingBefore).toContain(realProfile!.id);

        // Enter the demo persistence firewall, then perform the exact writes the demo
        // seed performs (upsert + activate a demo relay server).
        mod.suspendServerProfilePersistenceForDemo();
        expect(mod.isServerProfilePersistenceSuspendedForDemo()).toBe(true);

        const demoProfile = mod.upsertServerProfile({
            serverUrl: 'http://127.0.0.1:4099',
            name: 'Demo Relay',
            source: 'preconfigured',
        });
        mod.setActiveServerId(demoProfile.id, { scope: 'device' });

        // In-memory runtime reflects the demo selection (the demo world renders).
        expect(mod.getActiveServerUrl()).toContain('127.0.0.1:4099');

        // ...but durable storage is untouched: a hard exit here (no graceful
        // teardown, no resume) reads back the real profile, never the demo server.
        expect(readRealPersistedState(scope)).toBe(realBackingBefore);

        // Graceful teardown path: resume restores the real selection with the
        // durable store still intact.
        mod.setActiveServerId(realProfile!.id, { scope: 'device' });
        mod.resumeServerProfilePersistenceForDemo();
        expect(mod.isServerProfilePersistenceSuspendedForDemo()).toBe(false);
        expect(mod.getActiveServerUrl()).toContain('real.example.test');
        expect(readRealPersistedState(scope)).toBe(realBackingBefore);
    });
});
