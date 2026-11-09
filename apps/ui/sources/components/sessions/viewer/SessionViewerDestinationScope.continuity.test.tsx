import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { FloatingFrame } from '@happier-dev/plugin-ui/presentation';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { renderScreen } from '@/dev/testkit';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';
import {
    createRetainedPresentationSlotsStore,
    RetainedPresentationSlotsProvider,
    useRetainedPresentationSlotVisible,
} from '@/components/ui/presentation/retainedPresentationSlots';
import {
    isSessionViewerPresenting,
    useOptionalSessionViewerController,
    usePublishSessionViewerPresence,
    usePublishSessionViewerSourceFacts,
    type SessionViewerController,
    type SessionViewerPresence,
} from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import { SessionViewerDestinationScope, useSessionDestinationAccountBinding, useSessionViewerDestinationScope } from './SessionViewerDestinationScope';
import { RetainedSessionViewerSource } from './RetainedSessionViewerSource';
import { SessionViewerHost } from './SessionViewerHost';
import { SessionViewerStickySlot } from './SessionViewerStickySlot';

const presence: SessionViewerPresence = {
    presence: { kind: 'agent', activity: null, target: null, controlEpoch: 1 },
    agent: { name: 'Codex' },
    onTakeControl: () => {},
    onHandBack: () => {},
};

describe('Session viewer destination continuity', () => {
    it('keeps unresolved destination custody distinct from an absent or differently addressed owner', async () => {
        const home = await upsertServerProfileOnly({ serverUrl: 'https://session-destination-authority.test', name: 'Session authority' });
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'session-account' })).toString('base64url')}.signature`,
        });
        const observed: Array<ReturnType<typeof useSessionDestinationAccountBinding>> = [];
        function Probe() {
            const binding = useSessionDestinationAccountBinding('session-a', home.id);
            observed.push(binding);
            return React.createElement('DestinationAuthorityProbe', {
                binding,
                otherSession: useSessionDestinationAccountBinding('session-b', home.id),
                otherHome: useSessionDestinationAccountBinding('session-a', 'other-home'),
            });
        }
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><SessionViewerDestinationScope sessionId="session-a" serverId={home.id}>
            <Probe />
        </SessionViewerDestinationScope></InjectedAuthProvider>);
        try {
            expect(observed[0]).toBeNull();
            const { binding, otherSession, otherHome } = screen.root.findByType('DestinationAuthorityProbe').props;
            expect(binding?.isCurrent()).toBe(true);
            expect(otherSession).toBeUndefined();
            expect(otherHome).toBeUndefined();
            await screen.update(<Probe />);
            expect(screen.root.findByType('DestinationAuthorityProbe').props.binding).toBeUndefined();
            expect(binding.isCurrent()).toBe(false);
        } finally {
            await screen.unmount();
            await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        }
    });

    it('keeps the live source and presence presented through phone-to-1440 shell remounts, restore and close', async () => {
        const home = await upsertServerProfileOnly({ serverUrl: 'https://viewer-continuity.test', name: 'Viewer continuity' });
        // Secure credential storage is the external boundary; real parsing/binding owns the lifetime.
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'viewer-account' })).toString('base64url')}.signature`,
        });
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        const store = createRetainedPresentationSlotsStore();
        const observed: { controller: SessionViewerController | null; mounts: number; bound: boolean } = { controller: null, mounts: 0, bound: false };
        function Source() {
            const [stream] = React.useState(() => { observed.mounts += 1; return {}; });
            usePublishSessionViewerPresence('computer', presence);
            usePublishSessionViewerSourceFacts('computer', { machineName: 'Work computer', personInControl: false, watching: true });
            return React.createElement('StreamBoundary', { stream, active: useRetainedPresentationSlotVisible() });
        }
        function Presentation() {
            const controller = useOptionalSessionViewerController();
            observed.controller = controller;
            const destination = useSessionViewerDestinationScope('session-a', home.id);
            observed.bound = destination !== null;
            return <>
                {isSessionViewerPresenting(controller, 'computer') && destination ? (
                    <RetainedSessionViewerSource sessionId="session-a" slotId="continuity-source" serverId={home.id} accountLifetime={destination.accountLifetime}
                        windowGeometry={{ x: 0, y: 0, width: 800, height: 600 }}>
                        <Source />
                    </RetainedSessionViewerSource>
                ) : null}
                <SessionViewerStickySlot sessionId="session-a" serverId={home.id} />
                <SessionViewerHost sessionId="session-a" serverId={home.id} />
            </>;
        }
        function Tree(props: Readonly<{ width: 390 | 1440 }>) {
            return <InjectedAuthProvider credentials={credentials}><RetainedPresentationSlotsProvider store={store}>
                <SessionViewerDestinationScope sessionId="session-a" serverId={home.id}>
                    <SessionViewerControllerProvider key={props.width} sessionId="session-a" serverId={home.id}
                        phone={props.width === 390} canPresentSource={() => true} openDocked={() => {}}>
                        <Presentation />
                    </SessionViewerControllerProvider>
                </SessionViewerDestinationScope>
            </RetainedPresentationSlotsProvider></InjectedAuthProvider>;
        }
        const screen = await renderScreen(<Tree width={390} />);
        try {
            expect(observed.bound).toBe(true);
            await act(async () => { observed.controller!.port.apply({ kind: 'viewer.open', source: 'computer' }); });
            expect(screen.findByTestId('session-viewer-sticky')).not.toBeNull();
            const stream = screen.root.findByType('StreamBoundary').props.stream;
            await screen.update(<Tree width={1440} />);
            expect(observed.controller!.state.mode).toBe('floating');
            expect(screen.findByTestId('session-viewer-host')).not.toBeNull();
            await act(async () => {
                invokeTestInstanceHandler(screen.findByTestId('session-viewer-host')!, 'onLayout', {
                    nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 900 } },
                });
            });
            expect(screen.root.findByType(FloatingFrame).props.mode).toBe('floating');
            expect(screen.findByTestId('session-viewer-presence')).not.toBeNull();
            expect(screen.root.findByType('StreamBoundary').props).toMatchObject({ stream, active: true });
            expect(observed.mounts).toBe(1);
            expect(observed.controller!.presence.get('computer')).toBe(presence);
            expect(observed.controller!.facts.computer?.machineName).toBe('Work computer');

            await screen.update(<Tree width={390} />);
            await act(async () => { observed.controller!.port.apply({ kind: 'viewer.expand' }); });
            await act(async () => { observed.controller!.port.apply({ kind: 'viewer.restore' }); });
            expect(screen.findByTestId('session-viewer-sticky')).not.toBeNull();
            await screen.update(<Tree width={1440} />);
            expect(screen.findByTestId('session-viewer-host')).not.toBeNull();
            expect(observed.mounts).toBe(1);
            expect(observed.controller!.presence.get('computer')).toBe(presence);

            await act(async () => { observed.controller!.port.apply({ kind: 'viewer.close' }); });
            await screen.update(<Tree width={390} />);
            await screen.update(<Tree width={1440} />);
            expect(screen.findByTestId('session-viewer-host')).toBeNull();
            expect(screen.root.findByType('StreamBoundary').props.active).toBe(false);
        } finally {
            await screen.unmount();
            await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        }
    });
});
