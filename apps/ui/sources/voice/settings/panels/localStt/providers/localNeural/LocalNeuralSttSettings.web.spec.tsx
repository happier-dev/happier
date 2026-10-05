import React from 'react';

import { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { t } from '@/text';

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown', () => ({
    DaemonVoiceInferenceExecutionDropdown: (props: any) => React.createElement('ExecutionDropdown', props),
}));

vi.mock('@/voice/settings/panels/modelCatalog/DaemonModelPackRow', () => ({
    SelectedDaemonModelPackRow: (props: any) => React.createElement('DaemonModelSection', props),
}));

const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.web');

describe('LocalNeuralSttSettings (web)', () => {
    it('changes the daemon recognizer language while retaining its pack and execution target', async () => {
        const cfg = { provider: 'local_neural' as const, localNeural: {
            assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', language: 'en', execution: 'daemon' as const,
        } };
        const setCfg = vi.fn();
        const { tree } = await renderScreen(<LocalNeuralSttSettings cfg={cfg} setCfg={setCfg} />);
        const language = tree.root.findAll((node) => node.props.itemTrigger?.title === t('settingsVoice.local.localNeuralStt.language.title')
            && typeof node.props.onSelect === 'function')[0];
        expect(language).toBeDefined();
        await act(async () => { language!.props.onSelect('fr'); });
        expect(setCfg).toHaveBeenCalledWith({ ...cfg, localNeural: { ...cfg.localNeural, language: 'fr' } });
    });
    it('shows daemon inference controls for the default web auto execution path', async () => {
        const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.web');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            <LocalNeuralSttSettings
                cfg={{
                    provider: 'local_neural',
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
        expect(daemonModelSection[0]?.props.kind).toBe('stt_sherpa');
    });

    it('preserves stored web device authority while hiding device selection', async () => {
        const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.web');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(
            <LocalNeuralSttSettings
                cfg={{
                    provider: 'local_neural',
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
        expect(executionDropdown.props.execution).toBe('device');
        expect(executionDropdown.props.allowDeviceSelection).toBe(false);
        expect(tree.root.findAllByType('DaemonModelSection')).toHaveLength(1);
    });
});
