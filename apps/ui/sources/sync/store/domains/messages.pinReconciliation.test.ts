import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessagesDomain } from './messages';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import {
    readPersistedSessionMessagePins,
    savePersistedSessionMessagePins,
} from '@/sync/domains/state/sessionMessagePinsPersistence';

const store = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }
    }

    return { MMKV };
});

const scopeA: ServerAccountScope = { serverId: 'server-a', accountId: 'account-a' };

function createHarness(initial: any) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        machines: {},
        machineDisplayById: {},
        settings: {},
        sessionPending: {},
        sessionMessages: {},
        sessionLocalStateScope: scopeA,
        ...initial,
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createMessagesDomain({ get, set } as any);
    return { get, domain };
}

function pin(overrides: Partial<PersistedSessionMessagePinV1> = {}): PersistedSessionMessagePinV1 {
    return {
        version: 1,
        sessionId: 's1',
        seq: 42,
        transcriptBlockIndex: 0,
        routeMessageId: 'local:local-a1',
        role: 'assistant',
        pinnedAtMs: 1_000,
        label: null,
        ...overrides,
    };
}

describe('messages domain: pin route reconciliation', () => {
    beforeEach(() => {
        store.clear();
    });

    it('upgrades local persisted pins when hydrated messages expose server route ids', () => {
        const localPin = pin();
        savePersistedSessionMessagePins('s1', [localPin], scopeA);
        const { domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    agentState: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        domain.applyMessages('s1', [{
            id: 'server-a1',
            seq: 42,
            localId: 'local-a1',
            createdAt: 2_000,
            isSidechain: false,
            role: 'agent',
            content: [{ type: 'text', text: 'hydrated answer' }],
        } as any]);

        expect(readPersistedSessionMessagePins('s1', scopeA)).toEqual([{
            ...localPin,
            routeMessageId: 'server:server-a1',
        }]);
    });

    it('reconciles a pin using the exact whitespace-bearing opaque local id', () => {
        const localPin = pin({ routeMessageId: 'local: local-a1 ' });
        savePersistedSessionMessagePins('s1', [localPin], scopeA);
        const { domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    agentState: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        // Narrow fixture: reconciliation reads only the identity and route fields supplied here.
        domain.applyMessages('s1', [{
            id: 'server-a1',
            seq: 42,
            localId: ' local-a1 ',
            createdAt: 2_000,
            isSidechain: false,
            role: 'agent',
            content: [{ type: 'text', text: 'hydrated answer' }],
        } as any]);

        expect(readPersistedSessionMessagePins('s1', scopeA)).toEqual([{
            ...localPin,
            routeMessageId: 'server:server-a1',
        }]);
    });
});
