import * as React from 'react';

import { act, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

vi.mock('@/voice/runtime/voiceRuntimeConfigDefaults', async (importActual) => {
    const actual = await importActual<typeof import('@/voice/runtime/voiceRuntimeConfigDefaults')>();
    return {
        VOICE_RUNTIME_CONFIG_DEFAULTS: {
            ...actual.VOICE_RUNTIME_CONFIG_DEFAULTS,
            daemonInference: {
                ...actual.VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference,
                // Only the poll interval is exercised here; spread the real config
                // so the fixture cannot drift from the canonical owner.
                statusPollMs: 123,
            },
        },
    };
});

import { useDaemonVoiceInferenceModelState } from './useDaemonVoiceInferenceModelState';

function createModelStatus(
    installState: DaemonVoiceInferenceModelStatus['installState'],
    progress: DaemonVoiceInferenceModelStatus['progress'] = null,
): DaemonVoiceInferenceModelStatus {
    return {
        packId: 'kokoro-tts-en-v1',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-04-17',
        executionSupport: ['daemon'],
        installState,
        progress,
        lastError: null,
        updatedAtMs: Date.now(),
    };
}

function TestHarness(props: Readonly<{
    client: Pick<DaemonVoiceInferenceClient, 'getStatus' | 'getModelsStatus' | 'installModel' | 'removeModel'>;
    pollIntervalMs?: number;
}>): React.ReactElement {
    const { state, install } = useDaemonVoiceInferenceModelState({
        packId: 'kokoro-tts-en-v1',
        pollIntervalMs: props.pollIntervalMs,
        client: props.client,
    });

    return (
        <>
            {React.createElement('State', {
                installState: state.model?.installState ?? null,
                loading: state.loading,
                actionInFlight: state.actionInFlight,
            })}
            {React.createElement('InstallButton', {
                onPress: () => install(),
            })}
        </>
    );
}

describe('useDaemonVoiceInferenceModelState', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps polling while the daemon reports an asynchronous install in progress', async () => {
        const getStatus = vi.fn(async () => ({
            ok: true as const,
            serviceState: 'ready' as const,
            normalization: {
                inputTransport: 'upload_transfer' as const,
                strategy: 'ui_pretranscoded_pcm16_fallback' as const,
                systemFfmpegAllowed: false as const,
            },
            models: [],
        }));
        const getModelsStatus = vi.fn(async () => [createModelStatus('not_installed')]);
        getModelsStatus
            .mockImplementationOnce(async () => [createModelStatus('not_installed')])
            .mockImplementationOnce(async () => [createModelStatus('installing', {
                phase: 'downloading',
                progress: 0.5,
                bytesDownloaded: 50,
                totalBytes: 100,
                message: null,
            })])
            .mockImplementationOnce(async () => [createModelStatus('installed')]);
        const installModel = vi.fn(async () => createModelStatus('installing', {
            phase: 'downloading',
            progress: 0.1,
            bytesDownloaded: 10,
            totalBytes: 100,
            message: null,
        }));
        const removeModel = vi.fn(async () => undefined);

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            <TestHarness
                client={{ getStatus, getModelsStatus, installModel, removeModel }}
                pollIntervalMs={100}
            />,
        )).tree;

        await act(async () => {
            await Promise.resolve();
        });

        const installButton = tree.root.findByType('InstallButton');
        await act(async () => {
            await pressTestInstanceAsync(installButton);
        });

        expect(tree.root.findByType('State').props.installState).toBe('installing');

        await act(async () => {
            vi.advanceTimersByTime(100);
            await Promise.resolve();
        });

        expect(getModelsStatus).toHaveBeenCalledTimes(3);
        expect(tree.root.findByType('State').props.installState).toBe('installed');
    });

    it('uses the shared runtime config defaults for polling when no poll interval override is provided', async () => {
        const getStatus = vi.fn(async () => ({
            ok: true as const,
            serviceState: 'ready' as const,
            normalization: {
                inputTransport: 'upload_transfer' as const,
                strategy: 'ui_pretranscoded_pcm16_fallback' as const,
                systemFfmpegAllowed: false as const,
            },
            models: [],
        }));
        const getModelsStatus = vi.fn(async () => [createModelStatus('not_installed')]);
        getModelsStatus
            .mockImplementationOnce(async () => [createModelStatus('not_installed')])
            .mockImplementationOnce(async () => [createModelStatus('installing', {
                phase: 'downloading',
                progress: 0.5,
                bytesDownloaded: 50,
                totalBytes: 100,
                message: null,
            })])
            .mockImplementationOnce(async () => [createModelStatus('installed')]);
        const installModel = vi.fn(async () => createModelStatus('installing', {
            phase: 'downloading',
            progress: 0.1,
            bytesDownloaded: 10,
            totalBytes: 100,
            message: null,
        }));
        const removeModel = vi.fn(async () => undefined);

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            <TestHarness
                client={{ getStatus, getModelsStatus, installModel, removeModel }}
            />,
        )).tree;

        await act(async () => {
            await Promise.resolve();
        });

        const installButton = tree.root.findByType('InstallButton');
        await act(async () => {
            await pressTestInstanceAsync(installButton);
        });

        await act(async () => {
            vi.advanceTimersByTime(122);
            await Promise.resolve();
        });

        expect(getModelsStatus).toHaveBeenCalledTimes(2);

        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
        });

        expect(getModelsStatus).toHaveBeenCalledTimes(3);
        expect(tree.root.findByType('State').props.installState).toBe('installed');
    });
});
