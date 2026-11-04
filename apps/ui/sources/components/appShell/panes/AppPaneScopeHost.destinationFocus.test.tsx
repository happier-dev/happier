import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { installAppPaneScopeHostCommonModuleMocks } from './appPaneScopeHostTestHelpers';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installAppPaneScopeHostCommonModuleMocks();
installDisconnectedServerSocketBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { AppPaneProvider, useAppPaneContext } = await import('./AppPaneProvider');
const { AppPaneScopeHost } = await import('./AppPaneScopeHost');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { useRouter } = await import('expo-router');

function Probe() {
    const { state } = useAppPaneContext();
    return React.createElement('ActiveScopeProbe', { scopeId: state.activeScopeId });
}

function Harness(props: Readonly<{ focused: string }>) {
    const navigation = useRouter();
    return <InjectedAuthProvider credentials={null}><AppPaneProvider><Probe />{['a', 'b'].map((id) => <DestinationInstanceHost key={id}
        tabId={id} ref={{ kind: 'session', params: { id, serverId: 'home-a' } }}
        pathname={`/session/${id}`} navigation={navigation} focused={props.focused === id} visible>
        <AppPaneScopeHost scopeId={`scope:${id}`} main={<div />} />
    </DestinationInstanceHost>)}</AppPaneProvider></InjectedAuthProvider>;
}

describe('AppPaneScopeHost destination focus', () => {
    it('gives the workspace focused pane keyboard ownership irrespective of sibling mount order', async () => {
        const screen = await renderScreen(<Harness focused="a" />);
        expect(screen.root.findByType('ActiveScopeProbe').props.scopeId).toBe('scope:a');
        await act(async () => { screen.tree.update(<Harness focused="b" />); });
        expect(screen.root.findByType('ActiveScopeProbe').props.scopeId).toBe('scope:b');
        await act(async () => { screen.tree.update(<Harness focused="a" />); });
        expect(screen.root.findByType('ActiveScopeProbe').props.scopeId).toBe('scope:a');
    });
});
