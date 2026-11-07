import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('the source-neutral Tasks Actions', () => {
    it('exposes list, create, edit, transition and link through the ordinary Action policy', () => {
        const ids = ['tasks/list-v1', 'tasks/create-v1', 'tasks/edit-v1', 'tasks/transition-v1', 'tasks/link-v1'];
        for (const id of ids) {
            const action = PLUGIN_MANIFEST.contributes.actions.find((candidate) => candidate.id === id);
            expect(action, `${id} must have its real registered Action declaration`).toBeDefined();
            expect(action?.surfaces).toEqual(expect.arrayContaining(['ui', 'agent', 'mcp', 'cli']));
            if (id === 'tasks/link-v1') expect(action?.sessionTarget).toEqual({ field: 'sessionId', cardinality: 'one' });
            // The selected source Action owns provider-write approval; the
            // aggregate declarations do not add a second approval request.
        }
    });
});
