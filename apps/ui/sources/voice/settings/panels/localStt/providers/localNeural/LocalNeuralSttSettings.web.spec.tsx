import React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { t } from '@/text';
import { DaemonVoiceInferenceExecutionDropdown } from '@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown';
import { SelectedDaemonModelPackRow } from '@/voice/settings/panels/modelCatalog/DaemonModelPackRow';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ pathname: () => route.pathname }).module);

afterEach(standardCleanup);
beforeEach(() => { route.pathname = '/'; });

const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.web');

describe('LocalNeuralSttSettings (web)', () => {
    it('allows choosing the smaller June pack without changing execution or language', async () => {
        route.pathname = SETTINGS_ROUTES.voiceDictation;
        const cfg = { provider: 'local_neural' as const, localNeural: {
            assetId: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', language: 'fr', execution: 'daemon' as const,
        } };
        const setCfg = vi.fn();
        const { tree } = await renderScreen(<LocalNeuralSttSettings cfg={cfg} setCfg={setCfg} />);
        const picker = tree.root.findAllByType(DropdownMenu).find(node => node.props.selectedId === cfg.localNeural.assetId);
        expect(picker).toBeDefined();
        expect(picker!.props.items.some((item: { id: string }) => item.id === cfg.localNeural.assetId)).toBe(true);
        const june = 'sherpa-onnx-streaming-zipformer-en-2023-06-26';
        expect(picker!.props.items.some((item: { id: string }) => item.id === june)).toBe(true);
        await act(async () => { picker!.props.onSelect(june); });
        expect(setCfg).toHaveBeenCalledTimes(1);
        expect(setCfg).toHaveBeenCalledWith({ ...cfg, localNeural: { ...cfg.localNeural, assetId: june } });
    });
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

        const { tree } = await renderScreen(
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
        );

        const execution = tree.root.findByType(DaemonVoiceInferenceExecutionDropdown);
        const dropdown = execution.findByType(DropdownMenu);
        expect(dropdown.props.selectedId).toBe('auto');
        expect(dropdown.props.items.map((item: { id: string }) => item.id)).toEqual(['auto', 'daemon']);
        const daemonModelSection = tree.root.findAllByType(SelectedDaemonModelPackRow);
        expect(daemonModelSection).toHaveLength(1);
        expect(daemonModelSection[0]?.props.packId).toBe('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
        expect(daemonModelSection[0]?.props.kind).toBe('stt_sherpa');
    });

    it('preserves stored web device authority while hiding device selection', async () => {
        const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.web');

        const { tree } = await renderScreen(
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
        );

        const executionDropdown = tree.root.findByType(DaemonVoiceInferenceExecutionDropdown);
        expect(executionDropdown.props.execution).toBe('device');
        expect(executionDropdown.props.allowDeviceSelection).toBe(false);
        expect(executionDropdown.findByType(DropdownMenu).props.selectedId).toBe('daemon');
        expect(tree.root.findAllByType(SelectedDaemonModelPackRow)).toHaveLength(1);
    });
});
