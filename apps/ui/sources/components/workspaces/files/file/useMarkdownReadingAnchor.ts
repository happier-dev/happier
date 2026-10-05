import * as React from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import type { MarkdownSourceRangeAction, MarkdownSourceRangeLayoutObserver } from '@/components/markdown/MarkdownView';
import { mapCodeReadingAnchor, mapCodeReadingAnchors } from '@/components/ui/code/model/mapCodeReadingAnchor';

type Layout = Readonly<{ y: number; height: number }>;
type Anchor = Readonly<{ index: number; offset: number }>;

/** The Markdown renderer measures its own blocks; the file preview remains the only scroll owner. */
export function useMarkdownReadingAnchor(identity: string, paddingTop: number) {
    const scrollRef = React.useRef<ScrollView>(null);
    const state = React.useMemo(() => ({
        ranges: [] as readonly MarkdownSourceRangeAction[],
        indices: new Map<number, number>(),
        layouts: new Map<number, Layout>(),
        anchor: null as Anchor | null,
        pending: false,
        anchorMeasured: false,
        scrollY: 0,
        requestedY: null as number | null,
        requestedLine: null as number | null,
    }), [identity]);
    const restore = React.useCallback(() => {
        if (!state.pending || !state.anchor || !state.anchorMeasured) return;
        const layout = state.layouts.get(state.anchor.index);
        if (!layout) return;
        const y = Math.max(0, paddingTop + layout.y + Math.min(state.anchor.offset, layout.height));
        if (y === state.scrollY) return;
        state.requestedY = y;
        state.scrollY = y;
        scrollRef.current?.scrollTo({ y, animated: false });
    }, [paddingTop, state]);
    const revealRequestedLine = React.useCallback(() => {
        if (state.requestedLine === null) return;
        const index = state.ranges.findIndex((range) => range.sourceRange.startLine <= state.requestedLine!
            && range.sourceRange.endLine >= state.requestedLine!);
        if (index < 0) return;
        state.anchor = { index, offset: 0 };
        state.pending = true;
        state.anchorMeasured = state.layouts.has(index);
        if (state.anchorMeasured) { state.requestedLine = null; restore(); }
    }, [restore, state]);
    const observer = React.useMemo<MarkdownSourceRangeLayoutObserver>(() => ({
        onRanges: (ranges) => {
            if (state.ranges === ranges) return;
            if (state.anchor && state.ranges.length > 0) {
                const index = mapCodeReadingAnchor(state.ranges.map((range) => range.markdown), ranges.map((range) => range.markdown), state.anchor.index);
                state.anchor = index < 0 ? null : { index, offset: state.anchor.offset };
                state.pending = state.anchor !== null;
            }
            const previousLayouts = [...state.layouts];
            const mapped = mapCodeReadingAnchors(state.ranges.map((range) => range.markdown), ranges.map((range) => range.markdown), previousLayouts.map(([index]) => index));
            state.layouts = new Map(previousLayouts.flatMap(([, layout], position) => {
                const index = mapped[position];
                return index === null || index === undefined ? [] : [[index, layout] as const];
            }));
            state.anchorMeasured = false;
            state.ranges = ranges;
            state.indices = new Map(ranges.map((range, index) => [range.sourceRange.startLine, index]));
            revealRequestedLine();
        },
        onLayout: (range, layout) => {
            const index = state.indices.get(range.sourceRange.startLine);
            if (index === undefined || state.ranges[index]?.markdown !== range.markdown) return;
            state.layouts.set(index, layout);
            if (state.anchor?.index === index) state.anchorMeasured = true;
            revealRequestedLine();
            restore();
        },
    }), [restore, revealRequestedLine, state]);
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const y = event.nativeEvent.contentOffset.y;
        if (state.requestedY !== null && Math.abs(y - state.requestedY) < 1) {
            state.requestedY = null;
            state.scrollY = y;
            return;
        }
        state.requestedY = null;
        state.pending = false;
        state.requestedLine = null;
        state.scrollY = y;
        let index = -1;
        let closestY = -Infinity;
        for (const [candidate, layout] of state.layouts) {
            if (layout.y <= y - paddingTop && layout.y > closestY) {
                index = candidate;
                closestY = layout.y;
            }
        }
        state.anchor = index < 0 ? null : { index, offset: y - paddingTop - closestY };
    }, [paddingTop, state]);
    React.useLayoutEffect(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [state]);
    const revealLine = React.useCallback((line: number) => {
        state.requestedLine = line;
        revealRequestedLine();
    }, [revealRequestedLine, state]);
    return { scrollRef, observer, onScroll, onContentSizeChange: restore, revealLine };
}
