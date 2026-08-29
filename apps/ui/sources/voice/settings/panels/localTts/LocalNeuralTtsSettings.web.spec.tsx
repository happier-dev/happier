import React from 'react';

import { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installLocalTtsCommonModuleMocks } from './localTtsTestHelpers';
import { DaemonVoiceModelCatalogProvider } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';

installLocalTtsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: vi.fn(),
                confirm: vi.fn(),
                alert: vi.fn(),
            },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) =>
        React.createElement(
            'DropdownMenu',
            props,
            typeof props.trigger === 'function' ? props.trigger({ open: false, toggle: () => {} }) : props.trigger,
        ),
}));

vi.mock('@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown', () => ({
    DaemonVoiceInferenceExecutionDropdown: (props: any) => React.createElement('ExecutionDropdown', props),
}));

vi.mock('@/voice/settings/panels/modelCatalog/DaemonModelPackRow', () => ({
    SelectedDaemonModelPackRow: (props: any) => React.createElement('DaemonModelSection', props),
}));

describe('LocalNeuralTtsSettings (web)', () => {
    const daemonCatalog = {
        state: {
            statuses: [{
                packId: 'acme.voice/tts-pack', pluginIdentity: { pluginId: 'acme.voice', packId: 'tts-pack' },
                kind: 'tts_sherpa', model: 'kokoro', version: '1', executionSupport: ['daemon'],
                installState: 'installed', progress: null, lastError: null, updatedAtMs: 1,
                voices: [{ id: 'calm', title: 'Calm' }, { id: 'bright', title: 'Bright' }],
                defaultVoiceId: 'bright',
            }],
        },
    } as any;

    it('preserves stored web device authority while hiding device selection and stale browser Kokoro management', async () => {
        const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.web');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(LocalNeuralTtsSettings, {
            cfgKokoro: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart', speed: 1, execution: 'device' },
            setKokoro: vi.fn(),
            networkTimeoutMs: 15_000,
            popoverBoundaryRef: null,
        }))).tree;

        const executionDropdown = tree.root.findByType('ExecutionDropdown');
        expect(executionDropdown.props.execution).toBe('device');
        expect(executionDropdown.props.allowDeviceSelection).toBe(false);

        const daemonModelSections = tree.root.findAllByType('DaemonModelSection');
        expect(daemonModelSections).toHaveLength(1);
        expect(daemonModelSections[0]?.props.packId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
        expect(daemonModelSections[0]?.props.kind).toBe('tts_sherpa');
        expect(tree.root.findAll((node) => node.props?.title === 'settingsVoice.local.kokoro.model.title')).toHaveLength(0);
        expect(tree.root.findAll((node) => node.props?.title === 'settingsVoice.local.kokoro.web.cache.title')).toHaveLength(0);
        expect(tree.root.findAll((node) => node.props?.title === 'settingsVoice.local.kokoro.runtime.title')).toHaveLength(0);
        expect(tree.root.findAll((node) => node.props?.title === 'settingsVoice.local.kokoro.assetPack.title')).toHaveLength(0);
    });

    it('keeps only daemon-relevant voice controls on web after browser Kokoro deletion', async () => {
        const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.web');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(LocalNeuralTtsSettings, {
            cfgKokoro: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart', speed: 1, execution: 'auto' },
            setKokoro: vi.fn(),
            networkTimeoutMs: 15_000,
            popoverBoundaryRef: null,
        }))).tree;

        const dropdowns = tree.root.findAllByType('DropdownMenu');
        expect(dropdowns).toHaveLength(2);
        expect(dropdowns[0]?.props.itemTrigger?.title).toBe('settingsVoice.local.kokoro.voice.titleWeb');
        expect(dropdowns[0]?.props.itemTrigger?.subtitle).toBe('settingsVoice.local.kokoro.voice.subtitleWeb');
        expect(dropdowns[1]?.props.itemTrigger?.title).toBe('settingsVoice.local.kokoro.speed.title');
    });

    it('renders the exact selected daemon pack catalog and fails closed for a retired stored voice', async () => {
        const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.web');
        const render = async (voiceId: string | null) => (await renderScreen(
            <DaemonVoiceModelCatalogProvider value={daemonCatalog}>
                <LocalNeuralTtsSettings
                    cfgKokoro={{ model: 'kokoro', assetId: 'acme.voice/tts-pack', voiceId, speed: 1, execution: 'daemon' }}
                    setKokoro={vi.fn()}
                    networkTimeoutMs={15_000}
                    popoverBoundaryRef={null}
                />
            </DaemonVoiceModelCatalogProvider>,
        )).tree.root.findAllByType('DropdownMenu')[0];

        const defaulted = await render(null);
        expect(defaulted.props.items.map((item: any) => item.id)).toEqual(['calm', 'bright']);
        expect(defaulted.props.selectedId).toBe('bright');

        const retired = await render('retired');
        expect(retired.props.items.map((item: any) => item.id)).toEqual(['calm', 'bright']);
        expect(retired.props.selectedId).toBe('');
        expect(retired.props.itemTrigger.detailFormatter()).toBe('common.unavailable');
    });
});
