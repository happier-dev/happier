import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createRunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import type { TemporaryComputerLaunchController } from '../hooks/useTemporaryComputerLaunch';
import { NewSessionLaunchSurface } from './NewSessionLaunchSurface';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});

/** A temporary-computer launch whose pending activation owns the screen: the surface's real overlay producer. */
function activeTemporaryLaunch() {
    const projection: RunnerActivationProjectionV1 = {
        activationId: '00000000-0000-4000-8000-000000000001',
        homeServerIdentityId: 'srv_runner', creatorAccountId: 'creator', creatorTokenEpoch: 1,
        activationExpiresAt: null, workspace: { kind: 'choose_on_endpoint' },
        sessionId: 'session-1', machineId: 'machine-1', activationSigningPublicKey: 'a'.repeat(43),
        authoringCommitment: 'a'.repeat(43),
        artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
        endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'creator' },
        draftId: 'draft-a', state: 'pending', closeReason: null, progressPhase: null,
        claim: null, endpointFacts: null, review: null, consent: null, readiness: null, materialization: null,
    };
    const client = createRunnerActivationClient(async () => Response.json(projection));
    const controlRef = { current: null as TemporaryComputerLaunchController | null };
    return {
        controlRef,
        launch: {
            input: {
                client, serverId: 'home-a', draftId: 'draft-a', existingPublicRef: null,
                prepareActivation: async () => { throw new Error('Unexpected activation creation'); },
                persistPublicRef: () => undefined,
                onMaterialized: () => undefined,
            },
            controlRef,
            scope: null,
            committedTarget: null,
            homeLabel: 'Home A',
            accountLabel: null,
            exportPackage: async () => undefined,
            onActiveChange: () => undefined,
            onLeave: () => undefined,
        },
    } as const;
}

describe('NewSessionLaunchSurface', () => {
    it('retains an embedded draft while the launch card replaces its footprint without a bounded overlay scroll', async () => {
        let mounts = 0;
        function Authoring() {
            React.useEffect(() => { mounts += 1; }, []);
            return <ViewFixture testID="retained-embedded-authoring" />;
        }
        const { launch } = activeTemporaryLaunch();
        const screen = await renderScreen(<NewSessionLaunchSurface presentation="embedded" temporaryComputerLaunch={launch}>
            <Authoring />
        </NewSessionLaunchSurface>);
        await vi.waitFor(() => expect(screen.findByTestId('temporary-computer-launch-surface')).not.toBeNull());
        expect(mounts).toBe(1);
        expect(screen.findByTestId('new-session-launch-authoring')?.props.inert).toBe(true);
        expect(screen.findByTestId('new-session-launch-overlay-scroll')).toBeNull();
        await screen.unmount();
    });
    it('keeps authoring renders and mounts stable while its launch leaf refreshes progress', async () => {
        let renders = 0;
        let mounts = 0;
        function Authoring() {
            renders += 1;
            React.useEffect(() => { mounts += 1; }, []);
            return <ViewFixture testID="retained-authoring" />;
        }
        const { launch, controlRef } = activeTemporaryLaunch();
        const screen = await renderScreen(<NewSessionLaunchSurface temporaryComputerLaunch={launch}><Authoring /></NewSessionLaunchSurface>);

        await vi.waitFor(() => expect(screen.findByTestId('temporary-computer-launch-surface')).not.toBeNull());
        const beforeRefresh = renders;
        await act(async () => { await controlRef.current?.refresh(); });
        expect(renders).toBe(beforeRefresh);
        expect(mounts).toBe(1);
        expect(screen.findByTestId('new-session-launch-authoring')?.props.inert).toBe(true);
        await screen.unmount();
    });

    it('keeps the mounted authoring tree inert and outside accessibility traversal while launch custody is active', async () => {
        const { launch } = activeTemporaryLaunch();
        const screen = await renderScreen(
            <NewSessionLaunchSurface temporaryComputerLaunch={launch}>
                <ViewFixture testID="authoring-tree" />
            </NewSessionLaunchSurface>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('temporary-computer-launch-surface')).not.toBeNull());

        const authoring = screen.findByTestId('new-session-launch-authoring');
        expect(authoring?.props.pointerEvents).toBe('none');
        expect(authoring?.props['aria-hidden']).toBe(true);
        expect(authoring?.props.inert).toBe(true);
        await screen.unmount();
    });

    it('leaves ordinary authoring interactive when no launch overlay owns the screen', async () => {
        const screen = await renderScreen(
            <NewSessionLaunchSurface>
                <ViewFixture testID="authoring-tree" />
            </NewSessionLaunchSurface>,
        );

        const authoring = screen.findByTestId('new-session-launch-authoring');
        expect(authoring?.props.pointerEvents).toBe('auto');
        expect(authoring?.props['aria-hidden']).not.toBe(true);
        expect(authoring?.props.inert).not.toBe(true);
        expect(screen.findByTestId('new-session-launch-overlay')).toBeNull();
    });
});

function ViewFixture(props: Readonly<{ testID: string }>): React.ReactElement {
    return React.createElement('View', props);
}
