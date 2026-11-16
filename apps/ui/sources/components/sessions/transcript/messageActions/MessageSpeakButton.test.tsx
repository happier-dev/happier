import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { stopReadAloud } from '@/voice/local/readAloudState';
import { setVoiceSessionSnapshot, useVoiceSessionStore } from '@/voice/session/voiceSessionStore';
import { NavigationContext } from '@react-navigation/native';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { useVoiceActivityStore } from '@/voice/activity/voiceActivityStore';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceActivityEvent } from '@/voice/activity/voiceActivityEvents';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Boundaries only: device speech, HTTP, the web audio unlock, the modal and the
// platform/theme/text shells. The button, readAloud and speakAssistantText are real.
type SpeakOptions = { onDone?: () => void; onStopped?: () => void };
const expoSpeech = vi.hoisted(() => ({
    speak: vi.fn<(text: string, options: SpeakOptions) => void>(),
    stop: vi.fn(),
}));
const modal = vi.hoisted(() => ({ spies: null as null | { alert: ReturnType<typeof vi.fn> } }));
const primeWebAudioPlayback = vi.hoisted(() => vi.fn());

vi.mock('expo-speech', () => expoSpeech);
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/voice' }).module;
});
vi.mock('@/voice/output/webAudioContext', () => ({ primeWebAudioPlayback }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web', select: (v: Record<string, unknown>) => v.web ?? v.default } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme: { colors: { text: { secondary: '#666666' }, state: { active: { foreground: '#0a7a4b' } } } } });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const mock = createModalModuleMock();
    modal.spies = mock.spies;
    return mock.module;
});
function setVoice(voice: ReturnType<typeof voiceSettingsParse>): void {
    storage.setState(state => ({ settings: { ...state.settings, voice } }));
}

const localVoice = voiceSettingsParse({
    providerId: 'local_conversation',
    adapters: { local_conversation: { tts: { provider: 'device' } } },
});

let utterances: SpeakOptions[] = [];
const initialStorageState = storage.getState();
const initialVoiceTargetState = useVoiceTargetStore.getState();

