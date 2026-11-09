import { describe, expect, it, vi } from 'vitest';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { askSelectionFromCodeLines, createNativeLineRangeSelection } from './nativeLineRangeSelection';

const row = (id: string, oldLine: number | null, newLine: number | null, code: string, kind: CodeLine['kind'] = 'file'): CodeLine => ({
    id, sourceIndex: 0, hunkIndex: null, kind, oldLine, newLine, renderPrefixText: '', renderCodeText: code, renderIsHeaderLine: false, selectable: true });

describe('native line-range selection', () => {
    it('publishes file rows as file lines with their text', () => {
        expect(askSelectionFromCodeLines([row('f:2', null, 2, 'two'), row('f:3', null, 3, 'three')], 'file'))
            .toMatchObject({ startLine: 2, endLine: 3, text: 'two\nthree' });
    });

    it('anchors diff rows on the side the change lands on, as the web selection does', () => {
        const removed = row('d:1', 5, null, 'old', 'remove');
        const added = row('d:2', null, 5, 'new', 'add');
        expect(askSelectionFromCodeLines([removed], 'diff')).toMatchObject({ startLine: 5, endLine: 5, side: 'before' });
        expect(askSelectionFromCodeLines([removed, added], 'diff')).toMatchObject({ startLine: 5, endLine: 5, side: 'after' });
    });

    it('notifies subscribers once per change and clears on an empty range', () => {
        const store = createNativeLineRangeSelection();
        const listener = vi.fn();
        store.subscribe(listener);
        store.select([row('f:1', null, 1, 'one')], 'file');
        expect(store.getState().lineIds).toEqual(new Set(['f:1']));
        expect(store.getSelection()).toMatchObject({ startLine: 1, endLine: 1 });
        store.select([], 'file');
        store.clear();
        expect(store.getSelection()).toBeNull();
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
