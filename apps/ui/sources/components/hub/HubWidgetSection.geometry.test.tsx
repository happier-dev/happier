import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createNearViewportTracker } from '@/components/widgets/nearViewport';
import { HubWidgetSection } from './HubWidgetSection';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/' }).module);
vi.mock('@/sync/domains/state/storage', async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({}));
vi.mock('@/sync/store/hooks', async () => await import('@/sync/domains/state/storage'));
// The daemon projection is outside this native geometry corridor; no installed renderer is needed.
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({ pluginUiProjection: null }), useProjectedPluginLocalizedTextResolver: () => undefined,
}));
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
            createNodeMock: node => React.isValidElement<{ testID?: string }>(node) && node.props.testID === 'nested-card' ? measure(() => 3056 - scrollOffset) : null,
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
            createNodeMock: node => React.isValidElement<{ testID?: string }>(node) && node.props.testID === 'moving-card' ? measure(() => contentTop + 56) : null,
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
        const screen = await renderScreen(render('old'), { createNodeMock: node => React.isValidElement<{ testID?: string }>(node) && node.props.testID === 'pending-card'
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
