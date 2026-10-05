import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { TranscriptFindProvider, useTranscriptFindRow } from './TranscriptFindContext';
import { createTranscriptFindRowStore } from './transcriptFindRowStore';

describe('Transcript Find row subscriptions', () => {
    it('updates only changed mounted rows and clears decorators without list invalidation', async () => {
        const store = createTranscriptFindRowStore();
        const renders = new Map<string, number>();
        function Row({ id }: { id: string }) {
            const row = useTranscriptFindRow(id);
            renders.set(id, (renders.get(id) ?? 0) + 1);
            return <div data-testid={id}>{row?.blocks[0]?.sourceRanges.length ?? 0}</div>;
        }
        await renderScreen(<TranscriptFindProvider store={store}><Row id="one" /><Row id="two" /></TranscriptFindProvider>);
        const base = new Map(renders);
        const row = { blocks: [{ id: 'text', sourceRanges: [{ start: 0, end: 2, current: false }] }] };
        await act(() => store.publish(new Map([['one', row]])));
        expect(renders.get('one')).toBe(base.get('one')! + 1);
        expect(renders.get('two')).toBe(base.get('two'));
        const snapshot = store.getSnapshot('one');
        await act(() => store.publish(new Map([['one', { blocks: [...row.blocks] }]])));
        expect(store.getSnapshot('one')).toBe(snapshot);
        expect(renders.get('one')).toBe(base.get('one')! + 1);
        await act(() => store.clear());
        expect(store.getSnapshot('one')).toBeNull();
        expect(renders.get('two')).toBe(base.get('two'));
    });
});
