import { describe, expect, it, vi } from 'vitest';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import { renderHook } from '@/dev/testkit';
import { splitMarkdownRenderSegments } from '@/components/markdown/rendering/splitMarkdownRenderSegments';
import { useMarkdownReadingAnchor } from './useMarkdownReadingAnchor';

const ranges = (markdown: string) => splitMarkdownRenderSegments({ markdown, streamingMode: 'static', splitEnrichedSourceRanges: true });
const scrollEvent = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } }) as NativeSyntheticEvent<NativeScrollEvent>;

describe('Markdown file reading continuity', () => {
    it('reveals an offscreen Find source line after its block is measured and lets manual scrolling take over', async () => {
        const hook = await renderHook(() => useMarkdownReadingAnchor('session:find', 24));
        const anchor = hook.getCurrent();
        const scrollTo = vi.fn();
        anchor.scrollRef.current = { scrollTo } as unknown as ScrollView;
        const blocks = ranges('# Heading\n\nFirst paragraph.\n\nNeedle paragraph.');
        anchor.observer.onRanges(blocks);
        anchor.revealLine(5);
        expect(scrollTo).not.toHaveBeenCalled();
        blocks.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 100, height: 100 }));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 224, animated: false });
        anchor.onScroll(scrollEvent(224));
        anchor.onScroll(scrollEvent(80));
        scrollTo.mockClear();
        anchor.observer.onLayout(blocks[2]!, { y: 250, height: 100 });
        expect(scrollTo).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it('follows the same paragraph across insertion, unchanged refresh, deletion and manual scrolling', async () => {
        const hook = await renderHook(() => useMarkdownReadingAnchor('session:readme', 24));
        const anchor = hook.getCurrent();
        const scrollTo = vi.fn();
        // The ScrollView imperative handle is the native/web platform boundary.
        anchor.scrollRef.current = { scrollTo } as unknown as ScrollView;
        const original = ranges('# Heading\n\nReading paragraph.\n\nNext paragraph.');
        anchor.observer.onRanges(original);
        original.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 100, height: 100 }));
        anchor.onScroll(scrollEvent(144));
        anchor.observer.onRanges(original);
        expect(scrollTo).not.toHaveBeenCalled();
        const inserted = ranges('# New heading\n\nInserted paragraph.\n\n# Heading\n\nReading paragraph.\n\nNext paragraph.');
        anchor.observer.onRanges(inserted);
        inserted.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 100, height: 100 }));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 344, animated: false });
        anchor.onScroll(scrollEvent(344));
        const deleted = ranges('# New heading\n\nInserted paragraph.\n\n# Heading\n\nNext paragraph.');
        anchor.observer.onRanges(deleted);
        deleted.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 90, height: 90 }));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 314, animated: false });
        anchor.onScroll(scrollEvent(314));
        anchor.onScroll(scrollEvent(134));
        scrollTo.mockClear();
        anchor.observer.onLayout(deleted[3]!, { y: 350, height: 100 });
        expect(scrollTo).not.toHaveBeenCalled();
        const prepended = ranges('Preamble.\n\n# New heading\n\nInserted paragraph.\n\n# Heading\n\nNext paragraph.');
        anchor.observer.onRanges(prepended);
        prepended.forEach((range, index) => anchor.observer.onLayout(range, { y: index * 100, height: 100 }));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 244, animated: false });
        await hook.unmount();
    });
    it('resets the passage on file identity changes', async () => {
        const hook = await renderHook((identity: string) => useMarkdownReadingAnchor(identity, 16), { initialProps: 'session:first' });
        const scrollTo = vi.fn();
        hook.getCurrent().scrollRef.current = { scrollTo } as unknown as ScrollView;
        const original = ranges('# Heading\n\nReading paragraph.');
        hook.getCurrent().observer.onRanges(original);
        original.forEach((range, index) => hook.getCurrent().observer.onLayout(range, { y: index * 100, height: 100 }));
        hook.getCurrent().onScroll(scrollEvent(130));
        await hook.rerender('session:second');
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
        scrollTo.mockClear();
        hook.getCurrent().observer.onRanges(ranges('Another file.'));
        hook.getCurrent().observer.onLayout(ranges('Another file.')[0]!, { y: 0, height: 100 });
        expect(scrollTo).not.toHaveBeenCalled();
    });
});
