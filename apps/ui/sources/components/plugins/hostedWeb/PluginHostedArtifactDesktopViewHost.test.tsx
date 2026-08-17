import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

const invokeTauri = vi.hoisted(() => vi.fn());
const listenTauriEvent = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/tauri', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/tauri')>('@/utils/platform/tauri');
    return {
        ...actual,
        invokeTauri: (command: string, args?: Record<string, unknown>) => invokeTauri(command, args),
        listenTauriEvent: (event: string, handler: (payload: unknown) => void) => listenTauriEvent(event, handler),
    };
});

const frameOrigin = `happier-hosted-artifact://hpa_${'a'.repeat(64)}`;

function bootstrapMessage() {
    return {
        version: 1,
        direction: 'hostToFrame',
        pluginId: 'acme.preview',
        contributionId: 'preview-web',
        surfaceId: 'preview-surface',
        sessionId: 'session-1',
        nonce: 'nonce-1',
        sequence: 1,
        origin: frameOrigin,
        kind: 'bootstrap',
        payload: {
            apiVersion: '1.0.0',
            wireVersion: 1,
            identity: {
                pluginId: 'acme.preview',
                pluginVersion: '1.2.3',
                viewId: 'preview',
                generation: '7',
                sessionId: 'session-1',
            },
        },
    } as const;
}

function readyMessage() {
    return {
        version: 1,
        pluginId: 'acme.preview',
        contributionId: 'preview-web',
        surfaceId: 'preview-surface',
        nonce: 'nonce-1',
        sequence: 1,
        kind: 'ready',
        payload: null,
    } as const;
}

function readyResponse() {
    return {
        version: 1,
        pluginId: 'acme.preview',
        contributionId: 'preview-web',
        surfaceId: 'preview-surface',
        sessionId: 'session-1',
        nonce: 'nonce-1',
        sequence: 2,
        requestSequence: 1,
        kind: 'ack',
        payload: null,
    } as const;
}

