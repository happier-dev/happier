import { describe, expect, it, vi } from 'vitest';
import type { LanguageIntelligenceDiagnostic, LanguageIntelligenceWatchResult } from '@happier-dev/protocol/machines/languageIntelligence';
import { EMPTY_CODE_DIAGNOSTICS, bindCodeDiagnosticDecorations, mergeCodeDiagnostics, selectCodeDiagnostics, projectCodeDiagnosticDecorations } from './codeDiagnostics';

const diagnostic = (serverId: string, message = 'Unknown name'): LanguageIntelligenceDiagnostic => ({
    serverId, path: 'a.ts', range: { start: { line: 1, character: 3 }, end: { line: 1, character: 7 } }, severity: 'error', message,
});
const server = (serverId: string, state: 'ready' | 'crashed' = 'ready') => ({ serverId, label: serverId, state, loading: false, generation: 'g1' });
const fence = { documentVersions: new Map([['a.ts', 2]]), serverGenerations: new Map([['one', 'g1'], ['two', 'g1']]) };
type Watch = Extract<LanguageIntelligenceWatchResult, { status: 'ok' }>;
const update = (revision: number, diagnostics: Watch['diagnostics'], servers = [server('one'), server('two')]): Watch => ({ status: 'ok', revision, diagnostics, servers });

