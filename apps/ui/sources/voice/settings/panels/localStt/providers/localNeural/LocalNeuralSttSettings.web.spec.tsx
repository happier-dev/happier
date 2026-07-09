import React from 'react';

import { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown', () => ({
    DaemonVoiceInferenceExecutionDropdown: (props: any) => React.createElement('ExecutionDropdown', props),
}));

vi.mock('@/voice/settings/panels/daemonInference/DaemonVoiceInferenceModelSection', () => ({
    DaemonVoiceInferenceModelSection: (props: any) => React.createElement('DaemonModelSection', props),
}));

describe('LocalNeuralSttSettings (web)', () => {
    it('shows daemon inference controls for the default web auto execution path', async () => {
        const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.web');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            <LocalNeuralSttSettings
                cfg={{
                    provider: 'local_neural',
                    openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                    googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                    localNeural: {
                        assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                        language: 'en',
                        execution: 'auto',
                    },
                }}
                setCfg={vi.fn()}
                popoverBoundaryRef={null}
            />,
        )).tree;

        expect(tree.root.findAllByType('ExecutionDropdown')).toHaveLength(1);
        const daemonModelSection = tree.root.findAllByType('DaemonModelSection');
        expect(daemonModelSection).toHaveLength(1);
        expect(daemonModelSection[0]?.props.packId).toBe('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
        expect(daemonModelSection[0]?.props.kind).toBe('stt');
    });

    it('passes daemon relay diagnostics to the daemon model section', async () => {
        const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.web');

        const { tree } = await renderScreen(
            <LocalNeuralSttSettings
                cfg={{
                    provider: 'local_neural',
                    openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                    googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                    localNeural: {
                        assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                        language: 'en',
                        execution: 'auto',
                    },
                }}
                setCfg={vi.fn()}
                popoverBoundaryRef={null}
                daemonRouteDiagnosticReason="daemon_relay_capped"
            />,
        );

        expect(tree.root.findByType('DaemonModelSection').props.daemonRouteDiagnosticReason).toBe('daemon_relay_capped');
    });

    it('clamps stored web device execution to daemon inference controls', async () => {
        const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.web');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            <LocalNeuralSttSettings
                cfg={{
                    provider: 'local_neural',
                    openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                    googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                    localNeural: {
                        assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                        language: 'en',
                        execution: 'device',
                    },
                }}
                setCfg={vi.fn()}
                popoverBoundaryRef={null}
            />,
        )).tree;

        const executionDropdown = tree.root.findByType('ExecutionDropdown');
        expect(executionDropdown.props.execution).toBe('daemon');
        expect(executionDropdown.props.allowDeviceSelection).toBe(false);
        expect(tree.root.findAllByType('DaemonModelSection')).toHaveLength(1);
        expect(tree.root.findAllByType('Item')).toHaveLength(0);
    });
});
