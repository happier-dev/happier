import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

import { renderScreen } from '@/dev/testkit';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { RetainedPanelSurface } from './RetainedPanelSurface';


declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('RetainedPanelSurface', () => {
    it.each([false, true])('retains responsive measurements through hidden layouts with suspension %s', async suspendWhenHidden => {
        let initializations = 0;
        function MeasuredBody() {
            const layout = useMachineTabCompactLayout();
            const [draft] = React.useState(() => { initializations += 1; return 'retained draft'; });
            return React.createElement('MeasuredBody', { ...layout, draft });
        }
        const content = <MeasuredBody />;
        const panel = (active: boolean) => <RetainedPanelSurface isActive={active} suspendWhenHidden={suspendWhenHidden}>{content}</RetainedPanelSurface>;
        const tree = await renderScreen(panel(true));
        const body = () => tree.findByType('MeasuredBody');
        const onLayout = body().props.onLayout;
        const measure = async (width: number) => act(async () => onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 200 } } }));
        expect(body().props.measured).toBe(false);
        await measure(0);
        expect(body().props.measured).toBe(false);
        await measure(900);
        expect(body().props).toMatchObject({ measured: true, compact: false });
        await tree.update(panel(false));
        await measure(0);
        await tree.update(panel(true));
        expect(body().props).toMatchObject({ measured: true, compact: false, draft: 'retained draft' });
        await measure(280);
        expect(body().props).toMatchObject({ measured: true, compact: true });
        expect(initializations).toBe(1);
        await tree.unmount();
    });

    it('defers Activity content until first presentation, then withdraws effects and preserves its draft', async () => {
        const store = createStore(() => ({ value: 0 }));
        let initializations = 0;
        let effects = 0;
        let renders = 0;
        function Editor() {
            const value = useStore(store, state => state.value);
            const [draft, setDraft] = React.useState(() => { initializations += 1; return ''; });
            React.useEffect(() => { effects += 1; return () => { effects -= 1; }; }, []);
            renders += 1;
            return React.createElement('ActivityEditor', { value, draft, onChangeText: setDraft });
        }
        const content = <Editor />;
        const panel = (active: boolean) => <RetainedPanelSurface isActive={active} hiddenMode="activity" testID="activity-panel">{content}</RetainedPanelSurface>;
        const tree = await renderScreen(panel(false));
        expect(initializations).toBe(0);
        expect(effects).toBe(0);
        await tree.update(panel(true));
        await act(async () => tree.findByType('ActivityEditor').props.onChangeText('unsent draft'));
        expect(effects).toBe(1);
        await tree.update(panel(false));
        expect(effects).toBe(0);
        expect(tree.findHostByTestId('activity-panel')?.props.pointerEvents).toBe('none');
        renders = 0;
        await act(async () => { store.setState({ value: 3 }); });
        expect(renders).toBe(0);
        await tree.update(panel(true));
        expect(tree.findByType('ActivityEditor').props).toMatchObject({ value: 3, draft: 'unsent draft' });
        expect(initializations).toBe(1);
        expect(effects).toBe(1);
        await tree.unmount();
        expect(effects).toBe(0);
    });

    it('keeps a generic background result consumer live while the surface is hidden by default', async () => {
        const store = createStore(() => ({ result: 'pending' }));
        const observed: string[] = [];
        function ResultConsumer() {
            const result = useStore(store, state => state.result);
            React.useEffect(() => { observed.push(result); }, [result]);
            return null;
        }
        const content = <ResultConsumer />;
        const panel = (active: boolean) => <RetainedPanelSurface isActive={active}>{content}</RetainedPanelSurface>;
        const tree = await renderScreen(panel(true));
        await tree.update(panel(false));
        await act(async () => { store.setState({ result: 'settled' }); });
        expect(observed).toEqual(['pending', 'settled']);
        await tree.unmount();
    });

    it.each(['web', 'ios', 'android'] as const)('suspends hidden %s renders, preserving background effects and draft state and revealing current data', async platform => {
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const store = createStore(() => ({ value: 0 }));
        let renders = 0;
        let subscriptions = 0;
        let initializations = 0;
        const subscribe = store.subscribe;
        store.subscribe = listener => {
            subscriptions += 1;
            const unsubscribe = subscribe(listener);
            return () => { subscriptions -= 1; unsubscribe(); };
        };
        function Editor() {
            const value = useStore(store, state => state.value);
            const [draft, setDraft] = React.useState(() => { initializations += 1; return ''; });
            renders += 1;
            return React.createElement('Editor', { value, draft, onChangeText: setDraft });
        }
        const child = <Editor />;
        const panel = (active: boolean) => <RetainedPanelSurface isActive={active} suspendWhenHidden>{child}</RetainedPanelSurface>;
        try {
            const tree = await renderScreen(panel(true));
            await act(async () => tree.findByType('Editor').props.onChangeText('unsent draft'));
            await tree.update(panel(false));
            renders = 0;
            for (let value = 1; value <= 3; value++) {
                await act(async () => { store.setState({ value }); });
            }
            console.info('FX89 hidden retained subscriptions', { platform, renders, subscriptions });
            expect(renders).toBe(0);
            // Retained workflows (approvals and dirty-editor guards) keep their passive effects.
            expect(subscriptions).toBe(1);
            await tree.update(panel(true));
            expect(tree.findByType('Editor').props).toMatchObject({ value: 3, draft: 'unsent draft' });
            expect(initializations).toBe(1);
            expect(subscriptions).toBe(1);
            await tree.unmount();
            expect(subscriptions).toBe(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('keeps an inactive web surface mounted but inert until it becomes active again', async () => {
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const tracker = createMountTracker();
        try {
            const tree = await renderScreen(
                <RetainedPanelSurface isActive mode="absolute-overlay" testID="retained-panel-under-test">
                    <Tracked tracker={tracker} />
                    <FocusEligibilityProbe />
                </RetainedPanelSurface>,
            );

            expect(tracker.mounts).toBe(1);
            expect(tree.findByType('FocusEligibilityProbe').props.eligible).toBe(true);

            await tree.update(
                    <RetainedPanelSurface isActive={false} mode="absolute-overlay" testID="retained-panel-under-test">
                        <Tracked tracker={tracker} />
                        <FocusEligibilityProbe />
                    </RetainedPanelSurface>,
            );

            const inactiveSurface = tree.findHostByTestId('retained-panel-under-test');
            if (!inactiveSurface) throw new Error('Expected the retained panel surface');
            expect(inactiveSurface.props.pointerEvents).toBe('none');
            expect(inactiveSurface.props.inert).toBe(true);
            expect(inactiveSurface.props['aria-hidden']).toBe(true);
            expect(tracker.unmounts).toBe(0);
            expect(tree.findByType('FocusEligibilityProbe').props.eligible).toBe(false);

            await tree.update(
                    <RetainedPanelSurface isActive mode="absolute-overlay" testID="retained-panel-under-test">
                        <Tracked tracker={tracker} />
                        <FocusEligibilityProbe />
                    </RetainedPanelSurface>,
            );

            const activeSurface = tree.findHostByTestId('retained-panel-under-test');
            if (!activeSurface) throw new Error('Expected the retained panel surface');
            expect(activeSurface.props).toMatchObject({
                pointerEvents: 'auto',
                inert: undefined,
                'aria-hidden': undefined,
            });
            expect(tracker.mounts).toBe(1);
            expect(tracker.unmounts).toBe(0);
            expect(tree.findByType('FocusEligibilityProbe').props.eligible).toBe(true);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('hides inactive native surface descendants from accessibility and pointer interaction', async () => {
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const tracker = createMountTracker();
        try {
            const tree = await renderScreen(
                <RetainedPanelSurface isActive mode="absolute-overlay" testID="retained-panel-under-test">
                    <Tracked tracker={tracker} />
                    <FocusEligibilityProbe />
                </RetainedPanelSurface>,
            );

            await tree.update(
                    <RetainedPanelSurface isActive={false} mode="absolute-overlay" testID="retained-panel-under-test">
                        <Tracked tracker={tracker} />
                        <FocusEligibilityProbe />
                    </RetainedPanelSurface>,
            );

            const inactiveSurface = tree.findHostByTestId('retained-panel-under-test');
            if (!inactiveSurface) throw new Error('Expected the retained panel surface');
            expect(inactiveSurface.props).toMatchObject({
                inert: undefined,
                'aria-hidden': undefined,
                accessibilityElementsHidden: true,
                importantForAccessibility: 'no-hide-descendants',
                pointerEvents: 'none',
            });

            await tree.update(
                    <RetainedPanelSurface isActive mode="absolute-overlay" testID="retained-panel-under-test">
                        <Tracked tracker={tracker} />
                        <FocusEligibilityProbe />
                    </RetainedPanelSurface>,
            );

            const activeSurface = tree.findHostByTestId('retained-panel-under-test');
            if (!activeSurface) throw new Error('Expected the retained panel surface');
            expect(activeSurface.props).toMatchObject({
                accessibilityElementsHidden: false,
                importantForAccessibility: 'auto',
                pointerEvents: 'auto',
            });
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});

type MountTracker = {
    mounts: number;
    unmounts: number;
};

function createMountTracker(): MountTracker {
    return { mounts: 0, unmounts: 0 };
}

function Tracked(props: Readonly<{ tracker: MountTracker }>) {
    React.useEffect(() => {
        props.tracker.mounts += 1;
        return () => {
            props.tracker.unmounts += 1;
        };
    }, [props.tracker]);
    return React.createElement('Tracked');
}

function FocusEligibilityProbe(): React.ReactElement {
    return React.createElement('FocusEligibilityProbe', {
        eligible: usePluginSurfaceFocusEligibility(),
    });
}
