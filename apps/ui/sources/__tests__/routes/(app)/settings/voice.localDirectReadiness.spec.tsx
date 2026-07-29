import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    readLocalConversationVoiceSettings,
    readLocalDirectVoiceSettings,
    voiceSettingsDefaults,
    voiceSettingsParse,
    writeLocalConversationVoiceSettings,
    writeLocalDirectVoiceSettings,
    type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import {
    getDefaultModelPackId,
    getModelPackCatalogEntry,
    type DaemonVoiceInferenceModelStatus,
} from '@happier-dev/protocol';

import { installVoiceSettingsRouteModuleMocks } from './voiceSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
    voice: null as VoiceSettings | null,
    catalogCalls: [] as any[],
    localAvailabilityCalls: [] as any[],
    localAvailabilityRoute: 'relay' as 'relay' | 'relay_capped' | 'relay_disabled',
    voiceHomeDaemonMachineId: 'voice-runtime-machine',
    dictationProps: [] as any[],
    localDirectProps: [] as any[],
    localConversationProps: [] as any[],
    statuses: [] as DaemonVoiceInferenceModelStatus[],
}));

const DIRECT_STT_PACK_ID = getDefaultModelPackId('stt_sherpa')!;
const DIRECT_TTS_PACK_ID = getDefaultModelPackId('tts_sherpa')!;

installVoiceSettingsRouteModuleMocks();

vi.mock('@/voice/settings/useVoiceSettingsMutable', () => ({
    useVoiceSettingsMutable: () => [routeState.voice, vi.fn()],
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => true,
}));

vi.mock('@/constants/Languages', () => ({
    LANGUAGES: [],
    findLanguageByCode: () => null,
}));

vi.mock('@/voice/settings/panels/VoiceProviderSection', () => ({
    VoiceProviderSection: (props: any) => React.createElement('VoiceProviderSection', props),
}));

vi.mock('@/voice/settings/panels/VoicePrivacySection', () => ({
    VoicePrivacySection: (props: any) => React.createElement('VoicePrivacySection', props),
}));

vi.mock('@/voice/settings/panels/VoiceUiSection', () => ({
    VoiceUiSection: (props: any) => React.createElement('VoiceUiSection', props),
}));

vi.mock('@/voice/dictation/DictationSettingsSection', () => ({
    DictationSettingsSection: (props: any) => {
        routeState.dictationProps.push(props);
        return React.createElement('DictationSettingsSection', props);
    },
}));

vi.mock('@/voice/settings/panels/BundledConversationSettingsSection', () => ({
    BundledConversationSettingsSection: (props: any) => React.createElement('BundledConversationSettingsSection', props),
}));

vi.mock('@/voice/settings/panels/LocalDirectSection', () => ({
    LocalDirectSection: (props: any) => {
        routeState.localDirectProps.push(props);
        return React.createElement('LocalDirectSection', props);
    },
}));

vi.mock('@/voice/settings/panels/LocalConversationSection', () => ({
    LocalConversationSection: (props: any) => {
        routeState.localConversationProps.push(props);
        return React.createElement('LocalConversationSection', props);
    },
}));

vi.mock('@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState', () => ({
    useDaemonVoiceModelCatalogState: (params: any) => {
        routeState.catalogCalls.push(params);
        return {
            state: {
                statuses: routeState.statuses,
                errorCode: null,
                loading: false,
                actionPackId: null,
                actionError: null,
            },
            refresh: vi.fn(),
            install: vi.fn(),
            remove: vi.fn(),
        };
    },
}));

vi.mock('@/voice/credentials/useExecutionMachinePresentation', () => ({
    useVoiceExecutionMachinePresentation: () => ({
        machineId: routeState.voiceHomeDaemonMachineId,
        machineLabel: routeState.voiceHomeDaemonMachineId,
    }),
}));

vi.mock('@/voice/settings/voiceProviderLocalAvailability', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/voice/settings/voiceProviderLocalAvailability')>();
    return {
        ...actual,
        useVoiceProviderLocalAvailability: (input: any) => {
            routeState.localAvailabilityCalls.push(input);
            return {
                browserSpeech: { support: 'unavailable', onDevice: 'unsupported' },
                daemon: {
                    featureEnabled: true,
                    route: routeState.localAvailabilityRoute,
                    modelState: input.daemonModelState,
                    runtimeState: input.daemonRuntimeState,
                    pcmCapture: 'available',
                },
                nativeDevice: { requested: false },
            };
        },
    };
});

function status(
    packId: string,
    kind: 'stt_sherpa' | 'tts_sherpa',
    installState: DaemonVoiceInferenceModelStatus['installState'],
): DaemonVoiceInferenceModelStatus {
    const runtimeFamily = getModelPackCatalogEntry(packId)?.runtimeFamily ?? null;
    return {
        packId,
        pluginIdentity: null,
        kind,
        model: packId,
        version: null,
        executionSupport: ['daemon'],
        runtimeFamily,
        runtimeSupported: runtimeFamily !== null,
        installState,
        runtimeState: installState === 'installed' ? 'ready' : undefined,
        progress: null,
        lastError: null,
        updatedAtMs: 0,
    };
}

