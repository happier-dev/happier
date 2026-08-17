import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    settingsParse,
    type Settings,
} from '@/sync/domains/settings/settings';
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
    accountSettings: null as Settings | null,
    setVoice: vi.fn<(next: VoiceSettings) => void>(),
    platformOs: 'web' as 'web' | 'ios',
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

installVoiceSettingsRouteModuleMocks({
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => null,
            useSettings: () => routeState.accountSettings ?? settingsParse({ voice: routeState.voice }),
        });
    },
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return routeState.platformOs;
            },
            select: (values: Record<string, unknown>) => (
                values[routeState.platformOs] ?? values.native ?? values.default ?? values.web
            ),
        },
    });
});

vi.mock('@/voice/settings/useVoiceSettingsMutable', () => ({
    useVoiceSettingsMutable: () => [routeState.voice, routeState.setVoice],
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...original,
        useAllMachines: () => [{
            id: 'machine-1',
            active: true,
            createdAt: 1,
            updatedAt: 1,
            activeAt: 1,
            seq: 1,
            metadata: {
                displayName: 'Primary Mac',
                host: 'primary-mac',
                platform: 'darwin',
                happyCliVersion: '1',
                happyHomeDir: '/h',
                homeDir: '/u',
            },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
        }],
    };
});

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
    routeState.accountSettings = null;
    routeState.setVoice.mockReset();
    routeState.platformOs = 'web';
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
    it('does not activate provider, daemon catalog, or local readiness work for Privacy & data', async () => {
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoicePrivacySettingsScreen')).VoicePrivacySettingsScreen;

        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        expect(screen.findByTestId('settings.voice.section.privacy')).toBeTruthy();
        expect(routeState.catalogCalls).toHaveLength(0);
        expect(routeState.localAvailabilityCalls).toHaveLength(0);
        expect(routeState.localDirectProps).toHaveLength(0);
        expect(routeState.localConversationProps).toHaveLength(0);
        expect(routeState.dictationProps).toHaveLength(0);
    });

    it('enables the daemon catalog and derives readiness from local_direct selected model packs', async () => {
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.catalogCalls.at(-1)?.enabled).toBe(true);
        expect(routeState.localAvailabilityCalls.at(-1)).toMatchObject({
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        });
    });

    it('passes daemon route diagnostics into LocalDirectSection', async () => {
        routeState.localAvailabilityRoute = 'relay_capped';
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.localDirectProps.at(-1)?.daemonRouteDiagnosticReason).toBe('daemon_relay_capped');
    });

    it('uses the runtime voice-home machine target for local_direct daemon diagnostics', async () => {
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.catalogCalls.at(-1)?.refreshKey).toBe('voice-runtime-machine');
        expect(routeState.localAvailabilityCalls.at(-1)?.daemonMachineId).toBe('voice-runtime-machine');
    });

    it('reaches the canonical machine selector for a Connected Account conversation provider', async () => {
        const { applyAccountVoiceCredentialSourceSelection } = await import('@/voice/credentials/accountVoiceCredential');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const provider = createDefaultVoiceProviderRegistry().get('happier.voice.openai/realtime-openai');
        if (provider?.kind !== 'voice.conversation-provider.v1' || provider.declaration?.kind !== 'conversation') {
            throw new Error('expected_openai_voice_provider');
        }
        const initial = settingsParse({
            voice: {
                ...voiceSettingsDefaults,
                providerId: provider.providerId,
            },
        });
        const selected = applyAccountVoiceCredentialSourceSelection({
            settings: initial,
            mutation: {
                contribution: { pluginId: provider.pluginId, localId: provider.declaration.id },
                credentialSlotId: provider.declaration.credentials!.slot.id,
                selection: {
                    kind: 'connectedAccount',
                    target: {
                        kind: 'account',
                        account: {
                            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                            accountId: 'codex-work',
                        },
                    },
                },
                expectedSettingsVersion: 1,
            },
            currentDeclaration: provider.declaration,
        });
        routeState.accountSettings = selected.settings;
        routeState.voice = selected.settings.voice;
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;

        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const dropdown = screen.findAll((node) => (
            String(node.type) === 'DropdownMenu'
            && node.props?.itemTrigger?.title === 'settingsVoice.local.executionMachine.title'
        ))[0];

        expect(dropdown?.props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'machine-1', title: 'Primary Mac' }),
        ]));
        await act(async () => {
            dropdown?.props.onSelect('machine-1');
        });
        expect(routeState.setVoice).toHaveBeenCalledWith(expect.objectContaining({
            executionMachine: expect.objectContaining({ mode: 'fixed', machineId: 'machine-1' }),
        }));
    });

    it('refreshes daemon catalog and diagnostics when the reactive execution machine hydrates', async () => {
        routeState.voiceHomeDaemonMachineId = null as unknown as string;
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceConversationsSettingsScreen')).VoiceConversationsSettingsScreen;

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
        const localConversationVoice = createVoice('local_conversation');
        routeState.voice = voiceSettingsParse({
            ...localConversationVoice,
            dictation: {
                ...localConversationVoice.dictation,
                sttBinding: 'same_as_local',
            },
        });
        routeState.statuses = [
            status(DIRECT_STT_PACK_ID, 'stt_sherpa', 'installed'),
            status(DIRECT_TTS_PACK_ID, 'tts_sherpa', 'not_installed'),
        ];
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceDictationSettingsScreen')).VoiceDictationSettingsScreen;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.dictationProps.at(-1)?.localAvailability.daemon).toMatchObject({
            modelState: 'ready',
            runtimeState: 'available',
        });
    });

    it('loads daemon STT catalog facts for explicit local Dictation under a non-local Voice provider', async () => {
        const externalVoice = createVoice('happier.voice.elevenlabs/realtime-elevenlabs');
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
        const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceDictationSettingsScreen')).VoiceDictationSettingsScreen;

        await renderSettingsView(<VoiceSettingsScreen />);

        expect(routeState.catalogCalls.at(-1)?.enabled).toBe(true);
        expect(routeState.catalogCalls.at(-1)?.refreshKey).toBe('voice-runtime-machine');
    });

    it.each(['auto', 'device'] as const)(
        'does not request daemon catalog or daemon facts for native local-neural Dictation with %s execution',
        async (execution) => {
            routeState.platformOs = 'ios';
            const externalVoice = createVoice('happier.voice.elevenlabs/realtime-elevenlabs');
            routeState.voice = voiceSettingsParse({
                ...externalVoice,
                dictation: {
                    ...externalVoice.dictation,
                    sttBinding: 'explicit',
                    stt: {
                        ...externalVoice.dictation.stt,
                        provider: 'local_neural',
                        localNeural: {
                            ...externalVoice.dictation.stt.localNeural,
                            execution,
                        },
                    },
                },
            });
            const VoiceSettingsScreen = (await import('@/voice/settings/screens/VoiceDictationSettingsScreen')).VoiceDictationSettingsScreen;

            await renderSettingsView(<VoiceSettingsScreen />);

            expect(routeState.catalogCalls.at(-1)).toMatchObject({
                enabled: false,
                refreshKey: null,
            });
            expect(routeState.localAvailabilityCalls.at(-1)).toMatchObject({
                daemonMachineId: null,
                daemonModelState: 'unknown',
                daemonRuntimeState: 'unknown',
            });
        },
    );
});

afterEach(() => {
    standardCleanup();
});
