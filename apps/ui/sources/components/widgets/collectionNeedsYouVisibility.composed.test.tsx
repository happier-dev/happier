import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const motion = vi.hoisted(() => ({ starts: 0, stops: 0 }));
vi.mock('react-native', async () => {
    const native = await vi.importActual<typeof import('react-native')>('react-native');
    const animation = () => ({ start() { motion.starts++; }, stop() { motion.stops++; } });
    return { ...native, Platform: { ...native.Platform, OS: 'android' },
    FlatList: ({ data, renderItem, ...props }: { data: readonly unknown[]; renderItem: (input: { item: unknown; index: number }) => React.ReactNode }) =>
        React.createElement('FlatList', props, data.map((item, index) => <React.Fragment key={index}>{renderItem({ item, index })}</React.Fragment>)),
    SectionList: ({ sections, renderItem, renderSectionHeader, ...props }: {
        sections: readonly { key: string; data: readonly unknown[] }[];
        renderItem: (input: { item: unknown; index: number; section: unknown }) => React.ReactNode;
        renderSectionHeader: (input: { section: unknown }) => React.ReactNode;
    }) => React.createElement('SectionList', props, sections.map(section => <React.Fragment key={section.key}>
        {renderSectionHeader({ section })}{section.data.map((item, index) => <React.Fragment key={index}>{renderItem({ item, index, section })}</React.Fragment>)}
    </React.Fragment>)),
    Animated: {
        ...native.Animated, timing: animation, loop: animation, sequence: animation, delay: animation,
    } };
});

import { Collection } from '../../../../../packages/plugin-ui/src/components/Collection';
import { List } from '../../../../../packages/plugin-ui/src/components/List';
import { PluginUiProviderInternal } from '../../../../../packages/plugin-ui/src/components/PluginUiProvider';
import { useHappierCollection } from '../../../../../packages/plugin-ui/src/presentation/collection/useCollection';
import { PluginUiScrollActivityProvider } from '../../../../../packages/plugin-ui/src/presentationHost/scrollActivity';
import { createHostApiStub, createSurfaceContext } from '../../../../../packages/plugin-ui/src/surfaceFixture.testSupport';
import { createScrollViewNearViewportTracker } from './nearViewport';