describe('PluginHostedArtifactDesktopViewHost', () => {
    afterEach(() => {
        invokeTauri.mockReset();
        listenTauriEvent.mockReset();
    });

    it('opens one token-bound child and relays only strict host and exact-frame bridge messages', async () => {
        let nativeEventHandler: ((payload: unknown) => void) | undefined;
        let sendHostMessage: ((message: unknown) => void) | undefined;
        const onMessage = vi.fn(() => readyResponse());
        const unlisten = vi.fn();
        listenTauriEvent.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
            expect(event).toBe('desktop-hosted-artifact-event');
            nativeEventHandler = handler;
            return unlisten;
        });
        invokeTauri.mockImplementation(async (command: string) => {
            if (command === 'desktop_hosted_artifact_open_view') return { kind: 'opened' };
            return { kind: 'ok' };
        });

        const { PluginHostedArtifactDesktopViewHost } = await import('./PluginHostedArtifactDesktopViewHost');
        const { tree } = await renderScreen(<PluginHostedArtifactDesktopViewHost
            artifact={{
                artifactHandleToken: 'hpat_test_token',
                initialPathAndQuery: '/?happierBridgeNonce=nonce-1',
            }}
            bridge={{
                expectedOrigin: frameOrigin,
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'preview-web',
                expectedSurfaceId: 'preview-surface',
                expectedNonce: 'nonce-1',
                expectedSessionId: 'session-1',
                allowedMessageKinds: new Set(['ready']),
                attachHostMessages: (send) => {
                    sendHostMessage = send;
                    return () => {};
                },
                onMessage,
            }}
            testID="plugin-hosted-web-frame"
        />);

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const openCall = invokeTauri.mock.calls.find(([command]) => command === 'desktop_hosted_artifact_open_view');
        expect(openCall).toMatchObject([
            'desktop_hosted_artifact_open_view',
            {
                request: {
                    viewId: expect.stringMatching(/^hpa_view_[a-f0-9]{32}$/),
                    token: 'hpat_test_token',
                    initialPathAndQuery: '/?happierBridgeNonce=nonce-1',
                },
            },
        ]);
        const viewId = (openCall?.[1] as { request: { viewId: string } }).request.viewId;

        sendHostMessage?.(bootstrapMessage());
        sendHostMessage?.({ kind: 'bootstrap', unexpected: true });
        await act(async () => {
            await Promise.resolve();
        });
        expect(invokeTauri).toHaveBeenCalledWith('desktop_hosted_artifact_post_message', {
            request: {
                viewId,
                token: 'hpat_test_token',
                message: bootstrapMessage(),
            },
        });

        nativeEventHandler?.({
            viewId,
            kind: 'message',
            message: JSON.stringify(readyMessage()),
        });
        nativeEventHandler?.({
            viewId: 'hpa_view_other',
            kind: 'message',
            message: JSON.stringify(readyMessage()),
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
        expect(invokeTauri).toHaveBeenCalledWith('desktop_hosted_artifact_post_message', {
            request: {
                viewId,
                token: 'hpat_test_token',
                message: readyResponse(),
            },
        });

        await act(async () => {
            tree.unmount();
        });
        expect(unlisten).toHaveBeenCalledTimes(1);
        expect(invokeTauri).toHaveBeenCalledWith('desktop_hosted_artifact_close_view', {
            request: {
                viewId,
                token: 'hpat_test_token',
            },
        });
    });

    it('flushes strict host envelopes emitted by an early ready only after the child acknowledges open', async () => {
        let nativeEventHandler: ((payload: unknown) => void) | undefined;
        let sendHostMessage: ((message: unknown) => void) | undefined;
        let acknowledgeOpen: ((result: unknown) => void) | undefined;
        listenTauriEvent.mockImplementation(async (_event: string, handler: (payload: unknown) => void) => {
            nativeEventHandler = handler;
            return () => {};
        });
        invokeTauri.mockImplementation((command: string) => {
            if (command === 'desktop_hosted_artifact_open_view') {
                return new Promise((resolve) => {
                    acknowledgeOpen = resolve;
                });
            }
            return Promise.resolve({ kind: 'ok' });
        });
        const onMessage = vi.fn(() => {
            sendHostMessage?.(bootstrapMessage());
            return readyResponse();
        });

        const { PluginHostedArtifactDesktopViewHost } = await import('./PluginHostedArtifactDesktopViewHost');
        const { tree } = await renderScreen(<PluginHostedArtifactDesktopViewHost
            artifact={{
                artifactHandleToken: 'hpat_test_token',
                initialPathAndQuery: '/?happierBridgeNonce=nonce-1',
            }}
            bridge={{
                expectedOrigin: frameOrigin,
                expectedPluginId: 'acme.preview',
                expectedContributionId: 'preview-web',
                expectedSurfaceId: 'preview-surface',
                expectedNonce: 'nonce-1',
                expectedSessionId: 'session-1',
                allowedMessageKinds: new Set(['ready']),
                attachHostMessages: (send) => {
                    sendHostMessage = send;
                    return () => {};
                },
                onMessage,
            }}
            testID="plugin-hosted-web-frame"
        />);

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        const openCall = invokeTauri.mock.calls.find(([command]) => command === 'desktop_hosted_artifact_open_view');
        const viewId = (openCall?.[1] as { request: { viewId: string } }).request.viewId;

        nativeEventHandler?.({
            viewId,
            kind: 'message',
            message: JSON.stringify(readyMessage()),
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(invokeTauri.mock.calls.filter(([command]) => command === 'desktop_hosted_artifact_post_message'))
            .toHaveLength(0);

        await act(async () => {
            acknowledgeOpen?.({ kind: 'opened' });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(invokeTauri).toHaveBeenCalledWith('desktop_hosted_artifact_post_message', {
            request: {
                viewId,
                token: 'hpat_test_token',
                message: bootstrapMessage(),
            },
        });
        expect(invokeTauri).toHaveBeenCalledWith('desktop_hosted_artifact_post_message', {
            request: {
                viewId,
                token: 'hpat_test_token',
                message: readyResponse(),
            },
        });

        await act(async () => {
            tree.unmount();
        });
    });

    it('closes the exact child when it acknowledges after the Artifact host has unmounted', async () => {
        let acknowledgeOpen: ((result: unknown) => void) | undefined;
        const unlisten = vi.fn();
        listenTauriEvent.mockResolvedValue(unlisten);
        invokeTauri.mockImplementation((command: string) => {
            if (command === 'desktop_hosted_artifact_open_view') {
                return new Promise((resolve) => {
                    acknowledgeOpen = resolve;
                });
            }
            return Promise.resolve({ kind: 'ok' });
        });

        const { PluginHostedArtifactDesktopViewHost } = await import('./PluginHostedArtifactDesktopViewHost');
        const { tree } = await renderScreen(<PluginHostedArtifactDesktopViewHost
            artifact={{
                artifactHandleToken: 'hpat_test_token',
                initialPathAndQuery: '/?happierBridgeNonce=nonce-1',
            }}
            testID="plugin-hosted-web-frame"
        />);

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        const openCall = invokeTauri.mock.calls.find(([command]) => command === 'desktop_hosted_artifact_open_view');
        const viewId = (openCall?.[1] as { request: { viewId: string } }).request.viewId;

        await act(async () => {
            tree.unmount();
        });
        expect(unlisten).toHaveBeenCalledTimes(1);
        expect(invokeTauri.mock.calls.filter(([command]) => command === 'desktop_hosted_artifact_close_view'))
            .toHaveLength(0);

        await act(async () => {
            acknowledgeOpen?.({ kind: 'opened' });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(invokeTauri).toHaveBeenCalledWith('desktop_hosted_artifact_close_view', {
            request: {
                viewId,
                token: 'hpat_test_token',
            },
        });
    });

    it('forwards factual desktop history and executes a host-owned go-back command', async () => {
        let nativeEventHandler: ((payload: unknown) => void) | undefined;
        const onNativeArtifactHistoryStateChange = vi.fn();
        const onNativeArtifactGoBackResult = vi.fn();
        listenTauriEvent.mockImplementation(async (_event: string, handler: (payload: unknown) => void) => {
            nativeEventHandler = handler;
            return () => {};
        });
        invokeTauri.mockImplementation(async (command: string) => {
            if (command === 'desktop_hosted_artifact_open_view') return { kind: 'opened' };
            if (command === 'desktop_hosted_artifact_go_back') return { kind: 'handled', handled: true };
            return { kind: 'ok' };
        });

        const { PluginHostedArtifactDesktopViewHost } = await import('./PluginHostedArtifactDesktopViewHost');
        const { tree } = await renderScreen(<PluginHostedArtifactDesktopViewHost
            artifact={{
                artifactHandleToken: 'hpat_test_token',
                initialPathAndQuery: '/',
            }}
            navigationCommand={{ commandId: 'desktop-history-back-1', kind: 'goBack' }}
            onNativeArtifactHistoryStateChange={onNativeArtifactHistoryStateChange}
            onNativeArtifactGoBackResult={onNativeArtifactGoBackResult}
            testID="plugin-hosted-web-frame"
        />);

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        const openCall = invokeTauri.mock.calls.find(([command]) => command === 'desktop_hosted_artifact_open_view');
        const viewId = (openCall?.[1] as { request: { viewId: string } }).request.viewId;

        await act(async () => {
            nativeEventHandler?.({ viewId, kind: 'historyState', canGoBack: true });
            await Promise.resolve();
        });

        expect(onNativeArtifactHistoryStateChange).toHaveBeenCalledExactlyOnceWith(true);
        expect(invokeTauri).toHaveBeenCalledWith('desktop_hosted_artifact_go_back', {
            request: {
                viewId,
                token: 'hpat_test_token',
            },
        });
        expect(onNativeArtifactGoBackResult).toHaveBeenCalledExactlyOnceWith(true);

        await act(async () => {
            tree.unmount();
        });
    });
});
