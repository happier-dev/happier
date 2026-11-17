import { expect, it } from 'vitest';
import { createStagedEdits } from './drafts.js';

it('publishes a successful batch removal once while notifying only the affected rows', () => {
    const drafts = createStagedEdits<{ value: number }>();
    drafts.stage('first', { value: 1 }); drafts.stage('second', { value: 2 }); drafts.stage('retained', { value: 3 });
    let publications = 0;
    let retainedNotifications = 0;
    drafts.subscribe(() => publications++);
    drafts.subscribeRow('retained', () => retainedNotifications++);
    drafts.takeBackMany(['first', 'second']);
    expect(drafts.changes()).toEqual([{ value: 3 }]);
    expect(publications).toBe(1);
    expect(retainedNotifications).toBe(0);
});

it('keeps reviewed row values and comparison basis unchanged until deliberate take-back/discard', () => {
    const staged = createStagedEdits<Readonly<{ kind: string; original: unknown; values: unknown }>>();
    const update = { kind: 'update', original: [{ column: 'note', value: { type: 'null' } }], values: [
        { column: 'note', value: { kind: 'value', cell: { type: 'text', value: '' } } },
        { column: 'payload', value: { kind: 'value', cell: { type: 'binary', encoding: 'base64', value: 'AA==' } } },
        { column: 'generated', value: { kind: 'default' } },
    ] };
    staged.stage('row1', update);
    expect(staged.get('row1')).toBe(update);
    expect(staged.changes()).toEqual([update]);
    // An unsuccessful Apply does not acknowledge or remove the proposed changes.
    expect(staged.changes()[0]).toBe(update);
    staged.stage('row2', { kind: 'delete', original: [], values: [] });
    staged.takeBack('row2');
    expect(staged.changes()).toEqual([update]);
    staged.discard();
    expect(staged.changes()).toEqual([]);
});

it('publishes a changed row without waking another row subscriber', () => {
    const edits = createStagedEdits<{ value: string }>();
    let changed = 0;
    let unrelated = 0;
    edits.subscribeRow('a', () => changed++);
    edits.subscribeRow('b', () => unrelated++);
    edits.stage('a', { value: 'one' });
    edits.takeBack('a');
    expect([changed, unrelated]).toEqual([2, 0]);
});
