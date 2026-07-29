import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const legendMock = vi.hoisted(() => ({
    refHandle: {
        scrollToIndex: vi.fn(() => Promise.resolve()),
        scrollToOffset: vi.fn(() => Promise.resolve()),
        scrollToEnd: vi.fn(() => Promise.resolve()),
        scrollToLocation: vi.fn(),
        clearCaches: vi.fn(),
        getState: vi.fn(() => ({ scroll: 0 })),
    },
    props: null as any,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        SectionList: React.forwardRef((props: any, ref) => {
            if (ref && typeof ref === 'object') {
                ref.current = { scrollToLocation: () => {}, getScrollResponder: () => ({ scrollTo: () => {} }) };
            }
            const rows = (props.sections ?? []).flatMap((section: any, sectionIndex: number) => (
                (section.data ?? []).map((item: any, index: number) => React.createElement(
                    React.Fragment,
                    { key: props.keyExtractor ? props.keyExtractor(item, index) : `${sectionIndex}:${index}` },
                    props.renderItem?.({ item, index, section }),
                ))
            ));
            return React.createElement('SectionList', props, ...rows);
        }),
    });
});

vi.mock('@legendapp/list/section-list', async () => {
    const ReactModule = await import('react');
    return {
        SectionList: ReactModule.forwardRef((props: any, ref) => {
            legendMock.props = props;
            if (ref && typeof ref === 'object') ref.current = legendMock.refHandle;
            else if (typeof ref === 'function') ref(legendMock.refHandle);
            return ReactModule.createElement('LegendSectionList', props);
        }),
    };
});

type Row = { id: string };
const sections = [{ key: 's1', title: 'A', data: [{ id: 'a' }, { id: 'b' }] }];

async function renderSectionList(extra: Record<string, unknown> = {}, ref?: React.Ref<any>) {
    const { VirtualizedSectionList } = await import('../VirtualizedSectionList');
    return renderScreen(
        <VirtualizedSectionList<Row>
            sections={sections}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => React.createElement('View', { testID: `row-${item.id}` })}
            ref={ref}
            {...extra}
        />,
    );
}

describe('VirtualizedSectionList', () => {
    it('renders the Legend SectionList backend by default', async () => {
        const screen = await renderSectionList();
        expect(screen.findAllByType('LegendSectionList' as any)).toHaveLength(1);
        expect(screen.findAllByType('SectionList' as any)).toHaveLength(0);
    });

    it('renders the Legend section backend when explicitly preferred', async () => {
        const screen = await renderSectionList({ backendPreference: 'legend' });
        expect(screen.findAllByType('LegendSectionList' as any)).toHaveLength(1);
        expect(screen.findAllByType('SectionList' as any)).toHaveLength(0);
    });

    it('forwards the stable section ref contract onto the Legend backend handle', async () => {
        const ref = React.createRef<any>();
        await renderSectionList({ backendPreference: 'legend' }, ref);
        ref.current.scrollToLocation({ sectionIndex: 0, itemIndex: 1 });
        ref.current.scrollToIndex({ index: 2 });
        ref.current.clearMeasurementCache({ mode: 'sizes' });
        expect(legendMock.refHandle.scrollToLocation).toHaveBeenCalledWith({ sectionIndex: 0, itemIndex: 1 });
        expect(legendMock.refHandle.scrollToIndex).toHaveBeenCalledWith({ index: 2 });
        expect(legendMock.refHandle.clearCaches).toHaveBeenCalledWith({ mode: 'sizes' });
    });
});
