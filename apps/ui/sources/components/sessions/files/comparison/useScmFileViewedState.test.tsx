/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createScmFileViewedState, type ScmFileViewedSource } from '@/sync/domains/scm/fileViewed';
import { useScmFileViewedFile } from './useScmFileViewedState';

afterEach(standardCleanup);

describe('keyed Viewed observation', () => {
    it('changes one visible row at 55,559 files without recomputing the list or waking unrelated rows', async () => {
        let inventoryReads = 0;
        const files = Array.from({ length: 55_559 }, (_, index) => ({
            get path() { inventoryReads++; return `src/file-${index}.ts`; }, state: 'unviewed' as const,
        }));
        const store = createScmFileViewedState();
        store.applyRead({ kind: 'ready', headOid: 'head', files });
        const source: ScmFileViewedSource = { ...store, refresh: async () => {}, setViewed: async () => false };
        const visible = Array.from({ length: 25 }, (_, index) => `src/file-${55_534 + index}.ts`);
        const selected = visible[24]!;
        const dismissedMap = files.map(file => ({ path: file.path,
            state: file.path === selected ? 'dismissed' as const : 'unviewed' as const }));
        const renders = new Map<string, number>();
        let listComputations = 0;
        function Row({ path }: Readonly<{ path: string }>) {
            const file = useScmFileViewedFile(source, path);
            renders.set(path, (renders.get(path) ?? 0) + 1);
            return <span>{file.state}</span>;
        }
        function List() {
            listComputations++;
            return <>{visible.map(path => <Row key={path} path={path} />)}</>;
        }
        await renderScreen(<List />);
        renders.clear(); inventoryReads = 0; listComputations = 0;
        const order: string[] = [];
        const stopChange = source.subscribeChanges(path => order.push(`fact:${path}`));
        const stopRow = source.subscribeFile(selected, () => order.push(`row:${selected}`));
        await act(async () => store.applyFile(selected, { state: 'viewed', pending: false, errorCode: null }));
        expect([...renders]).toEqual([[selected, 1]]);
        expect(inventoryReads).toBe(0);
        expect(listComputations).toBe(0);
        expect(order).toEqual([`fact:${selected}`, `row:${selected}`]);
        renders.clear();
        await act(async () => store.applyFile(selected, { state: 'viewed', pending: false, errorCode: null }));
        expect([...renders]).toEqual([]);
        // A whole-map delivery only publishes changed paths; the UI inventory stays untouched.
        await act(async () => store.applyRead({ kind: 'ready', headOid: 'head', files: dismissedMap }));
        expect([...renders]).toEqual([[selected, 1]]);
        expect(source.getViewedPaths().has(selected)).toBe(false);
        expect(inventoryReads).toBe(0);
        expect(listComputations).toBe(0);
        stopRow(); stopChange(); store.retire();
    });
});
