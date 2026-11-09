import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    createRetainedPresentationSlotsStore,
    RetainedPresentationGeometryRefreshContext,
    RetainedPresentationSlotBinder,
    RetainedPresentationSlotsProvider,
} from '@/components/ui/presentation/retainedPresentationSlots';
import { TranscriptListShell } from './TranscriptListShell';
import { resolveMainTranscriptListShellFrame } from './transcriptListShellCapabilities';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

// Legend's physical list and native host measurements are the only substituted boundaries.
vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef<unknown, Readonly<{
        data: readonly { id: string }[];
        renderItem: (info: { item: { id: string }; index: number }) => React.ReactNode;
    }>>((props, ref) => {
        React.useImperativeHandle(ref, () => ({
            getState: () => ({ contentLength: 200, scrollLength: 200, scroll: 0,
                isAtEnd: true, isNearEnd: true, isWithinMaintainScrollAtEndThreshold: true,
                listen: () => () => {} }),
            scrollToEnd: () => {}, scrollToIndex: () => {}, scrollToOffset: () => {},
        }), []);
        return React.createElement('LegendList', props, props.data.map((item, index) => (
            <React.Fragment key={item.id}>{props.renderItem({ item, index })}</React.Fragment>
        )));
    }),
}));

describe('native transcript retained presentation geometry', () => {
    it('clips the retained source to its viewport and follows native scrolling without remounting', async () => {
        const store = createRetainedPresentationSlotsStore();
        const viewport = { x: 10, y: 50, width: 300, height: 200 };
        let bodyY = 100;
        let mounts = 0;
        function Source() {
            React.useEffect(() => { mounts += 1; }, []);
            return React.createElement('PhysicalSource');
        }
        const screen = await renderScreen(<RetainedPresentationSlotsProvider store={store}>
            <RetainedPresentationGeometryRefreshContext.Provider value={store.refreshPortalGeometry}>
                <TranscriptListShell
                    data={[{ id: 'visual' }]} dataKey="native-visual"
                    keyExtractor={item => item.id}
                    webDomObservation={createWebDomScrollObservation()}
                    frame={resolveMainTranscriptListShellFrame({ platformOS: 'ios' })}
                    renderItem={() => <RetainedPresentationSlotBinder slotId="native-visual" enabled>
                        <Source />
                    </RetainedPresentationSlotBinder>}
                />
            </RetainedPresentationGeometryRefreshContext.Provider>
        </RetainedPresentationSlotsProvider>, {
            createNodeMock: element => ({ measureInWindow: (publish: (x: number, y: number, width: number, height: number) => void) => {
                const rect = element.props.testID === 'browser-keepalive-placeholder-native-visual'
                    ? { x: 10, y: bodyY, width: 300, height: 300 } : viewport;
                publish(rect.x, rect.y, rect.width, rect.height);
            } }),
        });
        try {
            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('browser-keepalive-placeholder-native-visual'), 'onLayout', {});
            });
            expect(store.getPortalSnapshot()[0]?.geometry?.y).toBe(100);
            expect(store.getPortalSnapshot()[0]?.clipGeometry).toEqual(viewport);
            bodyY = -100;
            await act(async () => {
                invokeTestInstanceHandler(screen.findByType('LegendList'), 'onScroll', { nativeEvent: {
                    contentOffset: { x: 0, y: 200 }, contentSize: { width: 300, height: 600 },
                    layoutMeasurement: { width: 300, height: 200 },
                } });
            });
            expect(store.getPortalSnapshot()[0]?.geometry?.y).toBe(-100);
            expect(store.getPortalSnapshot()[0]?.clipGeometry).toEqual(viewport);
            expect(mounts).toBe(1);
        } finally { await screen.unmount(); }
    });
});