function createVoice(providerId: VoiceSettings['providerId']): VoiceSettings {
    const localDirect = readLocalDirectVoiceSettings(voiceSettingsDefaults);
    const localConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const withLocalDirect = writeLocalDirectVoiceSettings(
        voiceSettingsDefaults,
        {
            ...localDirect,
            stt: {
                ...localDirect.stt,
                provider: 'local_neural',
                localNeural: {
                    ...localDirect.stt.localNeural,
                    assetId: DIRECT_STT_PACK_ID,
                    execution: 'daemon',
                },
            },
            tts: {
                ...localDirect.tts,
                provider: 'local_neural',
                localNeural: {
                    ...localDirect.tts.localNeural,
                    assetId: DIRECT_TTS_PACK_ID,
                    execution: 'daemon',
                },
            },
        },
    );
    const withLocalConversation = writeLocalConversationVoiceSettings(
        withLocalDirect,
        {
            ...localConversation,
            stt: {
                ...localConversation.stt,
                provider: 'local_neural',
                localNeural: {
                    ...localConversation.stt.localNeural,
                    assetId: DIRECT_STT_PACK_ID,
                    execution: 'daemon',
                },
            },
            tts: {
                ...localConversation.tts,
                provider: 'local_neural',
                localNeural: {
                    ...localConversation.tts.localNeural,
                    assetId: DIRECT_TTS_PACK_ID,
                    execution: 'daemon',
                },
            },
        },
    );
    return voiceSettingsParse({ ...withLocalConversation, providerId });
}

beforeEach(() => {
    routeState.voice = createVoice('local_direct');
    routeState.catalogCalls = [];
    routeState.localAvailabilityCalls = [];
    routeState.localAvailabilityRoute = 'relay';
    routeState.voiceHomeDaemonMachineId = 'voice-runtime-machine';
    routeState.dictationProps = [];
    routeState.localDirectProps = [];
    routeState.localConversationProps = [];
    routeState.statuses = [
        status(DIRECT_STT_PACK_ID, 'stt_sherpa', 'installed'),
        status(DIRECT_TTS_PACK_ID, 'tts_sherpa', 'installed'),
    ];
});

describe('VoiceSettingsScreen local_direct daemon readiness', () => {
    it('enables the daemon catalog and derives readiness from local_direct selected model packs', async () => {
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.catalogCalls.at(-1)?.enabled).toBe(true);
        expect(routeState.localAvailabilityCalls.at(-1)).toMatchObject({
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        });
    });

    it('passes daemon route diagnostics into LocalDirectSection', async () => {
        routeState.localAvailabilityRoute = 'relay_capped';
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.localDirectProps.at(-1)?.daemonRouteDiagnosticReason).toBe('daemon_relay_capped');
    });

    it('uses the runtime voice-home machine target for local_direct daemon diagnostics', async () => {
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.catalogCalls.at(-1)?.refreshKey).toBe('voice-runtime-machine');
        expect(routeState.localAvailabilityCalls.at(-1)?.daemonMachineId).toBe('voice-runtime-machine');
    });

    it('refreshes daemon catalog and diagnostics when the reactive execution machine hydrates', async () => {
        routeState.voiceHomeDaemonMachineId = null as unknown as string;
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;

        const view = await renderSettingsView(<VoiceSettingsScreen />);
        expect(routeState.catalogCalls.at(-1)?.refreshKey).toBeNull();

        routeState.voiceHomeDaemonMachineId = 'hydrated-machine';
        await act(async () => {
            view.tree.update(<VoiceSettingsScreen />);
        });

        expect(routeState.catalogCalls.at(-1)?.refreshKey).toBe('hydrated-machine');
        expect(routeState.localAvailabilityCalls.at(-1)?.daemonMachineId).toBe('hydrated-machine');
    });

    it('projects installed STT readiness to Dictation without requiring the unrelated TTS pack', async () => {
        routeState.voice = createVoice('local_conversation');
        routeState.statuses = [
            status(DIRECT_STT_PACK_ID, 'stt_sherpa', 'installed'),
            status(DIRECT_TTS_PACK_ID, 'tts_sherpa', 'not_installed'),
        ];
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.dictationProps.at(-1)?.localAvailability.daemon).toMatchObject({
            modelState: 'ready',
            runtimeState: 'available',
        });
    });

    it('loads daemon STT catalog facts for explicit local Dictation under a non-local Voice provider', async () => {
        const externalVoice = createVoice('realtime_elevenlabs');
        routeState.voice = voiceSettingsParse({
            ...externalVoice,
            dictation: {
                ...externalVoice.dictation,
                sttBinding: 'explicit',
                stt: {
                    ...externalVoice.dictation.stt,
                    provider: 'local_neural',
                },
            },
        });
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.catalogCalls.at(-1)?.enabled).toBe(true);
        expect(routeState.catalogCalls.at(-1)?.refreshKey).toBe('voice-runtime-machine');
    });
});

afterEach(() => {
    standardCleanup();
});
