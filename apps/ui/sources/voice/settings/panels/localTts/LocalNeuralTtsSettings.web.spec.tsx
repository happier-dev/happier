import React from 'react';

import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createPlainMachineRowFixture, renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { t } from '@/text';
import { DaemonVoiceInferenceModelStatusSchema, DaemonVoiceInferenceModelsListResponseSchema,
    DaemonVoiceInferenceModelsStatusResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const account = createProviderSettingsAccountHarness();
const remoteStatus = DaemonVoiceInferenceModelStatusSchema.parse({
    packId: 'acme.voice/tts-pack', pluginIdentity: { pluginId: 'acme.voice', packId: 'tts-pack' },
    kind: 'tts_sherpa', model: 'kokoro', version: '1', executionSupport: ['daemon'],
    installState: 'installed', progress: null, lastError: null, updatedAtMs: 1,
    voices: [{ id: 'calm', title: 'Calm' }, { id: 'bright', title: 'Bright' }], defaultVoiceId: 'bright',
});
installSessionActionRpcBoundary(async request => {
    if (request.method.endsWith(':daemon.voiceInference.models.list')) {
        return DaemonVoiceInferenceModelsListResponseSchema.parse({ ok: true, models: [remoteStatus] });
    }
    if (request.method.endsWith(':daemon.voiceInference.models.status')) {
        return DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: [] });
    }
    throw new Error(`Unexpected model catalog RPC: ${request.method}`);
});

vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

