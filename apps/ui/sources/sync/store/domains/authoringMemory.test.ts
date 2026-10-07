import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AuthoringMemoryValueV1 } from '@happier-dev/protocol';

import { createAuthoringMemoryDomain, type AuthoringMemoryDomain } from './authoringMemory';

describe('Account authoring-memory materialization', () => {
    it('materializes domain-valid opaque selections beyond the retired Settings document depth budget', () => {
        const store = createStore<AuthoringMemoryDomain>()((set, get) => createAuthoringMemoryDomain({ set, get }));
        let opaque: AuthoringMemoryValueV1 = { futureSelection: true };
        for (let depth = 0; depth < 16; depth++) opaque = { nested: opaque };
        const selections = { 'server-a:backend:future': opaque };
        store.getState().applyAuthoringMemory({ lastEngineSelectionsByScopeV1: selections });
        expect(store.getState().authoringMemory.lastEngineSelectionsByScopeV1).toEqual(selections);
        expect(store.getState().authoringMemory.currentRememberedEngineSelectionsByScopeV1).toEqual({});
    });
    it('retains unchanged identities and suppresses duplicate row echoes in the real store', () => {
        const store = createStore<AuthoringMemoryDomain>()((set, get) => createAuthoringMemoryDomain({ set, get }));
        store.getState().applyAuthoringMemory({
            recentMachinePaths: [{ machineId: 'machine-a', path: '/repo' }],
            lastEngineSelectionsByScopeV1: {
                'server-a:backend:codex': { v: 1, modelId: 'gpt-5.4', updatedAt: 1 },
                'server-a:backend:future': { v: 2, opaque: true },
            },
        });
        const initial = store.getState();
        let notifications = 0;
        store.subscribe(() => { notifications += 1; });
        store.getState().applyAuthoringMemory({
            recentMachinePaths: [{ machineId: 'machine-a', path: '/repo' }],
        });
        expect(store.getState()).toBe(initial);
        expect(notifications).toBe(0);
        store.getState().applyAuthoringMemory({ lastUsedProfile: 'profile-a' });
        expect(store.getState().authoringMemory.recentMachinePaths).toBe(initial.authoringMemory.recentMachinePaths);
        expect(store.getState().authoringMemory.currentRememberedEngineSelectionsByScopeV1).toBe(
            initial.authoringMemory.currentRememberedEngineSelectionsByScopeV1,
        );
        expect(store.getState().authoringMemory.lastEngineSelectionsByScopeV1['server-a:backend:future']).toEqual({ v: 2, opaque: true });
        expect(notifications).toBe(1);
    });

    it('clears all materialized values on Account/Home retirement', () => {
        const store = createStore<AuthoringMemoryDomain>()((set, get) => createAuthoringMemoryDomain({ set, get }));
        store.getState().applyAuthoringMemory({ recentMachinePaths: [{ machineId: 'machine-a', path: '/repo' }], lastUsedProfile: 'profile-a' });
        store.getState().resetAuthoringMemory();
        expect(store.getState().authoringMemory).toMatchObject({ recentMachinePaths: [], lastUsedProfile: null, lastEngineSelectionsByScopeV1: {} });
    });

    it('retains the visible remembered-choice projection when only opaque stored selections change', () => {
        const store = createStore<AuthoringMemoryDomain>()((set, get) => createAuthoringMemoryDomain({ set, get }));
        const current = { v: 1, modelSelection: null, updatedAt: 1 };
        store.getState().applyAuthoringMemory({ lastEngineSelectionsByScopeV1: {
            'server-a:agent:happier.agent.codex/codex': current,
            'server-a:backend:future': { v: 9, futureSelection: 'first' },
        } });
        const previous = store.getState().authoringMemory;
        store.getState().applyAuthoringMemory({ lastEngineSelectionsByScopeV1: {
            'server-a:agent:happier.agent.codex/codex': current,
            'server-a:backend:future': { v: 9, futureSelection: 'second' },
        } });
        expect(store.getState().authoringMemory.currentRememberedEngineSelectionsByScopeV1)
            .toBe(previous.currentRememberedEngineSelectionsByScopeV1);
        expect(store.getState().authoringMemory.lastEngineSelectionsByScopeV1['server-a:backend:future'])
            .toEqual({ v: 9, futureSelection: 'second' });
    });
});