describe('code diagnostics client projection', () => {
    it('keeps equal watches and untouched paths stable while changed, cleared and crashed diagnostics reach consumers', () => {
        const entry = { state: 'ready' as const, version: 2, generation: 'g1', items: [diagnostic('one')] };
        let projection = mergeCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS, update(1, {
            'a.ts': { one: entry }, 'b.ts': { one: { ...entry, items: [{ ...diagnostic('one'), path: 'b.ts' }] } },
        }), fence);
        const decorations = { a: vi.fn(), b: vi.fn() };
        const listeners = new Set<() => void>();
        const releases = (['a', 'b'] as const).map(path => bindCodeDiagnosticDecorations({
            path: `${path}.ts`, getProjection: () => projection,
            subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            handle: { setDecorations: decorations[path] },
        }));
        const receive = (response: Watch) => {
            projection = mergeCodeDiagnostics(projection, response, fence);
            for (const listener of listeners) listener();
        };
        try {
            const first = projection;
            for (let index = 0; index < 12; index++) receive(update(1, {}));
            // A repeated serialized entry is equal even though transport rebuilt its objects.
            receive(update(1, { 'a.ts': { one: { ...entry, items: [diagnostic('one')] } } }));
            expect(projection).toBe(first);
            expect(decorations.a).toHaveBeenCalledTimes(1);
            expect(decorations.b).toHaveBeenCalledTimes(1);
            receive(update(2, { 'a.ts': { one: { ...entry, items: [diagnostic('one', 'Changed problem')] } } }));
            expect(projection.entries['b.ts']).toBe(first.entries['b.ts']);
            expect(projection.entries['a.ts']).not.toBe(first.entries['a.ts']);
            expect(selectCodeDiagnostics(projection).items.map(item => item.message)).toEqual(['Changed problem', 'Unknown name']);
            expect(decorations.a).toHaveBeenCalledTimes(2);
            expect(decorations.b).toHaveBeenCalledTimes(1);
            expect(decorations.a.mock.lastCall?.[1]).toMatchObject([{ message: 'Changed problem' }]);
            receive(update(3, { 'a.ts': { one: { ...entry, items: [] } } }));
            expect(decorations.a.mock.lastCall).toEqual(['diagnostic', []]);
            expect(selectCodeDiagnostics(projection).count).toBe(1);
            receive(update(4, {}, [server('one', 'crashed'), server('two')]));
            expect(decorations.b.mock.lastCall).toEqual(['diagnostic', []]);
            expect(selectCodeDiagnostics(projection).items).toEqual([]);
        } finally { releases.forEach(release => release()); }
    });

    it('retains changed-document problems as checking until the new version is actually diagnosed, without stale markers', () => {
        const first = mergeCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS, update(1, { 'a.ts': {
            one: { state: 'ready', version: 2, generation: 'g1', items: [diagnostic('one')] },
            two: { state: 'ready', version: 2, generation: 'g1', items: [] },
        }, 'other.ts': { one: { state: 'ready', version: 1, generation: 'g1', items: [] } } }), fence);
        const nextFence = { ...fence, documentVersions: new Map([['a.ts', 3]]) };
        const changed = mergeCodeDiagnostics(first, update(2, {}), nextFence);
        expect(selectCodeDiagnostics(changed, 'a.ts')).toMatchObject({ state: 'checking', count: null, items: [diagnostic('one')] });
        expect(selectCodeDiagnostics(changed)).toMatchObject({ state: 'checking', count: null, items: [diagnostic('one')] });
        expect(projectCodeDiagnosticDecorations(changed, 'a.ts')).toEqual([]);
        const late = mergeCodeDiagnostics(changed, update(3, { 'a.ts': {
            one: { state: 'ready', version: 2, generation: 'g1', items: [] },
        } }), nextFence);
        expect(selectCodeDiagnostics(late, 'a.ts').state).toBe('checking');
        const confirmed = mergeCodeDiagnostics(late, update(4, { 'a.ts': {
            one: { state: 'ready', version: 3, generation: 'g1', items: [] },
            two: { state: 'ready', version: 3, generation: 'g1', items: [] },
        } }), nextFence);
        expect(selectCodeDiagnostics(confirmed, 'a.ts')).toMatchObject({ state: 'ready', count: 0, items: [] });
    });

    it('replaces each server/path, dedupes markers, clears one crashed server and fences stale input', () => {
        const item = diagnostic('one');
        let projection = mergeCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS, update(1, { 'a.ts': {
            one: { state: 'ready', version: 2, generation: 'g1', items: [item] },
            two: { state: 'ready', version: 2, generation: 'g1', items: [diagnostic('two'), diagnostic('two', 'Different problem')] },
        } }), fence);
        expect(selectCodeDiagnostics(projection, 'a.ts')).toMatchObject({ state: 'ready', count: 2 });
        const layers: unknown[][] = [];
        let changed = () => {};
        const unsubscribe = vi.fn();
        const dispose = bindCodeDiagnosticDecorations({ path: 'a.ts', getProjection: () => projection,
            subscribe: (listener) => { changed = listener; return unsubscribe; },
            handle: { setDecorations: (layer, items) => layers.push([layer, items]) } });
        expect(layers.at(-1)).toEqual(['diagnostic', [expect.objectContaining({ severity: 'error', startLine: 2, startCharacter: 3 }),
            expect.objectContaining({ message: 'Different problem' })]]);
        projection = mergeCodeDiagnostics(projection, update(2, {}, [server('one', 'crashed'), server('two')]), fence);
        changed();
        expect(selectCodeDiagnostics(projection, 'a.ts').count).toBe(2);
        projection = mergeCodeDiagnostics(projection, update(3, { 'a.ts': { two: { state: 'ready', version: 2, generation: 'g1', items: [] } } }), fence);
        changed();
        expect(layers.at(-1)).toEqual(['diagnostic', []]);
        expect(selectCodeDiagnostics(projection, 'a.ts').count).toBe(0);
        const stale = mergeCodeDiagnostics(projection, update(4, { 'a.ts': { two: { state: 'ready', version: 1, generation: 'g1', items: [item] } } }), fence);
        expect(selectCodeDiagnostics(stale, 'a.ts').count).toBe(0);
        const oldGeneration = mergeCodeDiagnostics(stale, update(5, { 'a.ts': { two: { state: 'ready', version: 2, generation: 'old', items: [item] } } }), fence);
        expect(selectCodeDiagnostics(oldGeneration, 'a.ts').count).toBe(0);
        expect(mergeCodeDiagnostics(oldGeneration, update(1, { 'a.ts': { two: { state: 'ready', version: 2, generation: 'g1', items: [item] } } }), fence)).toBe(oldGeneration);
        dispose();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(layers.at(-1)).toEqual(['diagnostic', []]);
    });

    it('has no speculative count and never presents checking as an authoritative empty', () => {
        expect(selectCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS)).toMatchObject({ state: 'idle', count: null });
        const projection = mergeCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS, update(1, { 'a.ts': {
            one: { state: 'checking', version: 2, generation: 'g1', items: [] },
        } }), fence);
        expect(selectCodeDiagnostics(projection, 'a.ts')).toMatchObject({ state: 'checking', count: null });
    });
});
