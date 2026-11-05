import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { selectedPaneDestinationTabKey } from './model/selectedPaneDestination';

installDisconnectedServerSocketBoundary();
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
afterEach(standardCleanup);

describe('selected slot rendering', () => {
    it('mounts only the real selected body and hides the placed source body', async () => {
        let context!: ReturnType<typeof useAppPaneContext>;
        const mounts = { main: 0, right: 0, bottom: 0 };
        function Body({ slot }: { slot: keyof typeof mounts }) { React.useEffect(() => { mounts[slot]++; }, [slot]); return <div data-slot={slot} />; }
        function Control() { context = useAppPaneContext(); return null; }
        const right = { destinationIds: ['files'], render: () => <Body slot="right" /> };
        const bottom = { destinationIds: ['terminal'], render: () => <Body slot="bottom" /> };
        const screen = await renderScreen(<AppPaneProvider><Control /><AppPaneScopeHost scopeId="app"
            selectedPaneTabKey={selectedPaneDestinationTabKey('bottom')}
            main={<Body slot="main" />} rightPaneBuiltinAdapter={right} bottomPaneBuiltinAdapter={bottom} /></AppPaneProvider>);
        await act(async () => {
            context.dispatch({ type: 'openRight', scopeId: 'app', tabId: 'files' });
            context.dispatch({ type: 'openBottom', scopeId: 'app', tabId: 'terminal' });
        });
        expect(mounts).toEqual({ main: 0, right: 0, bottom: 1 });
        await screen.update(<AppPaneProvider><Control /><AppPaneScopeHost scopeId="app"
            main={<Body slot="main" />} rightPaneBuiltinAdapter={right} bottomPaneBuiltinAdapter={bottom} /></AppPaneProvider>);
        await act(async () => context.dispatch({ type: 'setSelectedPanePresentation', scopeId: 'app',
            tabKey: selectedPaneDestinationTabKey('bottom'), presentation: { windowId: 'w' } }));
        expect(screen.root.findAllByProps({ 'data-slot': 'bottom' })).toHaveLength(0);
    });
});
