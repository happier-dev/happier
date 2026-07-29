import { describe, expect, it } from 'vitest';

import { loadSyncTuning } from '@/sync/runtime/syncTuning';

import { createArtifactsDomain } from './artifacts';

type State = ReturnType<typeof createArtifactsDomain>;

function createHarness(): { get: () => State } {
    let state = {} as State;
    const get = () => state;
    const set = (updater: (draft: State) => State) => {
        state = updater(state);
    };
    state = createArtifactsDomain({ get, set } as any);
    return { get };
}

function artifact(id: number) {
    return {
        id: `artifact-${id}`,
        title: `Artifact ${id}`,
        updatedAt: id,
        createdAt: id,
        draft: false,
    } as any;
}

describe('createArtifactsDomain retention', () => {
    it('retains only bounded newest artifact heads', () => {
        const { get } = createHarness();
        const max = loadSyncTuning().artifactHeadsMaxEntries;

        get().applyArtifacts(Array.from({ length: max + 5 }, (_, index) => artifact(index + 1)));

        expect(Object.keys(get().artifacts)).toHaveLength(max);
        expect(get().artifacts['artifact-1']).toBeUndefined();
        expect(get().artifacts[`artifact-${max + 5}`]).toBeDefined();
    });
});
