import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '../types';
import {
    clearPersistence,
    loadSessionPermissionModeUpdatedAts,
    loadSessionPermissionModes,
    saveSessionPermissionModeUpdatedAts,
    saveSessionPermissionModes,
} from '../../domains/state/persistence';

function createHarness(initial: Partial<StorageState>) {
    storage.setState(initial);
    return { get: storage.getState, domain: storage.getState() };
}

afterEach(() => storage.setState(storage.getInitialState(), true));

describe('messages domain: permissionMode inference lifecycle', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        storage.setState(storage.getInitialState(), true);
        clearPersistence();
    });

    it('does not override session permissionMode from message meta when session metadata has permissionMode', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: { path: '/Users/tester/project', host: 'tester.local', permissionMode: 'yolo', permissionModeUpdatedAt: 100 },
                    permissionMode: 'yolo',
                    permissionModeUpdatedAt: 100,
                }),
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                localId: null,
                createdAt: 200,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'hi' },
                meta: { permissionMode: 'read-only' },
            } as any,
        ]);

        expect(get().sessions.s1.permissionMode).toBe('yolo');
        expect(get().sessions.s1.permissionModeUpdatedAt).toBe(100);
    });

    it('infers permissionMode from messages when metadata permissionMode is invalid', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: {
                        path: '/Users/tester/project',
                        host: 'tester.local',
                        // @ts-expect-error -- Malformed legacy metadata must not suppress message-based inference.
                        permissionMode: 'not-a-real-mode',
                        permissionModeUpdatedAt: 100,
                    },
                    permissionMode: 'default',
                    permissionModeUpdatedAt: 0,
                }),
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                localId: null,
                createdAt: 200,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'hi' },
                meta: { permissionMode: 'read-only' },
            } as any,
        ]);

        expect(get().sessions.s1.permissionMode).toBe('read-only');
        expect(get().sessions.s1.permissionModeUpdatedAt).toBe(200);
    });

    it('persists an inferred permission mode without dropping unloaded persisted permission modes', () => {
        saveSessionPermissionModes({
            s_loaded: 'default',
            s_unloaded: 'read-only',
        });
        saveSessionPermissionModeUpdatedAts({
            s_loaded: 1000,
            s_unloaded: 2000,
        });
        const { get, domain } = createHarness({
            sessions: {
                s_loaded: createSessionFixture({
                    id: 's_loaded',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: { path: '/Users/tester/project', host: 'tester.local' },
                    permissionMode: 'default',
                    permissionModeUpdatedAt: 1000,
                }),
            },
        });

        domain.applyMessages('s_loaded', [
            {
                id: 'm1',
                localId: null,
                createdAt: 9000,
                isSidechain: false,
                kind: 'user-text',
                role: 'user',
                content: { type: 'text', text: 'hi' },
                meta: { permissionMode: 'yolo' },
            } as any,
        ]);

        expect(get().sessions.s_loaded.permissionMode).toBe('yolo');
        expect(loadSessionPermissionModes()).toEqual({
            s_loaded: 'yolo',
            s_unloaded: 'read-only',
        });
        expect(loadSessionPermissionModeUpdatedAts()).toEqual({
            s_loaded: 9000,
            s_unloaded: 2000,
        });
    });
});
