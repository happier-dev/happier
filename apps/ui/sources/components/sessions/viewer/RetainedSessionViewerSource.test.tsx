import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { RetainedPresentationSlotsProvider, createRetainedPresentationSlotsStore, useRetainedPresentationSlotVisible } from '@/components/ui/presentation/retainedPresentationSlots';
import { RetainedSessionViewerSource } from './RetainedSessionViewerSource';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { SessionViewerSourceAccountScopeProvider } from './SessionViewerSourceAccountScope';

describe('retained Session source lifetime', () => {
    it('recreates rather than reuses the old body when another Account rebinds the same source slot', async () => {
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        storage.getState().activateProfileScope({ serverId: 'viewer-home', accountId: 'viewer-account' });
        publishAppliedActiveServerSnapshot({ serverId: 'viewer-home', serverUrl: 'https://viewer.example.test', generation: 1 });
        const store = createRetainedPresentationSlotsStore();
        function SourceBody() {
            const [account] = React.useState(() => storage.getState().profileScope?.accountId);
            return React.createElement('AccountSource', { account });
        }
        function Harness(props: Readonly<{ mount: string }>) {
            const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [props.mount]);
            return <RetainedPresentationSlotsProvider store={store}>
                <RetainedSessionViewerSource slotId="same-source-slot" serverId="viewer-home" accountLifetime={lifetime}>
                    <SourceBody />
                </RetainedSessionViewerSource>
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness mount="account-a" />);
        try {
            expect(screen.root.findByType('AccountSource').props.account).toBe('viewer-account');
            await act(async () => {
                storage.getState().activateProfileScope({ serverId: 'viewer-home', accountId: 'another-account' });
                await screen.update(<Harness mount="account-b" />);
            });
            expect(screen.root.findAllByType('AccountSource')).toHaveLength(1);
            expect(screen.root.findByType('AccountSource').props.account).toBe('another-account');
        } finally {
            await screen.unmount();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot);
            publishAppliedActiveServerRuntimeAvailability(previousAvailable);
        }
    });
    it('withdraws an inline source immediately when the qualified Home retires', async () => {
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        storage.getState().activateProfileScope({ serverId: 'viewer-home', accountId: 'viewer-account' });
        publishAppliedActiveServerSnapshot({ serverId: 'viewer-home', serverUrl: 'https://viewer.example.test', generation: 1 });
        const screen = await renderScreen(<RetainedSessionViewerSource slotId="inline-source" serverId="viewer-home" accountLifetime={captureActiveServerAccountScopeLifetime()}>
            {React.createElement('InlineSourceDemand')}
        </RetainedSessionViewerSource>);
        try {
            expect(screen.root.findAllByType('InlineSourceDemand')).toHaveLength(1);
            await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
            expect(screen.root.findAllByType('InlineSourceDemand')).toHaveLength(0);
        } finally {
            await screen.unmount();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot);
            publishAppliedActiveServerRuntimeAvailability(previousAvailable);
        }
    });
    it.each(['runtime', 'account'] as const)('does not rehome a still-mounted source after its %s binding retires', async (boundary) => {
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        storage.getState().activateProfileScope({ serverId: 'viewer-home', accountId: 'viewer-account' });
        publishAppliedActiveServerSnapshot({ serverId: 'viewer-home', serverUrl: 'https://viewer.example.test', generation: 1 });
        const store = createRetainedPresentationSlotsStore();
        const lifetime = captureActiveServerAccountScopeLifetime();
        function Harness() {
            return <RetainedPresentationSlotsProvider store={store}>
                <RetainedSessionViewerSource slotId="viewer-home:session-a:computer" serverId="viewer-home" accountLifetime={lifetime}>
                    {React.createElement('BoundSourceDemand')}
                </RetainedSessionViewerSource>
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness />);
        try {
            expect(screen.root.findAllByType('BoundSourceDemand')).toHaveLength(1);
            await act(async () => {
                if (boundary === 'runtime') publishAppliedActiveServerRuntimeAvailability(false);
                else storage.getState().activateProfileScope({ serverId: 'viewer-home', accountId: 'another-account' });
            });
            await screen.update(<Harness />);
            expect(screen.root.findAllByType('BoundSourceDemand')).toHaveLength(0);
            expect(store.getPortalSnapshot()).toEqual([]);
        } finally {
            await screen.unmount();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot);
            publishAppliedActiveServerRuntimeAvailability(previousAvailable);
        }
    });
    it.each(['runtime', 'account'] as const)('parks demand, retains one body across shells, and retires it on the real %s boundary', async (boundary) => {
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        storage.getState().activateProfileScope({ serverId: 'viewer-home', accountId: 'viewer-account' });
        publishAppliedActiveServerSnapshot({ serverId: 'viewer-home', serverUrl: 'https://viewer.example.test', generation: 1 });
        const store = createRetainedPresentationSlotsStore();
        const lifetime = captureActiveServerAccountScopeLifetime();
        let mounts = 0;
        function SourceBody() {
            React.useEffect(() => { mounts += 1; }, []);
            return React.createElement('SourceDemand', { active: useRetainedPresentationSlotVisible() });
        }
        function Harness(props: Readonly<{ shell: 'pane' | 'floating' | 'closed' }>) {
            return <RetainedPresentationSlotsProvider store={store}>
                {props.shell !== 'closed' ? <RetainedSessionViewerSource key={props.shell} slotId="viewer-home:session-a:computer" serverId="viewer-home" accountLifetime={lifetime}>
                    <SourceBody />
                </RetainedSessionViewerSource> : null}
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness shell="pane" />);
        try {
            await screen.update(<Harness shell="floating" />);
            expect(mounts).toBe(1);
            await screen.update(<Harness shell="closed" />);
            expect(screen.root.findByType('SourceDemand').props.active).toBe(false);
            await act(async () => {
                if (boundary === 'runtime') publishAppliedActiveServerRuntimeAvailability(false);
                else storage.getState().activateProfileScope({ serverId: 'viewer-home', accountId: 'another-account' });
            });
            expect(store.getPortalSnapshot()).toEqual([]);
            expect(screen.root.findAllByType('SourceDemand')).toEqual([]);
        } finally {
            await screen.unmount();
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot);
            publishAppliedActiveServerRuntimeAvailability(previousAvailable);
        }
    });
    it('retains a nonfocused Home source with its admitted credential lifetime and retires only that Home', async () => {
        const previousScope = storage.getState().profileScope;
        const previousProfile = storage.getState().profile;
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const homeA = await upsertServerProfileOnly({ serverUrl: 'https://viewer-home-a.example.test', name: 'Viewer Home A' });
        const homeB = await upsertServerProfileOnly({ serverUrl: 'https://viewer-home-b.example.test', name: 'Viewer Home B' });
        storage.getState().activateProfileScope({ serverId: homeA.id, accountId: 'viewer-account-a' });
        publishAppliedActiveServerSnapshot({ serverId: homeA.id, serverUrl: homeA.serverUrl, generation: 1 });
        const homeALifetime = captureActiveServerAccountScopeLifetime();
        expect(homeALifetime?.scope.accountId).toBe('viewer-account-a');
        // The canonical Vitest setup replaces only MMKV/browser storage/native SecureStore.
        // Credential parsing, mutation fanout, exact-Home binding and retirement remain real.
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'viewer-account-b' })).toString('base64url')}.signature` };
        expect(await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, credentials)).toBe(true);
        const store = createRetainedPresentationSlotsStore();
        function SourceBody(props: Readonly<{ home: string }>) {
            return React.createElement('HomeSourceDemand', { home: props.home, active: useRetainedPresentationSlotVisible() });
        }
        function Harness(props: Readonly<{ showPane: boolean; nullableHome?: boolean }>) {
            // This incumbent Home authority stays mounted while its presentation binder disappears.
            const { binding } = useServerCredentialAccountScopeBinding(homeB.id);
            return <RetainedPresentationSlotsProvider store={store}>
                {React.createElement('HomeBindingProbe', { account: binding?.scope.accountId ?? null })}
                <RetainedSessionViewerSource slotId="home-a-source" serverId={homeA.id} accountLifetime={homeALifetime}>
                    <SourceBody home={homeA.id} />
                </RetainedSessionViewerSource>
                <SessionViewerSourceAccountScopeProvider accountLifetime={binding}>
                    {props.showPane && binding ? <RetainedSessionViewerSource
                        slotId="home-b-source" serverId={props.nullableHome ? null : homeB.id}
                    >
                        <SourceBody home={homeB.id} />
                    </RetainedSessionViewerSource> : null}
                </SessionViewerSourceAccountScopeProvider>
            </RetainedPresentationSlotsProvider>;
        }
        const screen = await renderScreen(<Harness showPane />);
        try {
            await vi.waitFor(() => expect(screen.root.findByType('HomeBindingProbe').props.account).toBe('viewer-account-b'));
            expect(screen.root.findAllByType('HomeSourceDemand').map((node) => node.props.home)).toEqual([homeA.id, homeB.id]);
            await screen.update(<Harness showPane={false} />);
            expect(screen.root.findAllByType('HomeSourceDemand').find((node) => node.props.home === homeB.id)?.props.active).toBe(false);
            await screen.update(<Harness showPane nullableHome />);
            expect(screen.root.findAllByType('HomeSourceDemand').map((node) => node.props.home)).toEqual([homeA.id, homeB.id]);
            expect(screen.root.findAllByType('HomeSourceDemand').find((node) => node.props.home === homeB.id)?.props.active).toBe(true);
            await screen.update(<Harness showPane={false} nullableHome />);
            await act(async () => {
                expect(await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toBe(true);
            });
            expect(store.getPortalSnapshot().map((entry) => entry.slotId)).toEqual(['home-a-source']);
            expect(screen.root.findAllByType('HomeSourceDemand').map((node) => node.props.home)).toEqual([homeA.id]);
            expect(storage.getState().profileScope?.accountId).toBe('viewer-account-a');
        } finally {
            await screen.unmount();
            await TokenStorage.removeCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id });
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState({ profileScope: previousScope, profile: previousProfile });
            publishAppliedActiveServerSnapshot(previousSnapshot);
            publishAppliedActiveServerRuntimeAvailability(previousAvailable);
        }
    });
});
