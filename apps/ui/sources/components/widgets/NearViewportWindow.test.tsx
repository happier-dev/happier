import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Text } from 'react-native';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(standardCleanup);

const GROUP_ROWS = 40;

/** A page whose viewport holds the first group; every group lays out 1000px tall, one after the other. */
function pageTracker(window: { top: number; bottom: number }) {
    let placed = 0;
    return {
        onScroll: () => {}, onLayout: () => {}, onContentSizeChange: () => {},
        subscribe: () => () => {}, getWindow: () => window,
        measureSpan: async () => ({ top: 1000 * placed++, height: 1000 }),
        invalidateLayout: () => {}, getLayoutRevision: () => 0,
    };
}

describe('NearViewportWindow', () => {
    it('builds the rows of groups near the page viewport and holds the others by height', async () => {
        const { PluginUiScrollActivityProvider } = await import('@happier-dev/plugin-ui/advanced');
        const { NearViewportWindow } = await import('./NearViewportWindow');
        const ids = ['general', 'panes', 'sessions', 'composer', 'transcript'];
        const group = (id: string, pinned = false) => (
            <NearViewportWindow key={id} id={id} testID={`settings-keyboard-group-window-${id}`} pinned={pinned} estimatedTop={1000 * ids.indexOf(id)} estimatedHeight={1000}>
                {Array.from({ length: GROUP_ROWS }, (_, row) => <Text key={row} testID={`row-${id}-${row}`}>{row}</Text>)}
            </NearViewportWindow>
        );
        const render = (pinnedId?: string) => (
            <PluginUiScrollActivityProvider tracker={pageTracker({ top: 0, bottom: 1000 })}>
                {ids.map((id) => group(id, id === pinnedId))}
            </PluginUiScrollActivityProvider>
        );
        const mountedRows = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAll((node) => typeof node.type === 'string'
            && typeof node.props.testID === 'string' && node.props.testID.startsWith('row-')).length;
        const settle = async (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            await act(async () => {});
            await act(async () => {
                for (const shell of screen.findAll((node) => typeof node.type === 'string'
                    && typeof node.props.testID === 'string' && node.props.testID.startsWith('settings-keyboard-group-window-'))) {
                    shell.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 1000 } } });
                }
            });
            await act(async () => {});
        };
        const screen = await renderScreen(render());
        await settle(screen);
        // Groups 0 and 1 touch the viewport; the other three keep only their height.
        expect(mountedRows(screen)).toBe(2 * GROUP_ROWS);
        await act(async () => { screen.update(render('transcript')); });
        await settle(screen);
        // A pinned (expanded or revealed) far group stays built.
        expect(mountedRows(screen)).toBe(3 * GROUP_ROWS);
    });

    it('does not build a far group before its first measurement (no mount-then-unmount on open)', async () => {
        const { PluginUiScrollActivityProvider } = await import('@happier-dev/plugin-ui/advanced');
        const { NearViewportWindow } = await import('./NearViewportWindow');
        const ids = ['general', 'panes', 'sessions', 'composer', 'transcript'];
        // Measurement never resolves: this is the page on its first frames.
        const tracker = { ...pageTracker({ top: 0, bottom: 1000 }), measureSpan: () => new Promise<never>(() => {}) };
        let mounts = 0;
        function Row() { React.useEffect(() => { mounts++; }, []); return null; }
        await renderScreen(
            <PluginUiScrollActivityProvider tracker={tracker}>
                {ids.map((id, index) => (
                    <NearViewportWindow key={id} id={id} testID={`settings-keyboard-group-window-${id}`} pinned={false} estimatedTop={1000 * index} estimatedHeight={1000}>
                        {Array.from({ length: GROUP_ROWS }, (_, row) => <Row key={row} />)}
                    </NearViewportWindow>
                ))}
            </PluginUiScrollActivityProvider>,
        );
        await act(async () => {});
        // Only the groups whose lower-bound start is inside the window (0 and 1000) are built.
        expect(mounts).toBe(2 * GROUP_ROWS);
    });
});

describe('useMeasuredNearViewport', () => {
    it('renders its reader only when near or far flips, not for every re-measured place (Home layout churn)', async () => {
        const { useMeasuredNearViewport } = await import('./nearViewport');
        let top = 0;
        let revision = 0;
        const listeners = new Set<() => void>();
        // The scroll host is the boundary: its layout revision moves and each re-measure finds the row elsewhere.
        const tracker = {
            subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            getWindow: () => ({ top: 0, bottom: 1000 }),
            measureSpan: async () => ({ top, height: 40 }),
            getLayoutRevision: () => revision,
        };
        const relayout = async (nextTop: number) => {
            top = nextTop;
            revision += 1;
            await act(async () => { for (const listener of [...listeners]) listener(); });
            await act(async () => {});
        };
        let renders = 0;
        const seen: boolean[] = [];
        function Reader() {
            renders++;
            const ref = React.useRef(null);
            const { near } = useMeasuredNearViewport(tracker, ref, true, 'row');
            seen.push(near);
            return null;
        }
        await renderScreen(<Reader />);
        await act(async () => {});
        const settled = renders;
        for (let n = 1; n <= 20; n++) await relayout(100 + n * 7);
        console.info('NEAR_VIEWPORT_READER_RENDERS_PER_20_RELAYOUTS', renders - settled);
        expect(renders - settled).toBe(0);
        await relayout(5000);
        expect(seen.at(-1)).toBe(false);
        await relayout(200);
        expect(seen.at(-1)).toBe(true);
    });
});
