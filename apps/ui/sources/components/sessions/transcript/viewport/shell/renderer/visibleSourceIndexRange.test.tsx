import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { resolveMainTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

import { legendListRenderer } from './legendListRenderer';
import type { TranscriptListShellRef } from './types';

type Row = Readonly<{ id: string }>;

const ROWS: readonly Row[] = [
    { id: 'row-0' },
    { id: 'row-1' },
    { id: 'row-2' },
    { id: 'row-3' },
];

let legendState: Record<string, unknown> | null = null;

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((_props: Record<string, unknown>, ref: React.Ref<unknown>) => {
        const instance = React.useMemo(() => ({
            getState: () => legendState ?? undefined,
            getScrollableNode: () => null,
            scrollToIndex: () => Promise.resolve(),
            scrollToOffset: () => Promise.resolve(),
            scrollToEnd: () => Promise.resolve(),
        }), []);
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') {
            (ref as React.MutableRefObject<unknown>).current = instance;
        }
        return React.createElement('LegendList', null);
    }),
}));

async function mountLegendRenderer(): Promise<React.RefObject<TranscriptListShellRef<Row> | null>> {
    const Renderer = legendListRenderer.Component;
    const listRef = React.createRef<TranscriptListShellRef<Row>>();
    await renderScreen(
        <Renderer
            ref={listRef}
            webDomObservation={createWebDomScrollObservation()}
            data={ROWS}
            dataKey="session-1"
            keyExtractor={(item: Row) => item.id}
            renderItem={({ item }: { item: Row }) => React.createElement('Row', { id: item.id })}
            frame={resolveMainTranscriptListShellFrame({ platformOS: 'web' })}
        />,
    );
    return listRef;
}

describe('renderer visible source index range', () => {
    it('reads the Legend visible window through the renderer seam', async () => {
        legendState = { start: 1, end: 2 };

        const listRef = await mountLegendRenderer();

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toEqual({ startIndex: 1, endIndex: 2 });
    });

    // Legend sets `start`/`end` (its no-buffer visible window) to null whenever its
    // last calculation found no row intersecting the viewport — the viewport parked
    // in an allocation gap or past the measured content end, which is exactly what a
    // target-window replace can leave behind. That is a measured answer, not an
    // unmeasured frame, and nothing recomputes it without a further scroll/size
    // event: treating it as "no measurement" freezes navigation on a stale anchor
    // with rows still mounted.
    it('answers from the Legend buffered band when its visible window measured empty', async () => {
        legendState = { start: null, end: null, startBuffered: 1, endBuffered: 3 };

        const listRef = await mountLegendRenderer();

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toEqual({ startIndex: 1, endIndex: 3 });
    });

    it('still reports no measurement when Legend has neither a visible nor a buffered band', async () => {
        legendState = { start: null, end: null, startBuffered: null, endBuffered: null };

        const listRef = await mountLegendRenderer();

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toBeNull();
    });

    // Legend's full recalculation assigns `endBuffered` only after it has found a
    // no-buffer start, so a viewport intersecting no row can leave half a band.
    // That is not a window: answering it would mean inventing an end index.
    it('still reports no measurement when Legend left only half a buffered band', async () => {
        legendState = { start: null, end: null, startBuffered: 1, endBuffered: null };

        const listRef = await mountLegendRenderer();

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toBeNull();
    });

    it('reports no measurement instead of row 0 when the Legend surface has no state yet', async () => {
        legendState = null;

        const listRef = await mountLegendRenderer();

        expect(listRef.current?.readVisibleSourceIndexRange?.()).toBeNull();
        // The legacy window read cannot express it: {0, 0} is indistinguishable
        // from genuinely viewing the first row.
        expect(listRef.current?.computeVisibleIndices?.()).toEqual({ startIndex: 0, endIndex: 0 });
    });
});
