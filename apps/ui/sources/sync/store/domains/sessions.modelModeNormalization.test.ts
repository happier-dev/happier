import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionsDomain } from './sessions';
import {
    clearPersistence,
    loadSessionModelModeUpdatedAts,
    loadSessionModelModes,
    saveSessionModelModeUpdatedAts,
    saveSessionModelModes,
} from '../../domains/state/persistence';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        isDataReady: false,
        machines: {},
        sessionMessages: {},
        settings: { groupInactiveSessionsByProject: false },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    return { get, domain };
}

describe('sessions domain: modelMode normalization', () => {
    beforeEach(() => {
        clearPersistence();
    });

    it('prefers metadata.modelOverrideV1 when it is newer than local state', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    modelOverrideV1: { v: 1, updatedAt: 1000, modelId: 'gemini-2.5-pro' },
                },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('gemini-2.5-pro');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(1000);
    });

    it('stamps modelModeUpdatedAt when updating the session model mode locally', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: null,
            } as any,
        ]);

        domain.updateSessionModelMode('s1', 'gemini-2.5-pro' as any);

        expect(get().sessions.s1.modelMode).toBe('gemini-2.5-pro');
        expect(typeof get().sessions.s1.modelModeUpdatedAt).toBe('number');
    });

    it('persists a loaded session model mode without dropping unloaded session model modes', () => {
        vi.spyOn(Date, 'now').mockReturnValue(5000);
        saveSessionModelModes({
            s_loaded: 'gemini-2.5-pro',
            s_unloaded: 'claude-3-5-sonnet-latest',
        });
        saveSessionModelModeUpdatedAts({
            s_loaded: 1000,
            s_unloaded: 2000,
        });
        const { domain } = createHarness();

        domain.applySessions([
            {
                id: 's_loaded',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: null,
            } as any,
        ]);

        domain.updateSessionModelMode('s_loaded', 'gpt-5.5' as any);

        expect(loadSessionModelModes()).toEqual({
            s_loaded: 'gpt-5.5',
            s_unloaded: 'claude-3-5-sonnet-latest',
        });
        expect(loadSessionModelModeUpdatedAts()).toEqual({
            s_loaded: 5000,
            s_unloaded: 2000,
        });
    });

    it('clamps invalid local model selections for agents without freeform model selection', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: { flavor: 'codex' },
            } as any,
        ]);

        domain.updateSessionModelMode('s1', 'not-a-real-model' as any);

        expect(get().sessions.s1.modelMode).toBe('default');
    });

    it('clamps invalid persisted model modes to default for agents without freeform model selection', () => {
        saveSessionModelModes({ s1: 'not-a-real-model' });
        saveSessionModelModeUpdatedAts({ s1: 123 });

        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: { flavor: 'codex' },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(123);
    });

    it('preserves persisted freeform model ids for agents that allow them', () => {
        saveSessionModelModes({ s1: 'claude-3-5-sonnet-latest' });
        saveSessionModelModeUpdatedAts({ s1: 123 });

        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: { flavor: 'claude' },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('claude-3-5-sonnet-latest');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(123);
    });

    it('ignores invalid metadata model overrides for agents without freeform model selection', () => {
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    flavor: 'codex',
                    modelOverrideV1: { v: 1, updatedAt: 1000, modelId: 'not-a-real-model' },
                },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(1000);
    });

    it('does not churn clamped metadata model overrides across repeated applySessions calls', () => {
        const { get, domain } = createHarness();
        const payload = {
            id: 's1',
            createdAt: 1,
            active: false,
            activeAt: 1,
            metadata: {
                flavor: 'codex',
                modelOverrideV1: { v: 1, updatedAt: 1000, modelId: 'not-a-real-model' },
            },
        } as any;

        domain.applySessions([payload]);
        const firstUpdatedAt = get().sessions.s1.modelModeUpdatedAt;
        domain.applySessions([payload]);
        const secondUpdatedAt = get().sessions.s1.modelModeUpdatedAt;

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(firstUpdatedAt).toBe(1000);
        expect(secondUpdatedAt).toBe(1000);
    });
    it('drops a local model selection the Agent transition explicitly cleared', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: { flavor: 'gemini' },
            } as any,
        ]);
        domain.updateSessionModelMode('s1', 'gemini-2.5-flash' as any);
        expect(get().sessions.s1.modelMode).toBe('gemini-2.5-flash');

        // The cutover to an Agent that accepts freeform model ids: the local
        // selection is not "invalid" for Claude, so the selectability clamp
        // cannot catch it. Only the transition's own clear tombstone can.
        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    flavor: 'claude',
                    modelOverrideV1: { v: 1, updatedAt: 2000, modelId: null },
                },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('default');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(2000);
    });

    it('keeps a local model selection that is newer than the clear tombstone', () => {
        vi.spyOn(Date, 'now').mockReturnValue(3000);
        const { get, domain } = createHarness();

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: { flavor: 'claude' },
            } as any,
        ]);
        domain.updateSessionModelMode('s1', 'claude-3-5-sonnet-latest' as any);

        domain.applySessions([
            {
                id: 's1',
                createdAt: 1,
                active: false,
                activeAt: 1,
                metadata: {
                    flavor: 'claude',
                    modelOverrideV1: { v: 1, updatedAt: 2000, modelId: null },
                },
            } as any,
        ]);

        expect(get().sessions.s1.modelMode).toBe('claude-3-5-sonnet-latest');
        expect(get().sessions.s1.modelModeUpdatedAt).toBe(3000);
    });
});
