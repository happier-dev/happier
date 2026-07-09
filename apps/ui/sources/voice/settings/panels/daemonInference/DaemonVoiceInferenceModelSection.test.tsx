import React from 'react';

import { act, ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol';
import type { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('DaemonVoiceInferenceModelSection', () => {
    it('surfaces relay-disabled daemon diagnostics ahead of daemon service readiness', async () => {
        const client: Pick<DaemonVoiceInferenceClient, 'getStatus' | 'getModelsStatus' | 'installModel' | 'removeModel'> = {
            getStatus: vi.fn(async () => ({
                ok: true as const,
                serviceState: 'ready' as const,
                normalization: {
                    inputTransport: 'upload_transfer' as const,
                    strategy: 'ui_pretranscoded_pcm16_fallback' as const,
                    systemFfmpegAllowed: false as const,
                },
                models: [],
            })),
            getModelsStatus: vi.fn(async () => ([])),
            installModel: vi.fn(async (request): Promise<DaemonVoiceInferenceModelStatus> => ({
                packId: request.packId,
                kind: 'tts_sherpa' as const,
                model: 'kokoro',
                version: null,
                executionSupport: ['daemon'],
                installState: 'installed' as const,
                progress: null,
                lastError: null,
                updatedAtMs: 1,
            })),
            removeModel: vi.fn(async () => undefined),
        };

        const { DaemonVoiceInferenceModelSection } = await import('./DaemonVoiceInferenceModelSection');

        const { tree } = await renderScreen(
            <DaemonVoiceInferenceModelSection
                packId="kokoro-tts-en-v1"
                kind="tts"
                client={client}
                daemonRouteDiagnosticReason="daemon_relay_disabled"
            />,
        );

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const serviceItem = tree.root.find((node) => node.props?.title === 'Daemon inference service');

        expect(serviceItem.props.detail).toBe('Daemon relay is disabled.');
    });

    it('renders daemon service/model state and installs the selected model pack on demand', async () => {
        const notInstalledModel: DaemonVoiceInferenceModelStatus = {
            packId: 'kokoro-tts-en-v1',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '2026-04-17',
            executionSupport: ['daemon'],
            installState: 'not_installed',
            progress: null,
            lastError: null,
            updatedAtMs: 1,
        };
        const installedModel: DaemonVoiceInferenceModelStatus = {
            ...notInstalledModel,
            installState: 'installed',
            updatedAtMs: 2,
        };
        const client: Pick<DaemonVoiceInferenceClient, 'getStatus' | 'getModelsStatus' | 'installModel' | 'removeModel'> = {
            getStatus: vi.fn(async () => ({
                ok: true as const,
                serviceState: 'ready' as const,
                normalization: {
                    inputTransport: 'upload_transfer' as const,
                    strategy: 'ui_pretranscoded_pcm16_fallback' as const,
                    systemFfmpegAllowed: false as const,
                },
                models: [],
            })),
            getModelsStatus: vi.fn(async () => ([notInstalledModel])),
            installModel: vi.fn(async () => installedModel),
            removeModel: vi.fn(async () => undefined),
        };

        const { DaemonVoiceInferenceModelSection } = await import('./DaemonVoiceInferenceModelSection');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            <DaemonVoiceInferenceModelSection packId="kokoro-tts-en-v1" kind="tts" client={client} />,
        )).tree;

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const modelItem = tree.root
            .findAll((node) => node.props?.title === 'Daemon model pack')
            .find((node) => typeof node.props?.onPress === 'function');

        expect(modelItem).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(modelItem!);
        });

        expect(client.installModel).toHaveBeenCalledWith({
            packId: 'kokoro-tts-en-v1',
        });
    });
});
