import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import type { SystemTasksBridge } from '@/components/systemTasks/types';
import { t } from '@/text';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { DirectHomePathPane } from './DirectHomePathPane';
import { JourneyPanePresentationContext } from './journeyPaneKit';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
const os = vi.hoisted(() => ({ bridge: null as SystemTasksBridge | null }));
installTokenStorageWebPlatformMocks();
// Only the desktop OS bridge is simulated. The task runner, progress subscription and retry owner are real.
vi.mock('@/components/systemTasks/createTauriSystemTaskBridge', () => ({
    createTauriSystemTaskBridge: () => os.bridge,
}));

describe('Direct Home address outcome', () => {
    beforeEach(() => setRuntimeFetch(network.fetch));

    afterEach(() => {
        network.fetch.mockReset();
        os.bridge = null;
        vi.unstubAllGlobals();
    });

    it('offers Tailscale repair on desktop, retries after the real task runner succeeds, and shows task failure inline', async () => {
        const manual = createManualSystemTaskRunner('tauri');
        os.bridge = manual.bridge;
        vi.stubGlobal('isTauri', true);
        vi.stubGlobal('location', { protocol: 'https:' });
        network.fetch.mockImplementation(async () => new Response('{}', { status: 404 }));
        const screen = await renderScreen(
            <DirectHomePathPane
                initialAddress="https://home.tailnet.ts.net"
                onHomeConnected={() => {}}
                onLeave={() => {}}
            />,
        );

        await screen.pressByTestIdAsync('already-use-happier.home-connect');
        await vi.waitFor(() => expect(screen.findByTestId('server-settings-add-remediation-action-prepare_tailscale')).not.toBeNull());
        await screen.pressByTestIdAsync('server-settings-add-remediation-action-prepare_tailscale');
        await vi.waitFor(() => expect(manual.bridge.subscribe).toHaveBeenCalled());
        await act(async () => {
            manual.emitResult('personal-home-task-1', {
                protocolVersion: 1,
                taskId: 'personal-home-task-1',
                ok: true,
                data: {},
            });
        });
        await vi.waitFor(() => expect(network.fetch.mock.calls.filter(([url]) => String(url).endsWith('/health'))).toHaveLength(2));

        await screen.pressByTestIdAsync('server-settings-add-remediation-action-prepare_tailscale');
        await vi.waitFor(() => expect(manual.bridge.start).toHaveBeenCalledTimes(2));
        await act(async () => {
            manual.emitResult('personal-home-task-2', {
                protocolVersion: 1,
                taskId: 'personal-home-task-2',
                ok: false,
                error: { code: 'TEST_FAILURE', message: 'Tailscale sign-in was declined' },
            });
        });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Tailscale sign-in was declined'));
        await screen.unmount();
    });

    it('explains browser mixed content instead of treating the Home as unreachable', async () => {
        vi.stubGlobal('location', { protocol: 'https:' });
        const onHomeConnected = vi.fn();
        const screen = await renderScreen(
            <DirectHomePathPane
                initialAddress="http://localhost:4610"
                onHomeConnected={onHomeConnected}
                onLeave={() => {}}
            />,
        );

        await screen.pressByTestIdAsync('already-use-happier.home-connect');
        await vi.waitFor(() => {
            expect(screen.findByTestId('already-use-happier.home-address-error')).not.toBeNull();
            expect(screen.getTextContent()).toContain(t('homeAdd.mixedContent'));
        });
        expect(onHomeConnected).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('connects a Directory-capable Home with disabled sign-in delegation', async () => {
        vi.stubGlobal('location', { protocol: 'https:' });
        const base = createRootLayoutFeaturesResponse();
        const features = createRootLayoutFeaturesResponse({
            signInService: { v: 1, mode: 'disabled' },
            accountServicePresentation: { v: 1, displayName: 'Example Accounts' },
            capabilities: {
                server: { canonicalServerUrl: 'https://accounts.example.test' },
                serverIdentity: { serverIdentityId: 'srv_accounts' },
                accountDirectory: {
                    version: 1,
                    homeDirectory: true,
                    homeEnrollment: true,
                    homeLoginAssertion: {
                        keyId: 'a'.repeat(64),
                        publicKeyBase64Url: 'A'.repeat(43),
                    },
                },
                auth: {
                    ...base.capabilities.auth,
                    methods: [{ id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }],
                    keyChallenge: { v2: true },
                },
            },
        });
        network.fetch.mockImplementation(async (url: RequestInfo | URL) => {
            const path = String(url);
            if (path.endsWith('/health')) return new Response('{}', { status: 200 });
            if (path.endsWith('/v1/features')) return new Response(JSON.stringify(features), { status: 200, headers: { 'content-type': 'application/json' } });
            if (path.endsWith('/v1/auth/entry')) return new Response('{}', { status: 404 });
            throw new Error(`Unexpected request: ${path}`);
        });
        const onHomeConnected = vi.fn();
        const screen = await renderScreen(
            <DirectHomePathPane
                initialAddress="https://accounts.example.test"
                onHomeConnected={onHomeConnected}
                onLeave={() => {}}
            />,
        );

        await screen.pressByTestIdAsync('already-use-happier.home-connect');
        await vi.waitFor(() => expect(onHomeConnected).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://accounts.example.test' })));
        await screen.unmount();
    });

    it('draws the address input at the lab step size', async () => {
        const screen = await renderScreen(
            <JourneyPanePresentationContext.Provider value="step">
                <DirectHomePathPane initialAddress="" onHomeConnected={() => {}} onLeave={() => {}} />
            </JourneyPanePresentationContext.Provider>,
        );

        try {
            const style = flattenTestStyle(screen.findByTestId('already-use-happier.home-address')!.props.style);
            expect(style.minHeight).toBe(46);
            expect(style.fontSize).toBeGreaterThanOrEqual(14);
        } finally {
            await screen.unmount();
        }
    });
});