vi.mock('@expo/vector-icons', async () =>
    (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { DaemonVoiceInferenceExecutionDropdown } = await import('@/voice/settings/panels/daemonInference/DaemonVoiceInferenceExecutionDropdown');
const { SelectedDaemonModelPackRow } = await import('@/voice/settings/panels/modelCatalog/DaemonModelPackRow');
const { DaemonVoiceModelCatalogProvider } = await import('@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext');
const { useDaemonVoiceModelCatalogState } = await import('@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState');
const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.web');
beforeEach(async () => {
    const scope = await account.restore({ settings: { experiments: true,
        featureToggles: { 'voice.agent': true, 'execution.runs': true, 'voice.daemonInference': true },
        voice: { providerId: 'local_conversation', executionMachine: { mode: 'fixed', machineId: 'tts-machine' } },
    }, machines: [createMachineFixture({ id: 'tts-machine', activeAt: Date.now() })],
    features: createRootLayoutFeaturesResponse({ features: {
        voice: { enabled: true },
        machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
    }, capabilities: { machines: { ...createRootLayoutFeaturesResponse().capabilities.machines, liveStream: { serverRouted: { disabledReason: null, caps: {
        maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000, maxDurationMs: 60_000,
        maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2,
        maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1,
    } } } } } }), });
    const machine = createPlainMachineRowFixture({ id: 'tts-machine', accountId: scope.accountId });
    account.home.answer(scope.serverId, '/v1/machines/tts-machine', { body: { machine } });
    account.home.answer(scope.serverId, '/v1/machines/tts-machine/access', { body: {
        machineId: machine.id, custodian: machine.access!.custodian, access: machine.access,
        canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    } });
});
afterEach(async () => { standardCleanup(); await account.reset(); });

describe('LocalNeuralTtsSettings (web)', () => {
    it.each([null, 1, Number.NaN])('shows effective default speed for %s and preserves the pack and voice when changed', async (storedSpeed) => {
        const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.web');
        const cfgKokoro = { model: 'kokoro' as const, assetId: 'acme.voice/tts-pack', voiceId: 'bright',
            speed: storedSpeed, execution: 'daemon' as const };
        const setKokoro = vi.fn();
        const { tree } = await renderScreen(<LocalNeuralTtsSettings
            cfgKokoro={cfgKokoro}
            setKokoro={setKokoro}
            networkTimeoutMs={15_000}
        />);
        const speed = tree.root.findAllByType(DropdownMenu).find((node) =>
            node.props.itemTrigger?.title === t('settingsVoice.local.kokoro.speed.title'));
        expect(speed).toBeDefined();
        expect(speed!.props.selectedId).toBe('1');
        expect(setKokoro).not.toHaveBeenCalled();
        await act(async () => { speed!.props.onSelect('1.2'); });
        expect(setKokoro).toHaveBeenCalledWith({ ...cfgKokoro, speed: 1.2 });
    });

    it('preserves stored web device authority while hiding device selection and stale browser Kokoro management', async () => {
        const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.web');

        const { tree } = await renderScreen(React.createElement(LocalNeuralTtsSettings, {
            cfgKokoro: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart', speed: 1, execution: 'device' },
            setKokoro: vi.fn(),
            networkTimeoutMs: 15_000,
            popoverBoundaryRef: null,
        }));

        const executionDropdown = tree.root.findByType(DaemonVoiceInferenceExecutionDropdown);
        expect(executionDropdown.props.execution).toBe('device');
        expect(executionDropdown.props.allowDeviceSelection).toBe(false);
        expect(executionDropdown.findByType(DropdownMenu).props.selectedId).toBe('daemon');

        const daemonModelSections = tree.root.findAllByType(SelectedDaemonModelPackRow);
        expect(daemonModelSections).toHaveLength(1);
        expect(daemonModelSections[0]?.props.packId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
        expect(daemonModelSections[0]?.props.kind).toBe('tts_sherpa');
        expect(tree.root.findAll((node) => node.props?.title === t('settingsVoice.local.kokoro.model.title'))).toHaveLength(0);
        expect(tree.root.findAll((node) => node.props?.title === t('settingsVoice.local.kokoro.web.cache.title'))).toHaveLength(0);
        expect(tree.root.findAll((node) => node.props?.title === t('settingsVoice.local.kokoro.runtime.title'))).toHaveLength(0);
        expect(tree.root.findAll((node) => node.props?.title === t('settingsVoice.local.kokoro.assetPack.title'))).toHaveLength(0);
    });

    it('keeps daemon-relevant controls and changes the selected voice without replacing pack, speed or execution', async () => {
        const cfgKokoro = { model: 'kokoro' as const, assetId: 'acme.voice/tts-pack', voiceId: 'bright',
            speed: 1.2, execution: 'auto' as const };
        const setKokoro = vi.fn();
        function DaemonSettings() {
            const controller = useDaemonVoiceModelCatalogState({ refreshKey: 'tts-machine' });
            return <DaemonVoiceModelCatalogProvider value={controller}>
                <LocalNeuralTtsSettings cfgKokoro={cfgKokoro} setKokoro={setKokoro}
                    networkTimeoutMs={15_000} popoverBoundaryRef={null} />
            </DaemonVoiceModelCatalogProvider>;
        }
        const screen = await renderScreen(<DaemonSettings />);
        const { tree } = screen;
        const voiceMenu = () => tree.root.findAllByType(DropdownMenu).find(node =>
            node.props.itemTrigger?.title === t('settingsVoice.local.kokoro.voice.titleWeb'))!;
        await waitForTestEvent(screen.subscribe, () => voiceMenu().props.items.map((item: { id: string }) => item.id),
            ids => ids.length === 2 && ids[0] === 'calm' && ids[1] === 'bright');

        const dropdowns = tree.root.findAllByType(DropdownMenu).filter((node) =>
            node.props.itemTrigger?.title !== t('settingsVoice.local.daemonInference.execution.title'));
        expect(dropdowns).toHaveLength(2);
        expect(dropdowns[0]?.props.itemTrigger?.title).toBe(t('settingsVoice.local.kokoro.voice.titleWeb'));
        expect(dropdowns[0]?.props.itemTrigger?.subtitle).toBe(t('settingsVoice.local.kokoro.voice.subtitleWeb'));
        expect(dropdowns[1]?.props.itemTrigger?.title).toBe(t('settingsVoice.local.kokoro.speed.title'));
        expect(voiceMenu().props.selectedId).toBe('bright');
        expect(setKokoro).not.toHaveBeenCalled();
        await act(async () => { voiceMenu().props.onSelect('calm'); });
        expect(setKokoro).toHaveBeenCalledWith({ ...cfgKokoro, voiceId: 'calm' });
    });

    it('renders the exact selected daemon pack catalog and fails closed for a retired stored voice', async () => {
        function DaemonSettings({ voiceId }: { voiceId: string | null }) {
            const controller = useDaemonVoiceModelCatalogState({ refreshKey: 'tts-machine' });
            return <DaemonVoiceModelCatalogProvider value={controller}>
                <LocalNeuralTtsSettings
                    cfgKokoro={{ model: 'kokoro', assetId: 'acme.voice/tts-pack', voiceId, speed: 1, execution: 'daemon' }}
                    setKokoro={vi.fn()}
                    networkTimeoutMs={15_000}
                    popoverBoundaryRef={null}
                />
            </DaemonVoiceModelCatalogProvider>;
        }
        const render = async (voiceId: string | null) => {
            const screen = await renderScreen(<DaemonSettings voiceId={voiceId} />);
            const menu = () => screen.tree.root.findAllByType(DropdownMenu).find(node =>
                node.props.itemTrigger?.title === t('settingsVoice.local.kokoro.voice.titleWeb'))!;
            await waitForTestEvent(screen.subscribe, () => menu().props.items.map((item: { id: string }) => item.id),
                ids => ids.length === 2 && ids[0] === 'calm' && ids[1] === 'bright');
            expect(menu().props.items.map((item: { id: string }) => item.id)).toEqual(['calm', 'bright']);
            return menu();
        };

        const defaulted = await render(null);
        expect(defaulted.props.items.map((item: { id: string }) => item.id)).toEqual(['calm', 'bright']);
        expect(defaulted.props.selectedId).toBe('bright');

        const retired = await render('retired');
        expect(retired.props.items.map((item: { id: string }) => item.id)).toEqual(['calm', 'bright']);
        expect(retired.props.selectedId).toBe('');
        const firstItem = retired.props.items[0];
        const detailFormatter = retired.props.itemTrigger?.detailFormatter;
        if (!firstItem || !detailFormatter) throw new Error('Voice selection detail missing');
        expect(detailFormatter(firstItem)).toBe(t('common.unavailable'));
    });
});
