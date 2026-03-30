import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import {
    getVoiceSettingsRouteModalMockRef,
    installVoiceSettingsRouteModuleMocks,
} from './voiceSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setVoiceProviderId = vi.fn();
const setVoice = vi.fn();
const decryptSecretValue = vi.fn<(value: unknown) => string | null>(() => null);
const resetGlobalVoiceAgentPersistenceSpy = vi.fn(async () => {});
const canAgentResumeSpy = vi.fn<(agentId: string | null | undefined) => boolean>(() => true);
const modalMockRef = getVoiceSettingsRouteModalMockRef();

installVoiceSettingsRouteModuleMocks({
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => null,
            useSettings: () => ({}),
        });
    },
});

vi.mock('@/voice/agent/resetGlobalVoiceAgentPersistence', () => ({
    resetGlobalVoiceAgentPersistence: () => resetGlobalVoiceAgentPersistenceSpy(),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        decryptSecretValue: (value: unknown) => decryptSecretValue(value),
        encryptSecretValue: () => ({ _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } }),
    },
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => false,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/constants/Languages', () => ({
    LANGUAGES: [{ code: 'en', name: 'English' }],
    findLanguageByCode: () => ({ code: 'en', name: 'English' }),
    getLanguageDisplayName: () => 'English',
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude', 'codex', 'opencode'],
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: [],
        probe: {
            phase: 'idle',
            refresh: vi.fn(),
        },
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [],
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'test-server' }),
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
    resolvePreferredMachineId: () => null,
}));

vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canAgentResume: (agentId: string | null | undefined) => canAgentResumeSpy(agentId),
}));

const voiceState: any = {
    providerId: 'realtime_elevenlabs',
    assistantLanguage: null,
    ui: {
        scopeDefault: 'global',
        surfaceLocation: 'auto',
        activityFeedEnabled: false,
        activityFeedAutoExpandOnStart: false,
        updates: {
            activeSession: 'summaries',
            otherSessions: 'activity',
            snippetsMaxMessages: 3,
            includeUserMessagesInSnippets: false,
            otherSessionsSnippetsMode: 'on_demand_only',
        },
    },
    privacy: {
        shareSessionSummary: true,
        shareRecentMessages: true,
        recentMessagesCount: 3,
        shareToolNames: true,
        sharePermissionRequests: true,
        shareFilePaths: false,
        shareToolArgs: false,
    },
    adapters: {
        realtime_elevenlabs: {
            assistantLanguage: null,
            billingMode: 'happier',
            tts: {
                voiceId: 'EST9Ui6982FZPSi7gCHi',
                modelId: null,
                voiceSettings: {
                    stability: null,
                    similarityBoost: null,
                    style: null,
                    useSpeakerBoost: null,
                    speed: null,
                },
            },
            byo: { agentId: null, apiKey: null },
        },
        local_direct: {
            stt: { baseUrl: null, apiKey: null, model: 'whisper-1', useDeviceStt: false },
            tts: {
                provider: 'openai_compat',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                kokoro: { assetSetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true
            },
            networkTimeoutMs: 15000,
            handsFree: { enabled: false, endpointing: { silenceMs: 450, minSpeechMs: 120 } },
        },
        local_conversation: {
            conversationMode: 'direct_session',
            stt: { baseUrl: null, apiKey: null, model: 'whisper-1', useDeviceStt: false },
            tts: {
                provider: 'openai_compat',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
                kokoro: { assetSetId: null, voiceId: null, speed: null },
                autoSpeakReplies: true,
                bargeInEnabled: true
            },
            networkTimeoutMs: 15000,
            handsFree: { enabled: false, endpointing: { silenceMs: 450, minSpeechMs: 120 } },
            agent: {
                backend: 'daemon',
                agentSource: 'session',
                agentId: 'claude',
                permissionPolicy: 'read_only',
                idleTtlSeconds: 300,
                chatModelSource: 'custom',
                chatModelId: 'default',
                commitModelSource: 'chat',
                commitModelId: 'default',
                openaiCompat: { chatBaseUrl: null, chatApiKey: null, chatModel: 'default', commitModel: 'default', temperature: 0.4, maxTokens: null },
                verbosity: 'short',
            },
            streaming: { enabled: false, ttsEnabled: false, ttsChunkChars: 200 },
        },
    },
};

vi.mock('@/voice/settings/useVoiceSettingsMutable', () => ({
    useVoiceSettingsMutable: () => [voiceState, (next: any) => setVoice(next)],
}));

beforeEach(() => {
    setVoice.mockClear();
    setVoiceProviderId.mockClear();
    decryptSecretValue.mockReset();
    decryptSecretValue.mockReturnValue(null);
    canAgentResumeSpy.mockReset();
    canAgentResumeSpy.mockReturnValue(true);
    voiceState.providerId = 'realtime_elevenlabs';
    voiceState.assistantLanguage = null;
    voiceState.adapters.realtime_elevenlabs.assistantLanguage = null;
    voiceState.adapters.realtime_elevenlabs.billingMode = 'happier';
    voiceState.ui.scopeDefault = 'global';
    voiceState.ui.surfaceLocation = 'auto';
    voiceState.ui.updates.activeSession = 'summaries';
    voiceState.ui.updates.otherSessions = 'activity';
    voiceState.ui.updates.snippetsMaxMessages = 3;
    voiceState.ui.updates.includeUserMessagesInSnippets = false;
    voiceState.ui.updates.otherSessionsSnippetsMode = 'on_demand_only';
    voiceState.privacy.shareRecentMessages = true;
    voiceState.privacy.recentMessagesCount = 3;
});

function findDropdownByItemTriggerTitle(
    screen: { findAll: (predicate: (node: any) => boolean) => any[] },
    title: string,
) {
    return screen.findAll((node) => node.type === 'DropdownMenu' && node.props?.itemTrigger?.title === title)[0] ?? null;
}

afterEach(() => {
    modalMockRef.current?.spies.alert.mockClear();
    modalMockRef.current?.spies.confirm.mockClear();
    modalMockRef.current?.spies.prompt.mockClear();
    standardCleanup();
});

describe('VoiceSettingsScreen (server voice unsupported)', () => {
    it('hides Happier Voice option and coerces mode to off', async () => {
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        expect(screen.findRowByTitle('settingsVoice.mode.off')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.mode.local')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.mode.byo')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.mode.happier')).toBeNull();
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'off' }));
    });
});

