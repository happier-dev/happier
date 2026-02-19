import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setVoiceProviderId = vi.fn();
const setVoice = vi.fn();
const decryptSecretValue = vi.fn<(value: unknown) => string | null>(() => null);
const resetGlobalVoiceAgentPersistenceSpy = vi.fn(async () => {});

vi.mock('react-native-unistyles', () => {
    const theme = { colors: {} };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: {
            create: (factory: any) => (typeof factory === 'function' ? {} : factory),
            absoluteFillObject: {},
        },
    };
});

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        prompt: vi.fn(),
        confirm: vi.fn(),
        alert: vi.fn(),
    },
}));

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

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: React.forwardRef((props: any, ref: any) => React.createElement('ItemList', { ...props, ref }, props.children)),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        props,
        (() => {
            const toggle = () => props.onOpenChange?.(!props.open);
            const openMenu = () => props.onOpenChange?.(true);
            const closeMenu = () => props.onOpenChange?.(false);
            if (props.itemTrigger) {
                return React.createElement(
                    'Item',
                    {
                        title: props.itemTrigger.title,
                        subtitle: props.itemTrigger.subtitle,
                        icon: props.itemTrigger.icon,
                        detail: undefined,
                        onPress: toggle,
                        showChevron: false,
                        selected: false,
                    },
                );
            }
            return (typeof props.trigger === 'function'
                ? props.trigger({ open: false, toggle, openMenu, closeMenu, selectedItem: null })
                : props.trigger) ?? null;
        })(),
    ),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude', 'codex', 'opencode'],
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: () => null,
}));

beforeEach(() => {
    setVoice.mockClear();
    setVoiceProviderId.mockClear();
    decryptSecretValue.mockReset();
    decryptSecretValue.mockReturnValue(null);
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

describe('VoiceSettingsScreen (server voice unsupported)', () => {
    it('hides Happier Voice option and coerces mode to off', async () => {
        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });

        await act(async () => {});

        const items = tree.root.findAllByType('Item' as any);
        const titles = items.map((i: any) => i.props.title);

        expect(titles).toContain('settingsVoice.mode.off');
        expect(titles).toContain('settingsVoice.mode.local');
        expect(titles).toContain('settingsVoice.mode.byo');
        expect(titles).not.toContain('settingsVoice.mode.happier');
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'off' }));
    });
});