describe('Collection needs-you native viewport demand', () => {
    it('retains native row bodies when existing scroll-metrics demand changes', async () => {
        const context = createSurfaceContext();
        let mounts = 0;
        function Body() {
            React.useEffect(() => { mounts++; }, []);
            return null;
        }
        const tree = (observe: boolean) => <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={{
            renderMarkdown: () => null, renderCodeBlock: () => null, renderIcon: () => null, renderPopover: () => null,
            createScrollActivityTracker: createScrollViewNearViewportTracker,
        }}><List items={[{ id: 'calm' }]} keyForItem={item => item.id}
            preserveVisibleContentPositionOnInsert={observe ? { anchorKey: 'calm', revision: 1 } : undefined}
            renderItem={item => <List.Item title={item.id}><Body /></List.Item>} /></PluginUiProviderInternal>;
        let renderer: ReactTestRenderer | undefined;
        await act(async () => { renderer = create(tree(false)); });
        try {
            expect(mounts).toBe(1);
            await act(async () => { renderer!.update(tree(true)); });
            await act(async () => { renderer!.update(tree(false)); });
            expect(mounts).toBe(1);
        } finally { act(() => renderer?.unmount()); }
    });
    it('keeps a plain List without scroll demand free of an added native scroll subscription', async () => {
        const context = createSurfaceContext();
        let renderer: ReactTestRenderer | undefined;
        await act(async () => {
            renderer = create(<PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={{
                renderMarkdown: () => null, renderCodeBlock: () => null, renderIcon: () => null, renderPopover: () => null,
                createScrollActivityTracker: createScrollViewNearViewportTracker,
            }}><List items={[{ id: 'calm' }]} keyForItem={item => item.id}
                renderItem={item => <List.Item title={item.id} />} /></PluginUiProviderInternal>);
        });
        try {
            const list = renderer!.root.find(node => node.type === 'FlatList');
            expect(list.props.onScroll).toBeUndefined();
        } finally { act(() => renderer?.unmount()); }
    });
    it.each([
        ['glint', 'host-page'], ['shimmer', 'host-page'],
        ['glint', 'page'], ['shimmer', 'page'],
        ['glint', 'bounded'], ['shimmer', 'bounded'],
        ['glint', 'sectioned'], ['shimmer', 'sectioned'],
    ] as const)('keeps offscreen %s stopped and starts it on entry through %s', async (preference, owner) => {
        motion.starts = 0; motion.stops = 0;
        let offset = 0;
        let measurements = 0;
        const content = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, -offset, 300, 2000) };
        const row = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
            measurements++;
            callback(0, 240 - offset, 300, 40);
        } };
        const tracker = createScrollViewNearViewportTracker({ current: { getInnerViewRef: () => content } }, false, { initialViewportHeight: 200 });
        const scrollNode = { getInnerViewRef: () => content, scrollTo() {} };
        const context = createSurfaceContext();
        const rows = [{ id: 'waiting' }];
        const groups = owner === 'sectioned' ? { axis: [{ key: 'all', title: 'Rows' }], groupOf: () => 'all' } : undefined;
        function Rows() {
            const model = useHappierCollection({ items: rows, keyOf: item => item.id, openKey: null, onOpenChange() {}, ...(groups === undefined ? {} : { groups }) });
            return <Collection model={model} accessibilityLabel="Rows" presentation="list" detail="none" scroll={owner === 'bounded' || owner === 'sectioned' ? undefined : 'page'} anatomy={{
                title: item => item.id, glyph: () => null, testID: item => item.id,
                needsYou: () => ({ unopened: true }), accessibilityLabel: item => item.id, columnTitles: { title: 'Row' },
            }} />;
        }
        let renderer: ReactTestRenderer | undefined;
        await act(async () => {
            renderer = create(<PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={{
                renderMarkdown: () => null, renderCodeBlock: () => null, renderIcon: () => null, renderPopover: () => null,
                ...(owner === 'host-page' ? { renderPageScroller: (children: React.ReactNode) => React.createElement('ScrollView', {
                    onScroll: tracker.onScroll, onLayout: tracker.onLayout, onContentSizeChange: tracker.onContentSizeChange,
                }, children) } : {}),
                createScrollActivityTracker: createScrollViewNearViewportTracker,
                collectionRowNeedsYou: { useFacts: () => ({ preference, reducedMotion: false, presented: true }) },
            }}><PluginUiScrollActivityProvider tracker={owner === 'host-page' ? tracker : null}><Rows /></PluginUiScrollActivityProvider></PluginUiProviderInternal>, {
                createNodeMock: element => element.props.testID === 'waiting:needs-you:viewport' ? row
                    : element.type === 'ScrollView' ? scrollNode
                    : element.type === 'FlatList' || element.type === 'SectionList' ? {
                        getNativeScrollRef: () => scrollNode, getScrollResponder: () => scrollNode,
                        scrollToOffset() {}, scrollToIndex() {}, scrollToEnd() {}, scrollToLocation() {},
                    } : null,
            });
        });
        const physicalScroller = () => renderer!.root.find(node =>
            ['ScrollView', 'FlatList', 'SectionList'].includes(String(node.type)) && typeof node.props.onScroll === 'function');
        const layout = async () => act(async () => {
            physicalScroller().props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 200 } } });
            for (const view of renderer!.root.findAll(node => node.type === 'View' && typeof node.props.onLayout === 'function')) {
                view.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 40 } } });
            }
        });
        const scroll = async (next: number) => act(async () => {
            offset = next;
            physicalScroller().props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: next } } });
        });
        try {
            await layout();
            expect(motion.starts).toBe(0);
            // The row is already in the prebuild window. Only the exact viewport should admit its sweep.
            await scroll(41);
            await layout();
            expect(motion.starts).toBe(1);
            const placedMeasurements = measurements;
            await scroll(42);
            await scroll(60);
            expect(motion.starts).toBe(1);
            expect(motion.stops).toBe(0);
            expect(measurements).toBe(placedMeasurements);
            await scroll(281);
            expect(motion.stops).toBe(1);
            await scroll(41);
            await layout();
            expect(motion.starts).toBe(2);
        } finally { act(() => renderer?.unmount()); }
    });
});
