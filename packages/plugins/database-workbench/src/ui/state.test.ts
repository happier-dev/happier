import { describe, expect, it } from 'vitest';
import { createKeyedState } from './state.js';
import { createWorkbenchPaneState, workbenchPaneKey } from './state.js';

it('keeps Database and Insights choices separate for each mounted Session', () => {
    const panes = createWorkbenchPaneState();
    const scope = { kind: 'project' as const, accountId: 'account', installationId: 'installation', projectKey: 'project' };
    const database = workbenchPaneKey(scope, { kind: 'session', sessionId: 'a', tab: 'database' });
    const insights = workbenchPaneKey(scope, { kind: 'session', sessionId: 'a', tab: 'insights' });
    const otherSession = workbenchPaneKey(scope, { kind: 'session', sessionId: 'b', tab: 'database' });
    let unrelated = 0;
    panes.subscribe(insights, () => unrelated++);
    panes.set(database, { targetKey: 'first', location: null });
    panes.set(otherSession, { targetKey: 'second', location: null });
    expect(panes.get(database).targetKey).toBe('first');
    expect(panes.get(otherSession).targetKey).toBe('second');
    expect(panes.get(insights).targetKey).toBeNull();
    expect(unrelated).toBe(0);
});

describe('workbench keyed state', () => {
    it('publishes only the changed key and retains stable untouched snapshots', () => {
        const state = createKeyedState(() => ({ text: '' }));
        const other = state.get('other');
        let editorPublications = 0;
        let otherPublications = 0;
        const unsubscribe = state.subscribe('editor', () => editorPublications++);
        state.subscribe('other', () => otherPublications++);
        const changed = { text: 'select 1' };
        state.set('editor', changed);
        state.set('editor', changed);
        expect(state.get('editor')).toBe(changed);
        expect(state.get('other')).toBe(other);
        expect([editorPublications, otherPublications]).toEqual([1, 0]);
        unsubscribe();
        state.set('editor', { text: 'select 2' });
        expect(editorPublications).toBe(1);
    });
});

it('retains each project picker and details pane independently across remounts', async () => {
    const { createWorkbenchPaneState } = await import('./state.js');
    const panes = createWorkbenchPaneState();
    let otherPublications = 0;
    panes.subscribe('project-b', () => otherPublications++);
    const location = { targetKey: 'db-a', mode: 'console' as const, sort: [], columns: [], page: { rows: 50, offset: 0 }, fkTrail: [] };
    panes.set('project-a', { targetKey: 'db-a', location });
    expect(panes.get('project-a')).toEqual({ targetKey: 'db-a', location });
    expect(panes.get('project-b')).toEqual({ targetKey: null, location: null });
    expect(otherPublications).toBe(0);
});