describe('VoiceSettingsScreen (voice settings UX)', () => {
    it('shows local TTS settings even in direct-to-session conversation mode', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'direct_session';

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const items = tree.root.findAllByType('Item' as any);
        const titles = items.map((i: any) => i.props.title);
        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
        const dropdownTriggerTitles = dropdowns
            .map((d: any) => d.props?.itemTrigger?.title)
            .filter((t: any) => typeof t === 'string');

        expect([...titles, ...dropdownTriggerTitles]).toContain('settingsVoice.local.ttsProvider');
        expect(titles).toContain('settingsVoice.local.autoSpeak');
    });

    it('uses screen-level popover boundaries for dropdowns', async () => {
        voiceState.providerId = 'realtime_elevenlabs';
        voiceState.adapters.realtime_elevenlabs.billingMode = 'byo';

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
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
        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const items = tree.root.findAllByType('Item' as any);
        const modeItems = items.filter((i: any) => [
            'settingsVoice.mode.off',
            'settingsVoice.mode.byo',
            'settingsVoice.mode.local',
        ].includes(i.props.title));

        expect(modeItems.length).toBeGreaterThan(0);
        for (const item of modeItems) {
            expect(item.props.showChevron).toBe(false);
        }
    });

    it('does not render ineffective privacy toggles (file paths/tool args) as interactive settings', async () => {
        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const items = tree.root.findAllByType('Item' as any);
        const titles = items.map((i: any) => i.props.title);

        expect(titles).not.toContain('settingsVoice.privacy.shareFilePaths');
        expect(titles).not.toContain('settingsVoice.privacy.shareToolArgs');
    });

    it('does not use confirm modals for local conversation mode selection', async () => {
        const { Modal } = await import('@/modal');

        // Enable local conversation so the section renders.
        voiceState.providerId = 'local_conversation';

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const conversationModeItem = tree.root
            .findAll((n) => n.props?.title === 'settingsVoice.local.conversationMode')
            .find((n) => typeof n.props?.onPress === 'function');

        expect(conversationModeItem).toBeTruthy();

        await act(async () => {
            conversationModeItem!.props.onPress?.();
        });
        await act(async () => {});

        expect((Modal as any).confirm).not.toHaveBeenCalled();
    });

    it('does not use confirm modals for local voice agent backend selection', async () => {
        const { Modal } = await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const backendItem = tree.root
            .findAll((n) => n.props?.title === 'settingsVoice.local.mediatorBackend')
            .find((n) => typeof n.props?.onPress === 'function');

        expect(backendItem).toBeTruthy();

        await act(async () => {
            backendItem!.props.onPress?.();
        });
        await act(async () => {});

        expect((Modal as any).confirm).not.toHaveBeenCalled();
    });

    it('does not use confirm modals for other local conversation enum settings', async () => {
        const { Modal } = await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const pressByTitle = async (title: string) => {
            const node = tree.root
                .findAll((n) => n.props?.title === title)
                .find((n) => typeof n.props?.onPress === 'function');
            expect(node).toBeTruthy();
            await act(async () => {
                node!.props.onPress?.();
            });
            await act(async () => {});
        };

        await pressByTitle('settingsVoice.local.mediatorAgentSource');
        await pressByTitle('settingsVoice.local.mediatorPermissionPolicy');
        await pressByTitle('settingsVoice.local.mediatorChatModelSource');
        await pressByTitle('settingsVoice.local.mediatorCommitModelSource');
        await pressByTitle('settingsVoice.local.mediatorVerbosity');

        expect((Modal as any).confirm).not.toHaveBeenCalled();
    });

    it('disables provider resume when the selected fixed agent does not support vendor resume', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';
        voiceState.adapters.local_conversation.agent.agentSource = 'agent';
        voiceState.adapters.local_conversation.agent.agentId = 'unknown-agent';
        voiceState.adapters.local_conversation.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
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

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const commitIsolationItem = tree.root
            .findAll((n) => n.props?.title === 'Commit isolation')
            .find((n) => typeof n.props?.onPress === 'function');
        expect(commitIsolationItem).toBeTruthy();

        await act(async () => {
            commitIsolationItem!.props.onPress?.();
        });
        await act(async () => {});

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
        const { Modal } = await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';
        voiceState.adapters.local_conversation.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

        resetGlobalVoiceAgentPersistenceSpy.mockClear();
        (Modal as any).confirm.mockResolvedValueOnce(true);

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const resetItem = tree.root
            .findAll((n) => n.props?.title === 'Reset voice agent')
            .find((n) => typeof n.props?.onPress === 'function');
        expect(resetItem).toBeTruthy();

        await act(async () => {
            resetItem!.props.onPress?.();
        });
        await act(async () => {});

        expect(resetGlobalVoiceAgentPersistenceSpy).toHaveBeenCalledTimes(1);
        expect(setVoice).toHaveBeenCalledWith(
            expect.objectContaining({
                adapters: expect.objectContaining({
                    local_conversation: expect.objectContaining({
                        agent: expect.objectContaining({
                            transcript: expect.objectContaining({ epoch: 2 }),
                        }),
                    }),
                }),
            }),
        );
        (Modal as any).confirm.mockClear();
    });

    it('clamps voice agent idle TTL to 6 hours', async () => {
        const { Modal } = await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.adapters.local_conversation.conversationMode = 'agent';

        (Modal as any).prompt.mockResolvedValueOnce('999999');

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const idleTtlItem = tree.root
            .findAll((n) => n.props?.title === 'settingsVoice.local.mediatorIdleTtl')
            .find((n) => typeof n.props?.onPress === 'function');
        expect(idleTtlItem).toBeTruthy();

        await act(async () => {
            idleTtlItem!.props.onPress?.();
        });
        await act(async () => {});

        expect(setVoice).toHaveBeenCalledWith(
            expect.objectContaining({
                adapters: expect.objectContaining({
                    local_conversation: expect.objectContaining({
                        agent: expect.objectContaining({ idleTtlSeconds: 21600 }),
                    }),
                }),
            }),
        );
        (Modal as any).prompt.mockClear();
    });

    it('does not use confirm modals for local TTS format selection', async () => {
        const { Modal } = await import('@/modal');

        voiceState.providerId = 'local_direct';

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const formatItem = tree.root
            .findAll((n) => n.props?.title === 'settingsVoice.local.ttsFormat')
            .find((n) => typeof n.props?.onPress === 'function');

        expect(formatItem).toBeTruthy();

        await act(async () => {
            formatItem!.props.onPress?.();
        });
        await act(async () => {});

        expect((Modal as any).confirm).not.toHaveBeenCalled();
    });

    it('does not use prompt modals for voice assistant language selection', async () => {
        const { Modal } = await import('@/modal');

        voiceState.providerId = 'off';
        voiceState.assistantLanguage = null;

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const languageItem = tree.root
            .findAll((n) => n.props?.title === 'settingsVoice.preferredLanguage')
            .find((n) => typeof n.props?.onPress === 'function');

        expect(languageItem).toBeTruthy();

        await act(async () => {
            languageItem!.props.onPress?.();
        });
        await act(async () => {});

        expect((Modal as any).prompt).not.toHaveBeenCalled();
    });

    it('wires ElevenLabs voice dropdown selection into settings (BYO)', async () => {
        voiceState.providerId = 'realtime_elevenlabs';
        voiceState.adapters.realtime_elevenlabs.billingMode = 'byo';
        decryptSecretValue.mockReturnValue('xi-test');

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
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

        const VoiceSettingsScreen = (await import('./voice')).default;

        let tree!: ReactTestRenderer;
        act(() => {
            tree = renderer.create(React.createElement(VoiceSettingsScreen));
        });
        await act(async () => {});

        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
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