describe('VoiceSettingsScreen (voice settings UX)', () => {
    it('shows local TTS settings even in direct-to-session conversation mode', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'direct_session';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        expect(findDropdownByItemTriggerTitle(screen, 'settingsVoice.local.ttsProvider')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.local.autoSpeak')).toBeTruthy();
    });

    it('uses screen-level popover boundaries for dropdowns', async () => {
        voiceState.providerId = 'realtime_elevenlabs';
        voiceState.adapters.realtime_elevenlabs.billingMode = 'byo';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        expect(dropdowns.length).toBeGreaterThan(0);

        const boundaryRef = dropdowns[0]!.props.popoverBoundaryRef;
        expect(boundaryRef).toBeTruthy();
        expect(typeof boundaryRef).toBe('object');
        expect('current' in boundaryRef).toBe(true);

        for (const dropdown of dropdowns) {
            expect(dropdown.props.popoverBoundaryRef).toBe(boundaryRef);
        }
    });

    it('does not show navigation chevrons for voice mode selection rows', async () => {
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const modeItems = [
            screen.findRowByTitle('settingsVoice.mode.off'),
            screen.findRowByTitle('settingsVoice.mode.byo'),
            screen.findRowByTitle('settingsVoice.mode.local'),
        ].filter(Boolean);

        expect(modeItems.length).toBeGreaterThan(0);
        for (const item of modeItems as any[]) {
            expect(item.props.showChevron).toBe(false);
        }
    });

    it('does not render ineffective privacy toggles (file paths/tool args) as interactive settings', async () => {
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        expect(screen.findRowByTitle('settingsVoice.privacy.shareFilePaths')).toBeNull();
        expect(screen.findRowByTitle('settingsVoice.privacy.shareToolArgs')).toBeNull();
    });

    it('does not use confirm modals for local conversation mode selection', async () => {
        await import('@/modal');

        // Enable local conversation so the section renders.
        voiceState.providerId = 'local_conversation';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.conversationMode')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.conversationMode');
        });

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('does not use confirm modals for local voice agent backend selection', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.mediatorBackend')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.mediatorBackend');
        });

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('does not use confirm modals for other local conversation enum settings', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        const pressByTitle = async (title: string) => {
            expect(screen.findRowByTitle(title)).toBeTruthy();
            await act(async () => {
                await screen.pressRowByTitle(title);
            });
        };

        await pressByTitle('settingsVoice.local.mediatorAgentSource');
        await pressByTitle('settingsVoice.local.mediatorPermissionPolicy');
        await pressByTitle('settingsVoice.local.mediatorChatModelSource');
        await pressByTitle('settingsVoice.local.mediatorCommitModelSource');
        await pressByTitle('settingsVoice.local.mediatorVerbosity');

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('disables provider resume when the selected fixed agent does not support vendor resume', async () => {
        canAgentResumeSpy.mockImplementation((agentId) => agentId !== 'unknown-agent');
        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';
        voiceState.adapters.local_conversation.agent.agentSource = 'agent';
        voiceState.adapters.local_conversation.agent.agentId = 'unknown-agent';
        voiceState.adapters.local_conversation.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        const resumabilityDropdown = dropdowns.find((d: any) => Array.isArray(d.props?.items) && d.props.items.some((i: any) => i?.id === 'provider_resume'));
        expect(resumabilityDropdown).toBeTruthy();

        const providerResumeItem = resumabilityDropdown!.props.items.find((i: any) => i?.id === 'provider_resume');
        expect(providerResumeItem?.disabled).toBe(true);
    });

    it('can toggle voice agent commit isolation', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';
        voiceState.adapters.local_conversation.agent.backend = 'daemon';
        voiceState.adapters.local_conversation.agent.commitIsolation = false;

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.conversation.commitIsolation.title')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.conversation.commitIsolation.title');
        });

        expect(setVoice).toHaveBeenCalledWith(
            expect.objectContaining({
                adapters: expect.objectContaining({
                    local_conversation: expect.objectContaining({
                        agent: expect.objectContaining({
                            commitIsolation: true,
                        }),
                    }),
                }),
            }),
        );
    });

    it('can reset persistent local voice agent state and bumps the transcript epoch', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';
        voiceState.adapters.local_conversation.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

        resetGlobalVoiceAgentPersistenceSpy.mockClear();
        modalMockRef.current.spies.confirm.mockResolvedValueOnce(true);

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.conversation.resetVoiceAgent.title')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.conversation.resetVoiceAgent.title');
        });

        expect(resetGlobalVoiceAgentPersistenceSpy).toHaveBeenCalledTimes(1);
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('clamps voice agent idle TTL to 6 hours', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';

        modalMockRef.current.spies.prompt.mockResolvedValueOnce('999999');

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.mediatorIdleTtl')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.mediatorIdleTtl');
        });

        expect(setVoice).toHaveBeenCalledWith(
            expect.objectContaining({
                adapters: expect.objectContaining({
                    local_conversation: expect.objectContaining({
                        agent: expect.objectContaining({ idleTtlSeconds: 21600 }),
                    }),
                }),
            }),
        );
    });

    it('does not use confirm modals for local TTS format selection', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_direct';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.ttsFormat')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.ttsFormat');
        });

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('does not use prompt modals for voice assistant language selection', async () => {
        await import('@/modal');

        voiceState.providerId = 'off';
        voiceState.assistantLanguage = null;

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.preferredLanguage')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.preferredLanguage');
        });

        expect(modalMockRef.current.spies.prompt).not.toHaveBeenCalled();
    });

    it('wires ElevenLabs voice dropdown selection into settings (BYO)', async () => {
        voiceState.providerId = 'realtime_elevenlabs';
        voiceState.adapters.realtime_elevenlabs.billingMode = 'byo';
        decryptSecretValue.mockReturnValue('xi-test');

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        const voiceDropdown = dropdowns.find((d: any) => d.props?.search === true && d.props?.searchPlaceholder === 'settingsVoice.byo.voiceSearchPlaceholder');
        expect(voiceDropdown).toBeTruthy();

        await act(async () => {
            voiceDropdown!.props.onSelect?.('voice_test');
        });

        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            adapters: expect.objectContaining({
                realtime_elevenlabs: expect.objectContaining({
                    tts: expect.objectContaining({ voiceId: 'voice_test' }),
                }),
            }),
        }));
    });

    it('wires ElevenLabs speaker boost tri-state into settings (BYO)', async () => {
        voiceState.providerId = 'realtime_elevenlabs';
        voiceState.adapters.realtime_elevenlabs.billingMode = 'byo';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        const boostDropdown = dropdowns.find((d: any) => {
            const items = d.props?.items;
            if (!Array.isArray(items)) return false;
            const ids = items.map((i: any) => i?.id);
            return ids.includes('') && ids.includes('true') && ids.includes('false');
        });
        expect(boostDropdown).toBeTruthy();

        await act(async () => {
            boostDropdown!.props.onSelect?.('false');
        });

        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            adapters: expect.objectContaining({
                realtime_elevenlabs: expect.objectContaining({
                    tts: expect.objectContaining({
                        voiceSettings: expect.objectContaining({ useSpeakerBoost: false }),
                    }),
                }),
            }),
        }));
    });
});
