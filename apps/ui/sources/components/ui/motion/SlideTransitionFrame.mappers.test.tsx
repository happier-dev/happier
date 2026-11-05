import * as React from 'react';
import { resolve } from 'node:path';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useSharedValue } from 'react-native-reanimated';
import * as Reanimated from 'react-native-reanimated';
import * as Native from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { loadWorkletModule } from '@/dev/testkit/mocks/reanimatedMappers';

const mapperLifecycle = vi.hoisted(() => ({ starts: 0, stops: 0 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedMapperMock } = await import('@/dev/testkit/mocks/reanimatedMappers');
    const base = await vi.importActual<typeof import('react-native-reanimated')>('react-native-reanimated');
    const mapper = createReanimatedMapperMock(event => {
        if (event === 'start') mapperLifecycle.starts++;
        else mapperLifecycle.stops++;
    });
    return { ...base, ...mapper, default: { ...base.default, ...mapper.default }, Easing: base.Easing };
});
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const ChildContext = React.createContext<string | null>(null);
function contextChild(testID: string): React.ReactElement {
    // React's real Context is a plain object whose Provider points back to itself.
    // This is an ordinary supported React child, not a manufactured mapper input.
    return <ChildContext.Provider value={testID}><Text testID={testID}>{testID}</Text></ChildContext.Provider>;
}

describe('mounted slide mapper inputs', () => {
    it('mounts React-owned children and keeps motion live across progress, geometry and reduced-motion changes', async () => {
        const { SlideTransitionBlurLayer } = await loadWorkletModule<typeof import('./SlideTransitionBlurLayer')>(
            resolve(import.meta.dirname, 'SlideTransitionBlurLayer.tsx'),
            new Map<string, unknown>([['react-native-reanimated', Reanimated], ['react-native', Native]]),
        );
        const { SlideTransitionFrame } = await loadWorkletModule<typeof import('./SlideTransitionFrame')>(
            resolve(import.meta.dirname, 'SlideTransitionFrame.tsx'),
            new Map<string, unknown>([['./SlideTransitionBlurLayer', { SlideTransitionBlurLayer }],
                ['react-native-reanimated', Reanimated], ['react-native', Native]]),
        );
        const current = contextChild('current');
        const next = contextChild('next');
        let progress: ReturnType<typeof useSharedValue<number>>;
        function Harness({ reducedMotion = false }: { reducedMotion?: boolean }) {
            progress = useSharedValue(0);
            return <SlideTransitionFrame progress={progress} reducedMotion={reducedMotion} testID="frame"
                current={current} next={next} />;
        }
        const screen = await renderScreen(<Harness />);
        expect(Reflect.get(progress!, '_isReanimatedSharedValue')).toBe(true);
        expect(screen.findByTestId('current')).not.toBeNull();
        expect(screen.findByTestId('next')).not.toBeNull();
        await act(async () => { progress.value = -0.5; });
        const currentStyle = screen.findByTestId('frame-current-layer')!.props.style.at(-1);
        expect(currentStyle.opacity).toBe(0.5);
        expect(currentStyle.transform[0].translateX).toBeLessThan(0);
        expect(screen.findByTestId('frame-current-blur')!.props.style.at(-1).opacity).toBe(1);
        await screen.update(<Harness reducedMotion />);
        const reducedStyle = screen.findByTestId('frame-current-layer')!.props.style.at(-1);
        expect(reducedStyle.opacity).toBe(0.5);
        expect(Math.abs(reducedStyle.transform[0].translateX)).toBe(0);
        expect(screen.findByTestId('frame-current-blur')).toBeNull();
        await screen.unmount();
    });

    it('mounts the desktop notch without admitting its React content into a mapper', async () => {
        const notchDir = resolve(import.meta.dirname, '../../../activity/adapters/desktop/ui/notch');
        const motion = await loadWorkletModule<typeof import('@/activity/adapters/desktop/ui/notch/useNotchMotion')>(
            resolve(notchDir, 'useNotchMotion.ts'),
            new Map<string, unknown>([['react-native-reanimated', Reanimated]]),
        );
        const { NotchShape } = await loadWorkletModule<typeof import('@/activity/adapters/desktop/ui/notch/NotchShape')>(
            resolve(notchDir, 'NotchShape.tsx'),
            new Map<string, unknown>([
                ['./useNotchMotion', motion],
                ['react-native-svg', { ...(await import('@/dev/testkit/mocks/reactNativeSvg')), __esModule: true }],
                ['react-native-reanimated', Reanimated],
                ['react-native', Native],
            ]),
        );
        const standard = contextChild('standard');
        const open = contextChild('open');
        function Harness() {
            return (
                <NotchShape
                    dock="top"
                    form="standard"
                    growth={{ x: null, y: 'down' }}
                    anchorOffset={{ x: 0, y: 0 }}
                    camera={null}
                    renderStandard={() => standard}
                    renderOpen={() => open}
                    onTipPress={() => {}}
                    tipAccessibilityLabel={undefined}
                    onPresent={() => {}}
                />
            );
        }
        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('standard')).not.toBeNull();
        expect(screen.findByTestId('open')).not.toBeNull();
        await screen.unmount();
    });

    it('retains motion subscriptions when only the rendered content changes', async () => {
        const { SlideTransitionFrame } = await loadWorkletModule<typeof import('./SlideTransitionFrame')>(
            resolve(import.meta.dirname, 'SlideTransitionFrame.tsx'),
            new Map<string, unknown>([['react-native-reanimated', Reanimated], ['react-native', Native]]),
        );
        function Harness({ text }: { text: string }) {
            const progress = useSharedValue(0);
            return <SlideTransitionFrame progress={progress} blur={false} current={<Text testID="content">{text}</Text>} />;
        }
        const screen = await renderScreen(<Harness text="first" />);
        const initial = { ...mapperLifecycle };
        await screen.update(<Harness text="second" />);
        expect(screen.findByTestId('content')!.props.children).toBe('second');
        expect(mapperLifecycle).toEqual(initial);
        await screen.unmount();
        expect(mapperLifecycle.stops).toBeGreaterThan(initial.stops);
    });

    it('mounts a reorder list with scroll metrics without admitting its row children into a mapper', async () => {
        const { EntityFlatReorderList } = await loadWorkletModule<typeof import('../treeDragDrop/ui/EntityFlatReorder')>(
            resolve(import.meta.dirname, '../treeDragDrop/ui/EntityFlatReorder.tsx'),
            new Map<string, unknown>([['react-native-reanimated', Reanimated], ['react-native', Native]]),
        );
        const child = contextChild('row');
        function Harness() {
            const offsetY = useSharedValue(0);
            const contentHeight = useSharedValue(100);
            return <EntityFlatReorderList scrollMetrics={{ offsetY, contentHeight }} testID="list" binding={{
                scope: null, kind: 'todo', items: [], getItem: () => null, getSourceId: () => null,
                resolve: () => ({ status: 'refused', reason: { code: 'empty', message: 'Empty' } }),
                execute: async () => ({ status: 'applied' }),
            }}>{child}</EntityFlatReorderList>;
        }
        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('row')).not.toBeNull();
        await screen.update(<Harness />);
        await screen.unmount();
    });
});
