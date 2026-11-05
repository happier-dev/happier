import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createNearViewportTracker } from '@/components/widgets/nearViewport';
import { HubWidgetSection } from './HubWidgetSection';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { HomeHubFrame } from './HomeHubFrame';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/' }).module);
// No app-shell provider is mounted: its real context admits no installed renderer.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
afterEach(standardCleanup);

describe('nested Home widget native geometry', () => {
    it('uses scroll-content position, not the grid-cell local y, and retains that span while scrolling', async () => {
        let scrollOffset = 0;
        const measure = (top: () => number) => ({ measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, top(), 400, 100) });
        // Native window origin includes the header/inset. The card is 3000px down the content,
        // while its layout event is y=0 relative to its own CardGrid/HappierColumn wrapper.
        const contentNode = measure(() => 56 - scrollOffset);
        const geometry = { quantum: 40, initialViewportHeight: 400, readContentNode: () => contentNode };
        const tracker = createNearViewportTracker(geometry);
        const instance = { v: 1 as const, id: 'nested-copy', definition: { kind: 'builtin' as const, id: 'count' }, bindings: {} };
        const screen = await renderScreen(<HubWidgetSection instance={instance} frameStyle="plain" menu={null} tracker={tracker} testID="nested-card" />, {
            createNodeMock: node => node.props.testID === 'nested-card' ? measure(() => 3056 - scrollOffset) : null,
        });
        await act(async () => { screen.findByTestId('nested-card')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 100 } } }); });
        expect(screen.findByTestId('nested-card.body') !== null).toBe(false);
        expect(screen.findByTestId('nested-card.deferred') !== null).toBe(true);
        await act(async () => { scrollOffset = 2200; tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: scrollOffset } } } as never); });
        expect(screen.findByTestId('nested-card.body') !== null).toBe(true);
        await act(async () => { scrollOffset = 0; tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: scrollOffset } } } as never); });
        expect(screen.findByTestId('nested-card.body') !== null).toBe(false);
    });

    it('remeasures after an ancestor moves without changing the cell-relative layout', async () => {
        let contentTop = 300;
        const measure = (top: () => number) => ({ measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, top(), 400, 100) });
        const contentNode = measure(() => 56);
        const geometry = { quantum: 40, initialViewportHeight: 400, readContentNode: () => contentNode };
        const tracker = createNearViewportTracker(geometry);
        const instance = { v: 1 as const, id: 'moving-copy', definition: { kind: 'builtin' as const, id: 'count' }, bindings: {} };
        const screen = await renderScreen(<HubWidgetSection instance={instance} frameStyle="plain" menu={null} tracker={tracker} testID="moving-card" />, {
            createNodeMock: node => node.props.testID === 'moving-card' ? measure(() => contentTop + 56) : null,
        });
        await act(async () => { screen.findByTestId('moving-card')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 100 } } }); });
        expect(screen.findByTestId('moving-card.body') !== null).toBe(true);
        await act(async () => {
            contentTop = 3000;
            // Home's acknowledged reorder/layout change; the nested card's local y remains zero.
            tracker.invalidateLayout();
        });
        expect(screen.findByTestId('moving-card.body') !== null).toBe(false);
    });

    it('defers while content measurement is unavailable and ignores a measurement from a retired instance', async () => {
        type MeasureDone = (x: number, y: number, width: number, height: number) => void;
        const pending: MeasureDone[] = [];
        let contentAvailable = false;
        const contentNode = { measureInWindow: (done: MeasureDone) => done(0, 56, 400, 4000) };
        const tracker = createNearViewportTracker({ quantum: 40, initialViewportHeight: 400,
            readContentNode: () => contentAvailable ? contentNode : null });
        const instance = (id: string) => ({ v: 1 as const, id, definition: { kind: 'builtin' as const, id: 'count' }, bindings: {} });
        const render = (id: string) => <HubWidgetSection instance={instance(id)} frameStyle="plain" menu={null} tracker={tracker} testID="pending-card" />;
        const screen = await renderScreen(render('old'), { createNodeMock: node => node.props.testID === 'pending-card'
            ? { measureInWindow: (done: MeasureDone) => { pending.push(done); } } : null });
        expect(screen.findByTestId('pending-card.body') !== null).toBe(false);
        await act(async () => { contentAvailable = true; tracker.onContentSizeChange(400, 4000); });
        const obsolete = pending.shift();
        expect(obsolete !== undefined).toBe(true);
        await screen.update(render('new'));
        await act(async () => { obsolete!(0, 356, 400, 100); });
        expect(screen.findByTestId('pending-card.body') !== null).toBe(false);
        await act(async () => { for (const done of pending.splice(0)) done(0, 3056, 400, 100); });
        expect(screen.findByTestId('pending-card.body') !== null).toBe(false);
    });
});

