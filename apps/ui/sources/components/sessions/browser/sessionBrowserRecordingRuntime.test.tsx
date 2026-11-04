import 'fake-indexeddb/auto';
import type {
    BrowserRecordingCapabilities,
    BrowserRecordingSessionV1,
} from '@happier-dev/protocol';
import { browserViewKey } from '@happier-dev/protocol';
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { act, createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { BrowserRecordingStartControlRequest } from '@/components/browser/recording';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { resetMmkvStoresForTests } from '@/dev/reactNativeMmkvStub';

const machineRpcMock = vi.hoisted(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
}));
const nativeCaptureDisposers: Array<() => void> = [];
const modalSpies = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true, renderCustomModals: true, spies: { alert: modalSpies.alert } }).module;
});

// Only the network boundaries are replaced. Both the legacy RPC (RED) and admitted
// Action requests receive the same daemon outcomes, with real policy and codecs.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async ({ method, payload, machineId, serverId, signal }) => {
        const operation = method === RPC_METHODS.DAEMON_BROWSER_RECORDING_START ? 'start'
            : method === RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP ? 'stop' : 'cancel';
        if (!payload || typeof payload !== 'object') throw new Error('Missing recording RPC input');
        const response = await machineRpcMock[operation]({ machineId, serverId, signal,
            ...('input' in payload ? { input: payload.input } : payload) });
        if (!response?.ok) throw new Error('Recording transport unavailable');
        return { protocolVersion: 1, result: response.result };
    });
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const initialStorage = storage.getState();
let homeId: string;

