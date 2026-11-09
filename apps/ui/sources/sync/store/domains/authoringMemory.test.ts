import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AuthoringMemoryValueV1 } from '@happier-dev/protocol/account/authoringMemory';

import { createAuthoringMemoryDomain, type AuthoringMemoryDomain } from './authoringMemory';

describe('Account authoring-memory materialization', () => {
    it('retains unchanged path and stored selection rows while their siblings change', () => {
        const store = createStore<AuthoringMemoryDomain>()((set, get) => createAuthoringMemoryDomain({ set, get }));
        const memory = { recentMachinePaths: [{ machineId: 'a', path: '/a' }, { machineId: 'b', path: '/b' }],
            lastEngineSelectionsByScopeV1: { 'home:backend:first': { v: 9, value: 1 }, 'home:backend:second': { v: 9, value: 1 } } };
        store.getState().applyAuthoringMemory(memory);
        const before = store.getState().authoringMemory;
        const changed = structuredClone(memory);
        changed.recentMachinePaths[1]!.path = '/changed';
        changed.lastEngineSelectionsByScopeV1['home:backend:second'].value = 2;
        store.getState().applyAuthoringMemory(changed);
        expect(store.getState().authoringMemory.recentMachinePaths[0]).toBe(before.recentMachinePaths[0]);
        expect(store.getState().authoringMemory.lastEngineSelectionsByScopeV1['home:backend:first'])
            .toBe(before.lastEngineSelectionsByScopeV1['home:backend:first']);
    });
    it('does not republish defaults after clearing the last selected profile', () => {
        const store = createStore<AuthoringMemoryDomain>()((set, get) => createAuthoringMemoryDomain({ set, get }));
        store.getState().applyAuthoringMemory({ lastUsedProfile: 'profile' });
        store.getState().applyAuthoringMemory({ lastUsedProfile: null });
        const before = store.getState();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => notifications++);
        store.getState().resetAuthoringMemory();
        expect(store.getState()).toBe(before);
        expect(notifications).toBe(0);
        unsubscribe();
    });
    it('retains each unchanged Workflow target when another Workflow target changes', () => {
        const store = createStore<AuthoringMemoryDomain>()((set, get) => createAuthoringMemoryDomain({ set, get }));
        const first = { machineId: 'machine-a', directory: '/first' };
        store.getState().applyAuthoringMemory({ workflowProjectTargetsByDefinitionId: { first, second: { machineId: 'machine-b', directory: '/before' } } });
        const previous = store.getState().authoringMemory.workflowProjectTargetsByDefinitionId;
        store.getState().applyAuthoringMemory({ workflowProjectTargetsByDefinitionId: { first, second: { machineId: 'machine-b', directory: '/after' } } });
        expect(store.getState().authoringMemory.workflowProjectTargetsByDefinitionId.first).toBe(previous.first);
        expect(store.getState().authoringMemory.workflowProjectTargetsByDefinitionId.second?.directory).toBe('/after');
    });
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
