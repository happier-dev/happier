import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

const host = vi.hoisted(() => ({ width: 1440, height: 900 }));
const initialStorageState = storage.getState();
function setPanelsEnabled(enabled: boolean) {
    storage.getState().applyLocalSettings({ uiMultiPanePanelsEnabled: enabled }, { persist: false });
}
beforeEach(() => { storage.setState(initialStorageState, true); host.width = 1440; setPanelsEnabled(true); });
afterEach(() => storage.setState(initialStorageState, true));

// Native geometry is the platform boundary; device preferences use the real store.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'android', select: (values: Record<string, unknown>) => values.android ?? values.native ?? values.default },
        View: 'View',
        useWindowDimensions: () => ({ width: host.width, height: host.height }),
    });
});

await import('../AppPaneProvider');
await import('./DetailsPaneHost');

describe('destination details presentation continuity', () => {
    it('preserves an ordinary host hidden main column and action rail without destination-owned content', async () => {
        const { PaneColumnsHost } = await import('../PaneColumnsHost');
        setPanelsEnabled(false);
        const screen = await renderScreen(<PaneColumnsHost
            main={<div />}
            detailsPane={<div />}
            rightPane={<div />}
            mainHidden
            actionRail={React.createElement('StandaloneRail')}
        />);
        expect(screen.findByTestId('multi-pane-details-docked')).not.toBeNull();
        expect(screen.findByTestId('multi-pane-right-docked')).not.toBeNull();
        expect(screen.root.findAllByType('StandaloneRail')).toHaveLength(1);
    });

    it('keeps the same visible draft across native tablet, phone geometry, and disabled side panes', async () => {
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        const { AppPaneProvider } = await import('../AppPaneProvider');
        let mounts = 0;
        function Editor() {
            const [draft, setDraft] = React.useState('');
            React.useEffect(() => { mounts += 1; }, []);
            return React.createElement('DraftEditor', { value: draft, onChangeText: setDraft });
        }
        const tree = () => <AppPaneProvider><DetailsPaneHost
            main={<div />}
            details={{ content: <Editor /> }}
            onCloseDetails={() => {}}
        /></AppPaneProvider>;
        const screen = await renderScreen(tree());
        await act(async () => { screen.root.findByType('DraftEditor').props.onChangeText('Unsubmitted work'); });
        for (const [width, enabled] of [[390, true], [1440, false], [1440, true]] as const) {
            host.width = width;
            await act(async () => { setPanelsEnabled(enabled); });
            await screen.update(tree());
            // Feed the real measured host boundary, as native split-window layout does.
            await act(async () => {
                screen.root.findAllByType('View').find((node) => typeof node.props.onLayout === 'function')!.props.onLayout({ nativeEvent: { layout: { width, height: host.height } } });
            });
            expect(screen.root.findByType('DraftEditor').props.value).toBe('Unsubmitted work');
            expect(mounts).toBe(1);
            if (width === 390 || !enabled) {
                expect(screen.findByTestId('multi-pane-details-modal')?.props.accessibilityViewIsModal).toBe(true);
                expect(screen.root.findAll((node) => node.props.testID === 'multi-pane-details-overlay' && typeof node.props.widthPx === 'number')[0]?.props.widthPx).toBe(width);
                expect(screen.findByTestId('multi-pane-main-underlay')?.props.accessibilityElementsHidden).toBe(true);
            } else {
                expect(screen.findByTestId('multi-pane-details-docked')).not.toBeNull();
            }
        }
    });

    it('heads a details pane retained at full width with Back, and a pane beside the page with Close', async () => {
        const { DetailsPaneHost } = await import('./DetailsPaneHost');
        const { AppPaneProvider } = await import('../AppPaneProvider');
        const closes: string[] = [];
        const tree = () => <AppPaneProvider><DetailsPaneHost
            testID="listing"
            main={<div />}
            details={{ header: { title: 'Theme' }, content: <div /> }}
            onCloseDetails={() => { closes.push('closed'); }}
        /></AppPaneProvider>;
        const screen = await renderScreen(tree());
        for (const [width, enabled] of [[390, true], [1440, false], [1440, true]] as const) {
            host.width = width;
            await act(async () => { setPanelsEnabled(enabled); });
            await screen.update(tree());
            const back = screen.findByTestId('listing.header.back');
            const close = screen.findByTestId('listing.header.close');
            if (width === 390 || !enabled) {
                expect(back, `${width}/${enabled}: the full-width pane leads with Back`).not.toBeNull();
                expect(close, `${width}/${enabled}: no second way out beside Back`).toBeNull();
                await act(async () => { back!.props.onPress(); });
            } else {
                expect(back).toBeNull();
                expect(close).not.toBeNull();
                await act(async () => { close!.props.onPress(); });
            }
        }
        expect(closes, 'Back and Close both close the same detail').toHaveLength(3);
    });

    it('does not admit right or bottom auxiliary content into the destination-only presentation', async () => {
        const { PaneColumnsHost } = await import('../PaneColumnsHost');
        const { useOptionalAppPaneScopeLayout } = await import('../hooks/useAppPaneScopeLayout');
        function LayoutFacts() {
            return React.createElement('LayoutFacts', { layout: useOptionalAppPaneScopeLayout() });
        }
        const mounts = { right: 0, bottom: 0 };
        function Auxiliary(props: Readonly<{ name: 'right' | 'bottom' }>) {
            React.useEffect(() => { mounts[props.name] += 1; }, []);
            return React.createElement('AuxiliaryContent', { name: props.name });
        }
        const tree = () => <PaneColumnsHost
            main={<div />}
            detailsPane={<LayoutFacts />}
            destinationOwnsDetails
            rightPane={<Auxiliary name="right" />}
            bottomPane={<Auxiliary name="bottom" />}
            mainHidden
            actionRail={<div />}
        />;
        const screen = await renderScreen(tree());
        expect(screen.findByTestId('multi-pane-right-docked')).not.toBeNull();
        expect(screen.findByTestId('multi-pane-bottom-dock')).not.toBeNull();
        await act(async () => { setPanelsEnabled(false); });
        await screen.update(tree());
        expect(screen.findByTestId('multi-pane-details-modal')).not.toBeNull();
        expect(screen.root.findAll((node) => node.props.testID === 'multi-pane-details-overlay' && typeof node.props.widthPx === 'number')[0]?.props.widthPx).toBe(1440);
        expect(screen.findByTestId('multi-pane-right-parked')?.props.accessibilityElementsHidden).toBe(true);
        expect(screen.findByTestId('multi-pane-right-modal')).toBeNull();
        expect(screen.findByTestId('multi-pane-bottom-overlay')).toBeNull();
        expect(screen.findByTestId('multi-pane-bottom-parked')?.props.accessibilityElementsHidden).toBe(true);
        expect(mounts).toEqual({ right: 1, bottom: 1 });
        expect(screen.root.findByType('LayoutFacts').props.layout).toMatchObject({
            bottomPresentation: 'hidden',
            mainRegionHeightPx: host.height,
            mainRegionWidthPx: host.width,
        });
    });
});