describe('a Home widget in a retained workspace tab', () => {
    it('builds a newly visible widget in a visible unfocused Home without rebuilding its frame', async () => {
        let scrollOffset = 0;
        const measure = (top: () => number) => ({ measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, top(), 400, 100) });
        const contentNode = measure(() => 56 - scrollOffset);
        const tracker = createNearViewportTracker({ quantum: 40, initialViewportHeight: 400, readContentNode: () => contentNode });
        const navigation = { push: () => {}, replace: () => {}, back: () => {} };
        const screen = await renderScreen(<DestinationInstanceHost tabId="home-tab" ref={{ kind: 'sessions', params: {} }} pathname="/" focused={false} visible
            navigation={navigation}>
            <HomeHubFrame focused={false}>
                <HubWidgetSection instance={{ v: 1, id: 'split-copy', definition: { kind: 'builtin', id: 'count' }, bindings: {} }}
                    frameStyle="plain" menu={null} tracker={tracker} testID="split-card" />
            </HomeHubFrame>
        </DestinationInstanceHost>, { createNodeMock: node => node.props.testID === 'split-card' ? measure(() => 3056 - scrollOffset) : null });
        try {
            const frame = screen.findByTestId('split-card.frame');
            expect(screen.findByTestId('split-card.body')).toBeNull();
            await act(async () => { scrollOffset = 2200; tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: scrollOffset } } } as never); });
            expect(screen.findByTestId('split-card.body')).not.toBeNull();
            expect(screen.findByTestId('split-card.frame')).toBe(frame);
            await act(async () => { scrollOffset = 0; tracker.onScroll({ nativeEvent: { contentOffset: { x: 0, y: scrollOffset } } } as never); });
            expect(screen.findByTestId('split-card.body')).toBeNull();
        } finally { await screen.unmount(); }
    });

    it('keeps its built body while the tab is hidden, so showing the tab again mounts nothing', async () => {
        // The shell hides a retained tab exactly like this: the surface stops presenting and the
        // destination is neither visible nor focused, in one render.
        const navigation = { push: () => {}, replace: () => {}, back: () => {} };
        const tab = (shown: boolean) => <RetainedPanelSurface isActive={shown}>
            <DestinationInstanceHost tabId="home-tab" ref={{ kind: 'sessions', params: {} }} pathname="/" focused={shown} visible={shown}
                navigation={navigation}>
                <HubWidgetSection instance={{ v: 1, id: 'kept-copy', definition: { kind: 'builtin', id: 'count' }, bindings: {} }}
                    frameStyle="plain" menu={null} tracker={null} testID="kept-card" />
            </DestinationInstanceHost>
        </RetainedPanelSurface>;
        const screen = await renderScreen(tab(true));
        const built = () => ({ body: screen.findByTestId('kept-card.body') !== null, deferred: screen.findByTestId('kept-card.deferred') !== null });
        expect(built()).toEqual({ body: true, deferred: false });
        const hidden: ReturnType<typeof built>[] = [];
        for (let cycle = 0; cycle < 3; cycle++) {
            await screen.update(tab(false));
            hidden.push(built());
            await screen.update(tab(true));
        }
        // Torn down while hidden means rebuilt on every show.
        expect(hidden).toEqual(Array(3).fill({ body: true, deferred: false }));
        expect(built()).toEqual({ body: true, deferred: false });
    });

    it('does not measure its place while the tab is hidden, so the shown tab still has the body it showed', async () => {
        type MeasureDone = (x: number, y: number, width: number, height: number) => void;
        const pending: MeasureDone[] = [];
        let shown = true;
        // A hidden (display: none) page has no geometry: its scroll content cannot be measured.
        const contentNode = { measureInWindow: (done: MeasureDone) => done(0, 56, 400, 4000) };
        const tracker = createNearViewportTracker({ quantum: 40, initialViewportHeight: 400, readContentNode: () => shown ? contentNode : null });
        const navigation = { push: () => {}, replace: () => {}, back: () => {} };
        const tab = () => <RetainedPanelSurface isActive={shown}>
            <DestinationInstanceHost tabId="home-tab" ref={{ kind: 'sessions', params: {} }} pathname="/" focused={shown} visible={shown}
                navigation={navigation}>
                <HubWidgetSection instance={{ v: 1, id: 'placed-copy', definition: { kind: 'builtin', id: 'count' }, bindings: {} }}
                    frameStyle="plain" menu={null} tracker={tracker} testID="placed-card" />
            </DestinationInstanceHost>
        </RetainedPanelSurface>;
        const screen = await renderScreen(tab(), { createNodeMock: node => node.props.testID === 'placed-card'
            ? { measureInWindow: (done: MeasureDone) => { pending.push(done); } } : null });
        await act(async () => { for (const done of pending.splice(0)) done(0, 156, 400, 100); });
        const built = () => ({ body: screen.findByTestId('placed-card.body') !== null, deferred: screen.findByTestId('placed-card.deferred') !== null });
        expect(built()).toEqual({ body: true, deferred: false });
        shown = false;
        await screen.update(tab());
        shown = true;
        // Shown again, before any new measurement settles: the place it last had still stands.
        await screen.update(tab());
        expect(built()).toEqual({ body: true, deferred: false });
        await act(async () => { for (const done of pending.splice(0)) done(0, 156, 400, 100); });
        expect(built()).toEqual({ body: true, deferred: false });
    });
});
