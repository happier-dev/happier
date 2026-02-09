import { beforeEach, describe, expect, it } from 'vitest';

import { createSessionsDomain } from './sessions';
import { clearPersistence, saveSessionModelModeUpdatedAts, saveSessionModelModes } from '../../domains/state/persistence';

function createHarness() {
    let state: any = {
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionGitStatus: {},
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

    it('clamps invalid local model selections for agents without freeform model selection', () => {
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
                metadata: { flavor: 'gemini' },
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
                    flavor: 'gemini',
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
                flavor: 'gemini',
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
});
