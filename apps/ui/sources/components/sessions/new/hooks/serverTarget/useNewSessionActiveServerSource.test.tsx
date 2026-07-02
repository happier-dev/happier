import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const serverRuntimeState = vi.hoisted(() => ({
    snapshot: {
        serverId: 'server-a',
        serverUrl: 'https://a.example.test',
        generation: 1,
        activeShareableServerUrl: 'https://share-a.example.test',
    },
    listeners: new Set<() => void>(),
}));

const serverProfilesState = vi.hoisted(() => ({
    value: [
        { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
        { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
    ],
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => serverRuntimeState.snapshot,
    subscribeActiveServer: (listener: () => void) => {
        serverRuntimeState.listeners.add(listener);
        return () => {
            serverRuntimeState.listeners.delete(listener);
        };
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => serverProfilesState.value,
}));

async function emitActiveServerUpdate() {
    await act(async () => {
        for (const listener of Array.from(serverRuntimeState.listeners)) {
            listener();
        }
    });
}

describe('useNewSessionActiveServerSource', () => {
    beforeEach(() => {
        serverRuntimeState.snapshot = {
            serverId: 'server-a',
            serverUrl: 'https://a.example.test',
            generation: 1,
            activeShareableServerUrl: 'https://share-a.example.test',
        };
        serverRuntimeState.listeners.clear();
        serverProfilesState.value = [
            { id: 'server-a', name: 'Server A', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
            { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
        ];
    });

    it('ignores generation and shareable-url churn while preserving profile name changes', async () => {
        const { useNewSessionActiveServerSource } = await import('./useNewSessionActiveServerSource');
        const hook = await renderHook(() => useNewSessionActiveServerSource());
        const first = hook.getCurrent();

        serverRuntimeState.snapshot = {
            ...serverRuntimeState.snapshot,
            generation: 2,
            activeShareableServerUrl: 'https://share-a-2.example.test',
        };
        await emitActiveServerUpdate();

        expect(hook.getCurrent()).toBe(first);

        serverRuntimeState.snapshot = {
            ...serverRuntimeState.snapshot,
            generation: 3,
        };
        serverProfilesState.value = [
            { id: 'server-a', name: 'Server A renamed', serverUrl: 'https://a.example.test', lastUsedAt: 1000 },
            { id: 'server-b', name: 'Server B', serverUrl: 'https://b.example.test', lastUsedAt: 900 },
        ];
        await emitActiveServerUpdate();

        expect(hook.getCurrent()).not.toBe(first);
        expect(hook.getCurrent().serverProfiles[0]?.name).toBe('Server A renamed');
    });
});