const recordingCapabilities = {
    enabled: true,
    attachmentsEnabled: true,
    available: true,
    supportedCaptureKinds: ['nativeViewCapture'],
    supportedMimeTypes: ['image/png'],
    supportedAdapterKinds: ['externalUrl'],
    maxFps: 12,
    audioSupported: false,
    cursorOverlaySupported: true,
    actionTimelineChaptersSupported: true,
    supportedRetentionClasses: ['preSend', 'attached'],
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

const streamRecordingCapabilities = {
    ...recordingCapabilities,
    supportedCaptureKinds: ['streamFrameCapture'],
    supportedMimeTypes: ['video/webm'],
    supportedAdapterKinds: ['localPreview'],
} satisfies BrowserRecordingCapabilities;

const nativeRecordingRequest = {
    browserSessionId: 'browser_session_1', viewId: 'view_1', profileId: 'profile_1',
    target: { kind: 'externalUrl', targetId: 'external_1', url: 'https://example.com/' },
    targetKind: 'externalUrl', adapterKind: 'externalUrl', renderEngineKind: 'desktopWebView',
    captureKind: 'nativeViewCapture', fidelity: 'nativeCallback', navigationGeneration: 2,
    mimeType: 'image/png', retentionClass: 'preSend', policyState: 'allowed',
} satisfies BrowserRecordingStartControlRequest;

function recording(overrides: Partial<BrowserRecordingSessionV1> = {}): BrowserRecordingSessionV1 {
    return {
        v: 1,
        recordingId: 'recording_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        profileId: 'profile_1',
        targetKind: 'externalUrl',
        adapterKind: 'externalUrl',
        renderEngineKind: 'desktopWebView',
        captureKind: 'nativeViewCapture',
        fidelity: 'nativeCallback',
        startedAtMs: 10_000,
        status: 'recording',
        navigationGenerationStart: 2,
        durationMs: 0,
        byteSize: 0,
        frameCount: 0,
        fps: 12,
        mimeType: 'image/png',
        retentionClass: 'preSend',
        redactionLevel: 'metadataOnly',
        policyState: 'allowed',
        actionChapters: [],
        relatedReferences: [],
        ...overrides,
    };
}

async function registerNativeCaptureHandler(machineId = 'machine_1'): Promise<void> {
    const { registerDesktopBrowserRecordingReverseCaptureHandler } = await import(
        '@/sync/domains/browser/recording/reverseCaptureAvailability'
    );
    nativeCaptureDisposers.push(registerDesktopBrowserRecordingReverseCaptureHandler(machineId));
}

async function renderRecordingScreen(element: React.ReactElement) {
    const screen = await renderScreen(element);
    await waitForHomeGovernance(() => expect(screen.findByTestId('start-recording')?.props.disabled).toBe(false));
    return screen;
}

describe('session browser recording runtime', () => {
    beforeEach(async () => {
        await homes.reset();
        resetMmkvStoresForTests();
        storage.setState(initialStorage, true);
        await loadSyncSingletonForTests();
        homeId = await homes.addHome({ name: 'Recording Home', serverUrl: 'https://recording.test',
            serverIdentityId: 'srv_recording', accountId: 'owner', currentAccount: true });
        await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId: homeId,
            accountId: 'owner', machineId: 'machine_1' });
        for (const operation of ['start', 'stop', 'cancel'] as const) {
            const actionId = `browser.recording.${operation}` as const;
            homes.answer(homeId, `/v1/actions/${actionId}`, { select: async (body, request) => {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
                expect(envelope.target).toEqual({ kind: 'machine', machineId: 'machine_1' });
                const input = getActionSpec(actionId).inputSchema.parse(envelope.input);
                const response = await machineRpcMock[operation]({ machineId: 'machine_1', serverId: 'srv_recording',
                    signal: request.signal,
                    ...(operation === 'start' ? { input } : input as Record<string, unknown>) });
                return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
                    requestId: envelope.requestId, execution: response?.ok ? { ok: true, result: response.result }
                        : { ok: false, errorCode: 'rpc_unavailable', error: 'rpc_unavailable' } }) };
            } });
        }
    });

    afterEach(async () => {
        standardCleanup();
        while (nativeCaptureDisposers.length > 0) {
            nativeCaptureDisposers.pop()?.();
        }
        machineRpcMock.start.mockReset();
        machineRpcMock.stop.mockReset();
        machineRpcMock.cancel.mockReset();
        modalSpies.alert.mockReset();
        await homes.reset();
        storage.setState(initialStorage, true);
        resetMmkvStoresForTests();
    });

    it.each([true, false])('admits recording start through the real Action policy (enabled=%s)', async (enabled) => {
        await registerNativeCaptureHandler();
        if (!enabled) homes.answer(homeId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'browser.recording.start': { enabled: false } } },
        } }, version: 1 } });
        machineRpcMock.start.mockResolvedValueOnce({
            ok: true,
            result: { status: 'started', recording: recording() },
        });
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'srv_recording',
                recordingCapabilities,
                nowMs: () => 10_000,
            });
            return (
                <View>
                    <Text testID="recording-mounted">{runtime?.browserShellRecording ? 'yes' : 'no'}</Text>
                    <Text testID="active-recording-id">
                        {runtime?.state.activeRecordingIdByViewId.view_1 ?? 'none'}
                    </Text>
                    <Pressable
                        testID="start-recording"
                        disabled={!runtime}
                        onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                            browserSessionId: 'browser_session_1',
                            viewId: 'view_1',
                            profileId: 'profile_1',
                            target: {
                                kind: 'externalUrl',
                                targetId: 'external_1',
                                url: 'https://example.com/',
                            },
                            targetKind: 'externalUrl',
                            adapterKind: 'externalUrl',
                            renderEngineKind: 'desktopWebView',
                            captureKind: 'nativeViewCapture',
                            fidelity: 'nativeCallback',
                            navigationGeneration: 2,
                            mimeType: 'image/png',
                            retentionClass: 'preSend',
                            policyState: 'allowed',
                        })}
                    />
                </View>
            );
        }

        const screen = await renderRecordingScreen(<Probe />);

        expect(screen.findByTestId('recording-mounted')?.props.children).toBe('yes');
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('none');

        await screen.pressByTestIdAsync('start-recording');

        if (!enabled) {
            expect(machineRpcMock.start).not.toHaveBeenCalled();
            expect(screen.findByTestId('active-recording-id')?.props.children).toBe('none');
            return;
        }
        expect(machineRpcMock.start).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'srv_recording',
            signal: expect.any(AbortSignal),
            input: expect.objectContaining({
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                mediaTarget: {
                    sessionId: 'session_1',
                    messageLocalId: 'browser-recording-view_1-10000',
                },
            }),
        });
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('recording_1');
    });

    it('asks the daemon to start again despite a retained active snapshot', async () => {
        await registerNativeCaptureHandler();
        machineRpcMock.start
            .mockResolvedValueOnce({ ok: true, result: { status: 'started', recording: recording() } })
            .mockResolvedValueOnce({ ok: true, result: { status: 'started', recording: recording({ recordingId: 'recording_2' }) } });
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');
        const hook = await renderHook(() => useSessionBrowserRecordingRuntime({
            enabled: true, sessionId: 'session_1', machineId: 'machine_1', serverId: 'srv_recording',
            recordingCapabilities, nowMs: () => 10_000,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent()).not.toBeNull());

        await act(async () => { await hook.getCurrent()?.browserShellRecording.onStartRecording?.(nativeRecordingRequest); });
        expect(hook.getCurrent()?.state.activeRecordingIdByViewId.view_1).toBe('recording_1');
        // The daemon may retire the recording independently while this projection remains retained.
        await act(async () => { await hook.getCurrent()?.browserShellRecording.onStartRecording?.(nativeRecordingRequest); });

        expect(machineRpcMock.start).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent()?.state.activeRecordingIdByViewId.view_1).toBe('recording_2');
        expect(machineRpcMock.start.mock.calls[1]?.[0].input).not.toHaveProperty('recordingId');
    });

    it('deduplicates concurrent start requests for the same browser view', async () => {
        await registerNativeCaptureHandler();
        machineRpcMock.start.mockReturnValue(new Promise(() => undefined));
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'srv_recording',
                recordingCapabilities,
                nowMs: () => 10_000,
            });
            const request = {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                profileId: 'profile_1',
                target: {
                    kind: 'externalUrl',
                    targetId: 'external_1',
                    url: 'https://example.com/',
                },
                targetKind: 'externalUrl',
                adapterKind: 'externalUrl',
                renderEngineKind: 'desktopWebView',
                captureKind: 'nativeViewCapture',
                fidelity: 'nativeCallback',
                navigationGeneration: 2,
                mimeType: 'image/png',
                retentionClass: 'preSend',
                policyState: 'allowed',
            } as const;
            return (
                <Pressable
                    testID="start-recording"
                    disabled={!runtime}
                    onPress={() => runtime?.browserShellRecording.onStartRecording?.(request)}
                />
            );
        }

        const screen = await renderRecordingScreen(<Probe />);

        screen.pressByTestId('start-recording');
        screen.pressByTestId('start-recording');

        await waitForHomeGovernance(() => expect(machineRpcMock.start).toHaveBeenCalledTimes(1));
    });

    it('does not mark a recording active when daemon start fails closed', async () => {
        await registerNativeCaptureHandler();
        machineRpcMock.start.mockResolvedValueOnce({ ok: false, reason: 'request_failed' });
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'srv_recording',
                recordingCapabilities,
                nowMs: () => 10_000,
            });
            return (
                <View>
                    <Text testID="active-recording-id">
                        {runtime?.state.activeRecordingIdByViewId.view_1 ?? 'none'}
                    </Text>
                    <Pressable
                        testID="start-recording"
                        disabled={!runtime}
                        onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                            browserSessionId: 'browser_session_1',
                            viewId: 'view_1',
                            profileId: 'profile_1',
                            target: {
                                kind: 'externalUrl',
                                targetId: 'external_1',
                                url: 'https://example.com/',
                            },
                            targetKind: 'externalUrl',
                            adapterKind: 'externalUrl',
                            renderEngineKind: 'desktopWebView',
                            captureKind: 'nativeViewCapture',
                            fidelity: 'nativeCallback',
                            navigationGeneration: 2,
                            mimeType: 'image/png',
                            retentionClass: 'preSend',
                            policyState: 'allowed',
                        })}
                    />
                </View>
            );
        }

        const screen = await renderRecordingScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('none');
    });

    it('projects the daemon refusal when no stream-frame capture source is resolvable', async () => {
        machineRpcMock.start.mockResolvedValueOnce({ ok: true, result: {
            status: 'unavailable',
            reason: { code: 'browser_recording_capture_unavailable', message: 'No capture source is available.' },
        } });
        const onUnavailable = vi.fn();
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'srv_recording',
                recordingCapabilities: streamRecordingCapabilities,
                nowMs: () => 10_000,
                onUnavailable,
            });
            return (
                <Pressable
                    testID="start-recording"
                    disabled={!runtime}
                    onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        profileId: 'profile_1',
                        target: {
                            kind: 'localServicePreview',
                            targetId: 'local_preview_1',
                            sessionId: 'session_1',
                            machineId: 'machine_1',
                        },
                        targetKind: 'localServicePreview',
                        adapterKind: 'localPreview',
                        renderEngineKind: 'webIframe',
                        captureKind: 'streamFrameCapture',
                        fidelity: 'streamFrame',
                        navigationGeneration: 2,
                        mimeType: 'video/webm',
                        retentionClass: 'preSend',
                        policyState: 'allowed',
                    })}
                />
            );
        }

        const screen = await renderRecordingScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(machineRpcMock.start).toHaveBeenCalledTimes(1);
        expect(machineRpcMock.start.mock.calls[0]?.[0].input.captureSource).toBeUndefined();
        expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'browser_recording_capture_unavailable',
        }));
    });

    it('projects the daemon refusal when no native reverse-capture handler is registered', async () => {
        machineRpcMock.start.mockResolvedValueOnce({ ok: true, result: {
            status: 'unavailable',
            reason: { code: 'browser_recording_capture_unavailable', message: 'No reverse capture handler is available.' },
        } });
        const onUnavailable = vi.fn();
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'srv_recording',
                recordingCapabilities,
                nowMs: () => 10_000,
                onUnavailable,
            });
            return (
                <Pressable
                    testID="start-recording"
                    disabled={!runtime}
                    onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        profileId: 'profile_1',
                        target: {
                            kind: 'externalUrl',
                            targetId: 'external_1',
                            url: 'https://example.com/',
                        },
                        targetKind: 'externalUrl',
                        adapterKind: 'externalUrl',
                        renderEngineKind: 'desktopWebView',
                        captureKind: 'nativeViewCapture',
                        fidelity: 'nativeCallback',
                        navigationGeneration: 2,
                        mimeType: 'image/png',
                        retentionClass: 'preSend',
                        policyState: 'allowed',
                    })}
                />
            );
        }

        const screen = await renderRecordingScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(machineRpcMock.start).toHaveBeenCalledTimes(1);
        expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'browser_recording_capture_unavailable',
        }));
    });

    it.each(['simulatorPreview', 'streamedBrowser'] as const)('uses %s producer source identity for stream-frame recording', async (targetKind) => {
        machineRpcMock.start.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'started',
                recording: recording({
                    targetKind,
                    adapterKind: targetKind === 'simulatorPreview' ? 'simulatorPreview' : 'streamedBrowserSurface',
                    renderEngineKind: 'streamedSurface',
                    captureKind: 'streamFrameCapture',
                    fidelity: 'streamFrame',
                    mimeType: 'video/webm',
                }),
            },
        });
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'srv_recording',
                recordingCapabilities: {
                    ...streamRecordingCapabilities,
                    supportedAdapterKinds: ['simulatorPreview', 'streamedBrowserSurface'],
                },
                nowMs: () => 10_000,
            });
            return (
                <Pressable
                    testID="start-recording"
                    disabled={!runtime}
                    onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                        profileId: 'profile_1',
                        target: targetKind === 'simulatorPreview' ? {
                            kind: 'simulatorPreview',
                            targetId: 'simulator_1',
                            deviceId: 'emulator-5554',
                            sourceId: 'simulator:android:emulator-5554:screen',
                        } : { kind: 'streamedBrowser', targetId: 'daemon-view', streamId: 'viewer-specific-stream' },
                        targetKind,
                        adapterKind: targetKind === 'simulatorPreview' ? 'simulatorPreview' : 'streamedBrowserSurface',
                        renderEngineKind: 'streamedSurface',
                        captureKind: 'streamFrameCapture',
                        fidelity: 'streamFrame',
                        navigationGeneration: 2,
                        mimeType: 'video/webm',
                        retentionClass: 'preSend',
                        policyState: 'allowed',
                    })}
                />
            );
        }

        const screen = await renderRecordingScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(machineRpcMock.start).toHaveBeenCalledWith(expect.objectContaining({
            input: expect.objectContaining({
                captureSource: {
                    kind: 'machineLiveStream',
                    streamFamily: targetKind === 'simulatorPreview' ? 'simulator:android:emulator-5554:screen' : 'browser.streamed',
                    sourceId: targetKind === 'simulatorPreview' ? 'simulator:android:emulator-5554:screen'
                        : browserViewKey({ browserSessionId: 'browser_session_1', viewId: 'view_1' }),
                    targetMachineId: 'machine_1',
                },
            }),
        }));
    });

    it('surfaces daemon unavailable start responses instead of leaving the UI idle', async () => {
        await registerNativeCaptureHandler();
        machineRpcMock.start.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'unavailable',
                reason: {
                    code: 'browser_recording_capture_unavailable',
                    message: 'Browser recording capture requires a live stream source.',
                },
            },
        });
        const onUnavailable = vi.fn();
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'srv_recording',
                recordingCapabilities,
                nowMs: () => 10_000,
                onUnavailable,
            });
            return (
                <View>
                    <Text testID="active-recording-id">
                        {runtime?.state.activeRecordingIdByViewId.view_1 ?? 'none'}
                    </Text>
                    <Pressable
                        testID="start-recording"
                        disabled={!runtime}
                        onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                            browserSessionId: 'browser_session_1',
                            viewId: 'view_1',
                            profileId: 'profile_1',
                            target: {
                                kind: 'externalUrl',
                                targetId: 'external_1',
                                url: 'https://example.com/',
                            },
                            targetKind: 'externalUrl',
                            adapterKind: 'externalUrl',
                            renderEngineKind: 'desktopWebView',
                            captureKind: 'nativeViewCapture',
                            fidelity: 'nativeCallback',
                            navigationGeneration: 2,
                            mimeType: 'image/png',
                            retentionClass: 'preSend',
                            policyState: 'allowed',
                        })}
                    />
                </View>
            );
        }

        const screen = await renderRecordingScreen(<Probe />);

        await screen.pressByTestIdAsync('start-recording');

        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('none');
        expect(onUnavailable).toHaveBeenCalledWith(expect.objectContaining({
            reasonCode: 'browser_recording_capture_unavailable',
            message: 'Browser recording capture requires a live stream source.',
        }));
    });
    async function renderActiveRecordingProbe(): Promise<Awaited<ReturnType<typeof renderScreen>>> {
        await registerNativeCaptureHandler();
        machineRpcMock.start.mockResolvedValueOnce({
            ok: true,
            result: { status: 'started', recording: recording() },
        });
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');

        function Probe(): React.ReactElement {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true,
                scopeKey: 'session_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                serverId: 'srv_recording',
                recordingCapabilities,
                nowMs: () => 10_000,
            });
            const active = runtime?.state.sessionsById.recording_1 ?? null;
            return (
                <View>
                    <Text testID="active-recording-id">
                        {runtime?.state.activeRecordingIdByViewId.view_1 ?? 'none'}
                    </Text>
                    <Pressable
                        testID="start-recording"
                        disabled={!runtime}
                        onPress={() => runtime?.browserShellRecording.onStartRecording?.({
                            browserSessionId: 'browser_session_1',
                            viewId: 'view_1',
                            profileId: 'profile_1',
                            target: {
                                kind: 'externalUrl',
                                targetId: 'external_1',
                                url: 'https://example.com/',
                            },
                            targetKind: 'externalUrl',
                            adapterKind: 'externalUrl',
                            renderEngineKind: 'desktopWebView',
                            captureKind: 'nativeViewCapture',
                            fidelity: 'nativeCallback',
                            navigationGeneration: 2,
                            mimeType: 'image/png',
                            retentionClass: 'preSend',
                            policyState: 'allowed',
                        })}
                    />
                    <Pressable
                        testID="stop-recording"
                        onPress={() => active ? runtime?.browserShellRecording.onStopRecording?.(active) : undefined}
                    />
                    <Pressable
                        testID="cancel-recording"
                        onPress={() => active ? runtime?.browserShellRecording.onCancelRecording?.(active) : undefined}
                    />
                </View>
            );
        }

        const screen = await renderRecordingScreen(<Probe />);
        await screen.pressByTestIdAsync('start-recording');
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('recording_1');
        return screen;
    }

    it.each(['stop', 'cancel'] as const)('enforces Action policy when the user requests %s', async (operation) => {
        const screen = await renderActiveRecordingProbe();
        homes.answer(homeId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { [`browser.recording.${operation}`]: { enabled: false } } },
        } }, version: 2 } });
        machineRpcMock[operation].mockResolvedValueOnce({ ok: false, reason: 'request_failed' });

        await screen.pressByTestIdAsync(`${operation}-recording`);

        expect(machineRpcMock[operation]).not.toHaveBeenCalled();
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('recording_1');
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
    });

    it('retires the recording Action on session replacement and admits the next start', async () => {
        await registerNativeCaptureHandler();
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');
        const entered = createDeferred<AbortSignal>();
        const lateResponse = createDeferred<{ ok: true; result: { status: 'started'; recording: BrowserRecordingSessionV1 } }>();
        machineRpcMock.start.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
            entered.resolve(signal);
            return lateResponse.promise;
        });
        const hook = await renderHook(({ sessionId }) => useSessionBrowserRecordingRuntime({
            enabled: true, scopeKey: sessionId, sessionId, machineId: 'machine_1', serverId: 'srv_recording',
            recordingCapabilities, nowMs: () => 10_000,
        }), { initialProps: { sessionId: 'session_1' } });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).not.toBeNull());
        let pending: unknown;
        await act(async () => {
            pending = hook.getCurrent()?.browserShellRecording.onStartRecording?.(nativeRecordingRequest);
            await entered.promise;
        });
        await hook.rerender({ sessionId: 'session_2' });
        expect((await entered.promise).aborted).toBe(true);
        await act(async () => {
            lateResponse.resolve({ ok: true, result: { status: 'started', recording: recording() } });
            await pending;
        });
        expect(hook.getCurrent()?.state.activeRecordingIdByViewId.view_1).toBeUndefined();
        machineRpcMock.start.mockResolvedValueOnce({ ok: true, result: { status: 'started', recording: recording() } });
        await act(async () => { await hook.getCurrent()?.browserShellRecording.onStartRecording?.(nativeRecordingRequest); });
        expect(hook.getCurrent()?.state.activeRecordingIdByViewId.view_1).toBe('recording_1');
        expect(machineRpcMock.start).toHaveBeenLastCalledWith(expect.objectContaining({
            input: expect.objectContaining({ mediaTarget: expect.objectContaining({ sessionId: 'session_2' }) }),
        }));
    });

    it('presents Ask-first recording consent in place and starts only after its visible approval', async () => {
        await registerNativeCaptureHandler();
        await homes.requireUiApproval(homeId, 'browser.recording.start');
        machineRpcMock.start.mockResolvedValueOnce({ ok: true, result: { status: 'started', recording: recording() } });
        const { ModalProvider } = await import('@/modal');
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');
        function Probe() {
            const runtime = useSessionBrowserRecordingRuntime({
                enabled: true, sessionId: 'session_1', machineId: 'machine_1', serverId: 'srv_recording',
                recordingCapabilities, nowMs: () => 10_000,
            });
            return <View>
                <Text testID="active-recording-id">{runtime?.state.activeRecordingIdByViewId.view_1 ?? 'none'}</Text>
                <Pressable testID="start-recording" disabled={!runtime}
                    onPress={() => { void runtime?.browserShellRecording.onStartRecording?.(nativeRecordingRequest); }} />
            </View>;
        }
        const screen = await renderRecordingScreen(<ModalProvider><Probe /></ModalProvider>);
        await screen.pressByTestIdAsync('start-recording');
        await waitForHomeGovernance(() => expect(homes.artifacts(homeId).list()).toHaveLength(1));
        expect(machineRpcMock.start).not.toHaveBeenCalled();
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('none');
        await waitForHomeGovernance(() => expect(screen.findByTestId('approvals.approve')).toBeTruthy());
        await screen.pressByTestIdAsync('approvals.approve');
        await waitForHomeGovernance(() => expect(screen.findByTestId('active-recording-id')?.props.children).toBe('recording_1'));
        expect(screen.findByTestId('approvals.in-place')).toBeNull();
    });

    it('retains an Ask-first start until approval settles or its mounted session retires', async () => {
        await registerNativeCaptureHandler();
        await homes.requireUiApproval(homeId, 'browser.recording.start');
        const { useSessionBrowserRecordingRuntime } = await import('./sessionBrowserRecordingRuntime');
        const hook = await renderHook(({ sessionId }) => useSessionBrowserRecordingRuntime({
            enabled: true, scopeKey: sessionId, sessionId, machineId: 'machine_1', serverId: 'srv_recording',
            recordingCapabilities, nowMs: () => 10_000,
        }), { initialProps: { sessionId: 'session_1' } });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).not.toBeNull());
        let settled = false;
        let pending: unknown;
        await act(async () => {
            pending = hook.getCurrent()?.browserShellRecording.onStartRecording?.(nativeRecordingRequest);
            void Promise.resolve(pending).then(() => { settled = true; });
            await waitForHomeGovernance(() => expect(homes.artifacts(homeId).list()).toHaveLength(1));
        });
        expect(settled).toBe(false);
        expect(machineRpcMock.start).not.toHaveBeenCalled();
        expect(hook.getCurrent()?.state.activeRecordingIdByViewId.view_1).toBeUndefined();
        expect(modalSpies.alert).not.toHaveBeenCalled();
        await hook.rerender({ sessionId: 'session_2' });
        await pending;
        expect(settled).toBe(true);
        expect(machineRpcMock.start).not.toHaveBeenCalled();
        expect(homes.artifacts(homeId).list()).toHaveLength(1);
    });

    it('tells the user when stopping a recording fails instead of failing silently (H-UX F-4)', async () => {
        const screen = await renderActiveRecordingProbe();
        machineRpcMock.stop.mockResolvedValueOnce({ ok: false, errorCode: 'rpc_unavailable', error: 'rpc_unavailable' });

        await screen.pressByTestIdAsync('stop-recording');

        const { t } = await import('@/text');
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        expect(modalSpies.alert.mock.calls[0]?.[0]).toBe(t('browserRecording.failure.stopTitle'));
        // Nothing changed, so the recording is still the active one.
        expect(screen.findByTestId('active-recording-id')?.props.children).toBe('recording_1');
    });

    it('tells the user when discarding a recording is refused by the daemon', async () => {
        const screen = await renderActiveRecordingProbe();
        machineRpcMock.cancel.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'unavailable',
                reason: { code: 'browser_recording_capture_unavailable', message: 'capture adapter gone' },
            },
        });

        await screen.pressByTestIdAsync('cancel-recording');

        const { t } = await import('@/text');
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        expect(modalSpies.alert.mock.calls[0]?.[0]).toBe(t('browserRecording.failure.discardTitle'));
        // The daemon's technical message is never shown raw.
        expect(String(modalSpies.alert.mock.calls[0]?.[1])).not.toContain('capture adapter gone');
    });

    it('stays quiet when stop succeeds: the recording state changing is the outcome', async () => {
        const screen = await renderActiveRecordingProbe();
        machineRpcMock.stop.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'finalized',
                recording: recording({
                    status: 'finalized',
                    outcomeReason: 'user_stopped',
                    stoppedAtMs: 12_000,
                    mediaRef: { refKind: 'sessionMedia', mediaId: 'media_1', mediaKind: 'video', mimeType: 'video/webm', sizeBytes: 2048 },
                }),
            },
        });

        await screen.pressByTestIdAsync('stop-recording');

        expect(modalSpies.alert).not.toHaveBeenCalled();
    });
});