describe('MessageSpeakButton', () => {
    beforeEach(async () => {
        storage.setState({ settings: { ...initialStorageState.settings, experiments: true, featureToggles: { voice: true } } });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(createRootLayoutFeaturesResponse({ features: { voice: { enabled: true } } }))));
        await getServerFeaturesSnapshot({ force: true });
    });

    afterEach(() => {
        standardCleanup();
        stopReadAloud();
        utterances.forEach(utterance => utterance.onStopped?.());
        storage.setState(initialStorageState, true);
        setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
        useVoiceTargetStore.setState(initialVoiceTargetState, true);
        useVoiceActivityStore.setState({ eventsBySessionId: {} });
        utterances = [];
        expoSpeech.speak.mockReset();
        expoSpeech.stop.mockReset();
        primeWebAudioPlayback.mockReset();
        vi.unstubAllGlobals();
    });

    function setup() {
        setVoice(localVoice);
        expoSpeech.speak.mockImplementation((_text, options) => { utterances.push(options); });
    }

    it('is hidden when no local voice provider is selected', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setVoice(voiceSettingsParse({ providerId: 'realtime_elevenlabs' }));
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hi" testID="speak" />);
        expect(screen.findAllByType('Pressable')).toHaveLength(0);
    });

    it('is hidden when there is nothing to read', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="   " testID="speak" />);
        expect(screen.findAllByType('Pressable')).toHaveLength(0);
    });

    it('hides when the canonical voice feature is disabled despite configured TTS', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        storage.setState(state => ({ settings: { ...state.settings, featureToggles: { voice: false } } }));
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);
        expect(screen.findAllByType('Pressable')).toHaveLength(0);
    });

    it.each(['off', 'feature'] as const)('stops playback when %s revokes voice availability', async (revoke) => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);
        await act(async () => { screen.pressByTestId('speak'); });
        await act(async () => {
            if (revoke === 'off') setVoice(voiceSettingsParse({ providerId: 'off' }));
            else storage.setState(state => ({ settings: { ...state.settings, featureToggles: { voice: false } } }));
        });
        expect(screen.findAllByType('Pressable')).toHaveLength(0);
        expect(expoSpeech.stop).toHaveBeenCalledTimes(1);
    });

    it('hides when the server disables voice', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(createRootLayoutFeaturesResponse({ features: { voice: { enabled: false } } }))));
        await getServerFeaturesSnapshot({ force: true });
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);
        expect(screen.findAllByType('Pressable')).toHaveLength(0);
    });

    it('unlocks web audio from the press, reads the message, and offers Stop while it plays', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);
        expect(screen.findByTestId('speak')?.props.accessibilityLabel).toBe('message.readAloudA11y');

        await act(async () => { screen.pressByTestId('speak'); });
        expect(primeWebAudioPlayback).toHaveBeenCalledTimes(1);
        expect(expoSpeech.speak).toHaveBeenCalledWith('hello', expect.any(Object));
        await vi.waitFor(() => expect(screen.findByTestId('speak')?.props.accessibilityLabel).toBe('message.stopReadAloudA11y'));

        await act(async () => { screen.pressByTestId('speak'); });
        expect(expoSpeech.stop).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(screen.findByTestId('speak')?.props.accessibilityLabel).toBe('message.readAloudA11y'));
        utterances[0].onStopped?.();
    });

    it('does not offer Stop on a different message that is not playing', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        const screen = await renderScreen(
            <>
                <MessageSpeakButton messageKey="m1" text="one" testID="speak-1" />
                <MessageSpeakButton messageKey="m2" text="two" testID="speak-2" />
            </>,
        );

        await act(async () => { screen.pressByTestId('speak-1'); });
        await vi.waitFor(() => expect(screen.findByTestId('speak-1')?.props.accessibilityLabel).toBe('message.stopReadAloudA11y'));
        expect(screen.findByTestId('speak-2')?.props.accessibilityLabel).toBe('message.readAloudA11y');
        await act(async () => { utterances[0].onDone?.(); });
    });

    it('tells the user when the voice provider fails', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        setup();
        expoSpeech.speak.mockImplementation(() => { throw new Error('no voice'); });
        const screen = await renderScreen(<MessageSpeakButton messageKey="m1" text="hello" testID="speak" />);

        await act(async () => { screen.pressByTestId('speak'); });
        await vi.waitFor(() => expect(modal.spies?.alert).toHaveBeenCalledWith('common.error', 'message.readAloudFailed'));
    });

    it.each(['speaking', 'preparing'] as const)('keeps one global Stop while %s after leaving the transcript and restores live placement afterward', async (phase) => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        const { VoiceSurface } = await import('@/components/voice/surface/VoiceSurface');
        const { renderAppStackScreenWithVoiceSurface } = await import('@/components/navigation/appStackScreenLayout');
        setup();
        const synthesis = { signal: null as AbortSignal | null };
        const tts = phase === 'preparing'
            ? { provider: 'openai_compat', openaiCompat: { baseUrl: 'https://tts.example.test' } }
            : { provider: 'device' };
        setVoice(voiceSettingsParse({ ...localVoice, adapters: { local_conversation: { tts } }, ui: { surfaceLocation: 'session', scopeDefault: 'session' } }));
        if (phase === 'preparing') {
            // HTTP synthesis is pending at the network boundary; cancellation and the provider stay real.
            vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
                synthesis.signal = init?.signal ?? null;
                synthesis.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            })));
        }
        setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 's1', status: 'connected', mode: 'idle', canStop: true });
        const surfaces = <>
            <VoiceSurface variant="sidebar" />
            <VoiceSurface variant="session" sessionId="s1" />
        </>;
        const shell = (children: React.ReactElement, focused = true, key = 'current') => {
            // Host boundary supplies only the SDK methods useIsFocused consumes; its hook stays real.
            const navigation = { isFocused: () => focused, addListener: () => () => {} } as unknown as React.ContextType<typeof NavigationContext>;
            return <NavigationContext.Provider key={key} value={navigation}>
                {renderAppStackScreenWithVoiceSurface({ options: {}, children })}
            </NavigationContext.Provider>;
        };
        const screen = await renderScreen(<>{shell(<></>, false, 'previous')}{shell(<><MessageSpeakButton messageKey="m1" text="hello" testID="speak" />{surfaces}</>)}</>);
        await act(async () => { screen.pressByTestId('speak'); });
        if (phase === 'preparing') await vi.waitFor(() => expect(synthesis.signal).not.toBeNull());
        await act(async () => {
            useVoiceTargetStore.getState().setScope('global');
            screen.tree.update(<>{shell(<></>, false, 'previous')}{shell(<>{null}{surfaces}</>)}</>);
        });

        expect(expoSpeech.stop).not.toHaveBeenCalled();
        expect(useVoiceTargetStore.getState().scope).toBe('global');
        const controls = (label: string) => screen.findAllByType('Pressable').filter(button => button.props.accessibilityLabel === label);
        const stops = controls('message.stopReadAloudA11y');
        expect(stops).toHaveLength(1);
        expect(controls('voiceAssistant.tapToEnd')).toHaveLength(0);
        await act(async () => { stops[0].props.onPress(); });
        if (phase === 'speaking') expect(expoSpeech.stop).toHaveBeenCalledTimes(1);
        else expect(synthesis.signal?.aborted).toBe(true);
        expect(useVoiceSessionStore.getState()).toMatchObject({ status: 'connected', sessionId: 's1', mode: 'idle' });
        expect(useVoiceTargetStore.getState().scope).toBe('global');
        expect(controls('message.stopReadAloudA11y')).toHaveLength(0);
        expect(controls('voiceAssistant.tapToEnd')).toHaveLength(1);
        await act(async () => {
            setVoice(voiceSettingsParse({ ...storage.getState().settings.voice,
                ui: { ...storage.getState().settings.voice.ui, scopeDefault: 'global' } }));
        });
        await act(async () => {
            setVoice(voiceSettingsParse({ ...storage.getState().settings.voice,
                ui: { ...storage.getState().settings.voice.ui, scopeDefault: 'session' } }));
        });
        expect(useVoiceTargetStore.getState().scope).toBe('session');
    });

    it('preserves an expanded live feed and avoids activity work in standalone playback', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        const { VoiceSurface } = await import('@/components/voice/surface/VoiceSurface');
        setup();
        setVoice(voiceSettingsParse({ ...localVoice, ui: { surfaceLocation: 'session', scopeDefault: 'session', activityFeedEnabled: true } }));
        voiceActivityController.appendUserText('s1', 'local_conversation', 'keep this activity visible');
        let playbackCommits = 0;
        const screen = await renderScreen(<>
            <MessageSpeakButton messageKey="feed-message" text="hello" testID="speak" />
            <VoiceSurface variant="session" sessionId="s1" />
            <React.Profiler id="playback" onRender={() => { playbackCommits += 1; }}><VoiceSurface variant="global" /></React.Profiler>
        </>);
        const control = (label: string) => screen.findAllByType('Pressable').find(button => button.props.accessibilityLabel === label)!;
        await act(async () => { control('voiceSurface.a11y.toggleActivity').props.onPress(); });
        expect(screen.findAllByType('ScrollView')).toHaveLength(1);
        await act(async () => { screen.pressByTestId('speak'); });
        const before = playbackCommits;
        await act(async () => { voiceActivityController.appendUserText('other', 'local_conversation', 'unrelated activity'); });
        expect(playbackCommits).toBe(before);
        await act(async () => { control('message.stopReadAloudA11y').props.onPress(); });
        expect(screen.findAllByType('ScrollView')).toHaveLength(1);
    });

    it('keeps expanded session activity unchanged when another session receives events', async () => {
        const { VoiceSurface } = await import('@/components/voice/surface/VoiceSurface');
        setup();
        setVoice(voiceSettingsParse({ ...localVoice, ui: { surfaceLocation: 'session', activityFeedEnabled: true } }));
        voiceActivityController.appendUserText('s1', 'local_conversation', 'current session activity');
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="session-feed" onRender={() => { commits += 1; }}>
            <VoiceSurface variant="session" sessionId="s1" />
        </React.Profiler>);
        await act(async () => { screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' }).props.onPress(); });
        const before = commits;
        await act(async () => { voiceActivityController.appendUserText('other', 'local_conversation', 'other session activity'); });
        expect(commits).toBe(before);
        await act(async () => { voiceActivityController.appendUserText('s1', 'local_conversation', 'new current activity'); });
        expect(screen.getTextContent()).toContain('new current activity');
        expect(screen.getTextContent()).not.toContain('other session activity');
    });

    it('reads only counts while activity is collapsed and opens current details after replacements', async () => {
        const { VoiceSurface } = await import('@/components/voice/surface/VoiceSurface');
        setup();
        setVoice(voiceSettingsParse({ ...localVoice, ui: { surfaceLocation: 'sidebar', activityFeedEnabled: true } }));
        let iterations = 0;
        // Instrument real event arrays to observe history traversal without replacing store or feed logic.
        const events = (sessionId: string, text: string) => new Proxy<VoiceActivityEvent[]>([{
            id: `${sessionId}-${text}`, sessionId, ts: 1, adapterId: 'local_conversation', kind: 'user.text', text,
        }], { get(target, key, receiver) {
            if (key === Symbol.iterator) iterations += 1;
            return Reflect.get(target, key, receiver);
        } });
        useVoiceActivityStore.setState({ eventsBySessionId: { s1: events('s1', 'old activity'), s2: events('s2', 'other activity') } });
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="collapsed-feed" onRender={() => { commits += 1; }}>
            <VoiceSurface variant="sidebar" />
        </React.Profiler>);
        const counts = () => screen.findAllByType('Text').map(node => String(node.props.children ?? ''));
        expect(counts()).toContain('2');
        expect(iterations).toBe(0);
        const before = commits;
        await act(async () => { useVoiceActivityStore.getState().replaceSessionEvents('s1', events('s1', 'current activity')); });
        expect(commits).toBe(before);
        expect(iterations).toBe(0);
        await act(async () => { screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' }).props.onPress(); });
        expect(screen.getTextContent()).toContain('current activity');
        expect(screen.getTextContent()).not.toContain('old activity');
        await act(async () => { screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' }).props.onPress(); });
        const closedIterations = iterations;
        await act(async () => { useVoiceActivityStore.getState().replaceSessionEvents('s2', events('s2', 'latest activity')); });
        expect(iterations).toBe(closedIterations);
        await act(async () => { screen.findByProps({ accessibilityLabel: 'voiceSurface.a11y.toggleActivity' }).props.onPress(); });
        expect(screen.getTextContent()).toContain('latest activity');
        await act(async () => {
            useVoiceActivityStore.getState().replaceSessionEvents('s1', Array.from({ length: 60 }, (_, index) => ({
                id: `tail-${index}`, sessionId: 's1', ts: index + 10, adapterId: 'local_conversation',
                kind: 'user.text', text: `tail event ${index}`,
            })));
        });
        expect(counts()).toContain('61');
        const rows = screen.findAllByType('Text').filter(node => node.props.numberOfLines === 3)
            .map(node => String(node.props.children ?? ''));
        expect(rows).toHaveLength(50);
        expect(rows[0]).toContain('tail event 59');
        expect(rows[49]).toContain('tail event 10');
    });

    it('preserves newer live activity instead of rehydrating an unchanged carrier epoch after playback', async () => {
        const { MessageSpeakButton } = await import('./MessageSpeakButton');
        const { VoiceSurface } = await import('@/components/voice/surface/VoiceSurface');
        setup();
        setVoice(voiceSettingsParse({ ...localVoice, ui: { surfaceLocation: 'sidebar', activityFeedEnabled: true },
            adapters: { local_conversation: { tts: { provider: 'device' }, conversationMode: 'agent',
                agent: { transcript: { persistenceMode: 'persistent', epoch: 3 } } } } }));
        storage.setState({ sessions: { sys_voice: createSessionFixture({ id: 'sys_voice',
            metadata: { path: '/voice', host: 'test.local',
                systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } }) },
            sessionMessages: { sys_voice: createSessionMessagesFixture({ isLoaded: true }) } });
        const screen = await renderScreen(<>
            <MessageSpeakButton messageKey="carrier-message" text="hello" testID="speak" />
            <VoiceSurface variant="sidebar" />
            <VoiceSurface variant="global" />
        </>);
        await act(async () => {
            voiceActivityController.appendUserText(VOICE_AGENT_GLOBAL_SESSION_ID, 'local_conversation', 'new live activity');
            screen.pressByTestId('speak');
        });
        const stop = screen.findAllByType('Pressable').find(button => button.props.accessibilityLabel === 'message.stopReadAloudA11y')!;
        await act(async () => { stop.props.onPress(); });
        expect(useVoiceActivityStore.getState().eventsBySessionId[VOICE_AGENT_GLOBAL_SESSION_ID])
            .toEqual([expect.objectContaining({ text: 'new live activity' })]);
        await act(async () => {
            setVoice(voiceSettingsParse({ ...storage.getState().settings.voice,
                ui: { ...storage.getState().settings.voice.ui, activityFeedEnabled: false } }));
        });
        storage.setState({ sessionMessages: { sys_voice: createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: ['persisted-message'], messagesById: { 'persisted-message': {
                kind: 'user-text', id: 'persisted-message', localId: null, seq: 1, createdAt: 1, text: 'new persisted history',
                meta: { happier: { kind: 'voice_agent_turn.v1', payload: {
                    v: 1, epoch: 3, role: 'user', voiceAgentId: 'agent-1', ts: 1,
                } } },
            } },
        }) } });
        await act(async () => {
            setVoice(voiceSettingsParse({ ...storage.getState().settings.voice,
                ui: { ...storage.getState().settings.voice.ui, activityFeedEnabled: true } }));
        });
        expect(useVoiceActivityStore.getState().eventsBySessionId[VOICE_AGENT_GLOBAL_SESSION_ID])
            .toEqual([expect.objectContaining({ text: 'new persisted history' })]);
    });
});
