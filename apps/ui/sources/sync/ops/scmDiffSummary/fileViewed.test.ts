import { describe, expect, it } from 'vitest';
import { createScmFileViewedOperations } from './fileViewed';

const actions = {
    read: { action: { pluginId: 'example.forge', localId: 'read-viewed' }, input: { pr: '17' } },
    set: { action: { pluginId: 'example.forge', localId: 'set-viewed' }, input: { pr: '17' } },
};

describe('opened source file Viewed state', () => {
    it('publishes whole-map Viewed and Dismissed, preserves unchanged identities, and writes only the selected path', async () => {
        const writes: unknown[] = [];
        let readCount = 0;
        const source = createScmFileViewedOperations({ actions, execute: async (invocation) => {
            if (invocation.action.localId === actions.read.action.localId) {
                readCount++;
                return { kind: 'ready', headOid: 'head', files: [
                    { path: 'a.ts', state: 'viewed' }, { path: 'b.ts', state: 'dismissed' },
                ] };
            }
            writes.push(invocation.input);
            const input = invocation.input as { path: string; viewed: boolean };
            return { kind: 'ready', path: input.path, state: input.viewed ? 'viewed' : 'unviewed' };
        } });
        expect(readCount).toBe(0);
        await source.refresh();
        expect(source.getSnapshot()).toMatchObject({ status: 'ready', headOid: 'head' });
        expect(source.getFile('a.ts').state).toBe('viewed');
        expect(source.getFile('b.ts').state).toBe('dismissed');
        const untouched = source.getFile('b.ts');
        expect(await source.setViewed('a.ts', false)).toBe(true);
        expect(source.getFile('a.ts').state).toBe('unviewed');
        expect(await source.setViewed('a.ts', true)).toBe(true);
        expect(writes).toEqual([{ pr: '17', path: 'a.ts', viewed: false }, { pr: '17', path: 'a.ts', viewed: true }]);
        expect(readCount).toBe(1);
        expect(source.getFile('b.ts')).toBe(untouched);
        source.retire();
    });

    it('retains observed state after denied writes and failed refreshes, without a hot retry or false acknowledgement', async () => {
        let denyRead = false;
        let reads = 0;
        let writes = 0;
        const source = createScmFileViewedOperations({ actions, execute: async invocation => {
            if (invocation.action.localId === actions.read.action.localId) {
                reads++;
                return denyRead ? { kind: 'unavailable', failure: { class: 'transient', code: 'github_offline' } }
                    : { kind: 'ready', headOid: 'head', files: [{ path: 'a.ts', state: 'viewed' }] };
            }
            writes++;
            return { kind: 'unavailable', failure: { class: 'permission', code: 'github_permission_denied' } };
        } });
        await source.refresh();
        expect(await source.setViewed('a.ts', false)).toBe(false);
        expect(source.getFile('a.ts')).toEqual({ state: 'viewed', pending: false, errorCode: 'github_permission_denied' });
        denyRead = true;
        await source.refresh();
        expect(source.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'github_offline' });
        expect(source.getFile('a.ts').state).toBe('viewed');
        await Promise.resolve();
        expect({ reads, writes }).toEqual({ reads: 2, writes: 1 });
        source.retire();
    });

    it('retires a held read on leave and cannot publish its late answer or dispatch a saved toggle', async () => {
        let finish!: (result: unknown) => void;
        let capturedSignal: AbortSignal | undefined;
        let calls = 0;
        const source = createScmFileViewedOperations({ actions, execute: async (_invocation, signal) => {
            calls++;
            capturedSignal = signal;
            return new Promise(resolve => { finish = resolve; });
        } });
        const reading = source.refresh();
        expect(source.getSnapshot().status).toBe('loading');
        source.retire();
        expect(capturedSignal?.aborted).toBe(true);
        finish({ kind: 'ready', headOid: 'retired', files: [{ path: 'a.ts', state: 'viewed' }] });
        await reading;
        expect(source.getFile('a.ts').state).toBeNull();
        expect(await source.setViewed('a.ts', true)).toBe(false);
        expect(calls).toBe(1);
    });

    it('shares a concurrent opened-PR read and keeps a superseded read from replacing an acknowledged toggle', async () => {
        let finish!: (result: unknown) => void;
        let hold = false;
        let reads = 0;
        const source = createScmFileViewedOperations({ actions, execute: async invocation => {
            if (invocation.action.localId === actions.read.action.localId) {
                reads++;
                if (hold) return new Promise(resolve => { finish = resolve; });
                return { kind: 'ready', headOid: 'head', files: [{ path: 'a.ts', state: 'unviewed' }] };
            }
            return { kind: 'ready', path: 'a.ts', state: 'viewed' };
        } });
        await source.refresh();
        hold = true;
        const reading = source.refresh();
        const duplicate = source.refresh();
        expect(reads).toBe(2);
        expect(await source.setViewed('a.ts', true)).toBe(true);
        finish({ kind: 'ready', headOid: 'head', files: [{ path: 'a.ts', state: 'unviewed' }] });
        await Promise.all([reading, duplicate]);
        expect(source.getFile('a.ts').state).toBe('viewed');
        expect(reads).toBe(2);
        source.retire();
    });
});
