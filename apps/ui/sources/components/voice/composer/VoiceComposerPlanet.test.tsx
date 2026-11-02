import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';
import { VoiceEnergyProvider, type VoiceEnergyState } from '@/components/voice/light/useVoiceEnergy';
import { HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { voiceRuntimeLevelStore, type VoiceRuntimeLevelWriter } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import { VoiceComposerPlanet } from './VoiceComposerPlanet';
import { installVoiceWebRtcBrowserBoundary } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionFixture } from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createRecipientContractDigestV1 } from '@happier-dev/protocol';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { saveAndUseAccountVoiceCredential, applyAccountVoiceCredentialSourceSelection } from '@/voice/credentials/accountVoiceCredential';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } from '@/voice/registry/bundledConversationRuntimeHost';
import { createExternalVoiceProviderActivationScope } from '@/voice/registry/externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { buildVoiceTranscriptHistorySessionMetadata } from '@/voice/persistence/voiceTranscriptHistorySession';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => {
    // These press-frame and held-gesture cases model a touch web host. Browser
    // hardware must exist before the composer reads its static target floor.
    vi.stubGlobal('navigator', { maxTouchPoints: 1, language: 'en-US', languages: ['en-US'] });
    return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock();
});
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vi.fn(async () => undefined) } }));
await loadSyncSingletonForTests();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LISTENING: VoiceEnergyState = { luminosity: 0.62, energized: true, direction: 'inward' };
const TEST_ID = 'session-composer-voice';

/** Module-level so a parent re-render passes the *same* handler identity. */
const onPress = vi.fn();

/**
 * The composer's Voice control (VE-02): the dot microphone at rest, the planet while live, before
 * Send. It is drawn compact but pressed through a real platform-size frame, it asks the shared
 * energy clock to run only while a conversation is live, and it never re-renders with the composer.
 */
describe('VoiceComposerPlanet', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    let input: VoiceRuntimeLevelWriter | null = null;

    beforeEach(() => {
        setReducedMotionPreferenceOverride(false);
        resetReanimatedFrameCallbacks();
        onPress.mockClear();
        // Real microphone audio at the level store, so only consumer presence decides the clock.
        input = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'composer-mark-test' });
        input.write(1);
    });

    afterEach(() => {
        act(() => {
            tree?.unmount();
            input?.close();
        });
        tree = null;
        input = null;
        setReducedMotionPreferenceOverride(null);
    });

    function scene(
        overrides: Partial<React.ComponentProps<typeof VoiceComposerPlanet>> = {},
        options: Readonly<{ mounted?: boolean }> = {},
    ): React.ReactElement {
        const { mounted = true } = options;
        return (
            <VoiceEnergyProvider
                state={LISTENING}
                activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
            >
                {mounted ? (
                    <VoiceComposerPlanet
                        pose="ready"
                        muted={false}
                        accessibilityLabel="End Voice"
                        accessibilityHint="Ends the spoken conversation. Coding work already started keeps running."
                        onPress={onPress}
                        {...overrides}
                    />
                ) : null}
            </VoiceEnergyProvider>
        );
    }

    function render(node: React.ReactElement): void {
        act(() => {
            tree = renderer.create(node);
        });
    }

    function update(node: React.ReactElement): void {
        act(() => {
            tree!.update(node);
        });
    }

    /** The rendered press target, not the composite that produced it. */
    function control(): ReactTestInstance {
        const hosts = tree!.root.findAll(
            (node) => typeof node.type === 'string' && node.props?.testID === TEST_ID,
        );
        expect(hosts).toHaveLength(1);
        return hosts[0]!;
    }

    it('draws at its slot and reaches the finger target by hit area, stopping at its 8 px gap to Send', async () => {
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        render(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>{scene()}</HappierUiPlatformProvider>);

        const targetSize = HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE;
        const area = readHitArea(control());
        expect(area.drawn.width).toBeLessThan(targetSize);
        expect(area.drawn.height).toBeLessThan(targetSize);
        // Stacked above Send 2 px apart it reaches 1 px of that gap; sideways only half the row's 8 px gap,
        // so it never overlaps Send's own hit area.
        expect(area.insets.top).toBe(1);
        expect(area.insets.bottom).toBe(1);
        expect(area.insets.left).toBe(4);
        expect(area.insets.right).toBe(4);
    });

    it('asks the shared energy clock to run only while the planet is live', () => {
        render(scene({ pose: 'mic' }));
        const activations = (): readonly boolean[] => readReanimatedFrameCallbacks()[0]?.setActiveCalls ?? [];
        // At rest the microphone is still art: it never registers as an energy consumer.
        expect(activations().includes(true)).toBe(false);

        update(scene({ pose: 'ready' }));
        expect(activations().at(-1)).toBe(true);

        update(scene({ pose: 'mic' }));
        expect(activations().at(-1)).toBe(false);
    });

    it('does not re-render when the composer around it does', () => {
        render(scene());
        const before = control().props;

        // The composer body re-renders on every keystroke; a leaf over primitives and one stable
        // handler must keep the same element (§16.2).
        update(scene());
        expect(control().props).toBe(before);
    });

    it('carries the caller’s label and hint, and routes the press out', async () => {
        render(scene());

        const target = control();
        expect(target.props.accessibilityLabel).toBe('End Voice');
        expect(target.props.accessibilityHint)
            .toBe('Ends the spoken conversation. Coding work already started keeps running.');

        await act(async () => {
            target.props.onClick?.({}) ?? target.props.onPress?.();
        });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it.each(['release', 'jitter', 'drag', 'cancel', 'blur', 'background'] as const)('admits a held turn through the real input owner (%s)', async (outcome) => {
        const initialStorage = storage.getState();
        const previousBinding = voiceSessionBindingStore.getState().getByConversationSessionId('composer-hold-history');
        const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.declaration.id === 'realtime-openai')!;
        const recipient = createBundledVoiceRecipientContract({ pluginId: entry.pluginId, declaration: entry.declaration });
        if (!recipient) throw new Error('OpenAI recipient contract is missing');
        // Manual input is produced by the shipped settings/preparation leaf;
        // neither inputCommitRequired nor the controller's capabilities are overridden.
        const voice = voiceSettingsParse({ providerId: entry.providerId, welcome: { enabled: false }, providers: {
            [entry.providerId]: { schemaVersion: 1, config: { ...OPENAI_REALTIME_DEFAULT_SETTINGS, turnDetection: 'manual' } },
        } });
        const saved = saveAndUseAccountVoiceCredential({ settings: settingsParse({ voiceSettingsV1: voice }),
            contribution: { pluginId: entry.pluginId, localId: entry.declaration.id }, credentialSlotId: recipient.credentialSlot.id,
            expectedSettingsVersion: 1, currentDeclaration: entry.declaration, value: 'sk_composer_hold', generateId: () => 'composer-hold-secret', now: 1,
            expectedSecretId: null, expectedSecretUpdatedAt: null, approvedRecipientContractDigest: createRecipientContractDigestV1(recipient) });
        const selected = applyAccountVoiceCredentialSourceSelection({ settings: saved.settings, connectedPurposes: { v: 1, bindings: [] }, currentDeclaration: entry.declaration,
            mutation: { contribution: { pluginId: entry.pluginId, localId: entry.declaration.id }, credentialSlotId: recipient.credentialSlot.id, expectedSettingsVersion: 1, selection: { kind: 'savedSecret' } } });
        const account = await createVoiceSettingsAccountTestHarness(selected.settings);
        const request = account.request.getMockImplementation()!;
        const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
        account.request.mockImplementation(async (url, init) => {
            if (new URL(String(url)).pathname.startsWith('/v1/features')) return request(url, init);
            const preparation = answerVoiceRealtimePreparationHttpRequest(url, storage.getState().settings);
            if (preparation) return preparation;
            const sessionResponse = sessionHttp.handle(url, init);
            return sessionResponse ?? request(url, init);
        });
        storage.setState({ sessions: { 'composer-hold-history': createSessionFixture({ id: 'composer-hold-history', serverId: account.scope.serverId, encryptionMode: 'plain', active: false,
            metadata: { path: '/voice-history', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() } }) } });
        voiceSessionBindingStore.getState().bind({ adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: 'composer-hold-history', conversationSessionAddress: { serverId: account.scope.serverId, sessionId: 'composer-hold-history' },
            targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1 });
        const browser = installVoiceWebRtcBrowserBoundary();
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/realtime/client_secrets') return Response.json({ value: 'ek_composer_hold', expires_at: Math.floor(Date.now() / 1000) + 60,
                session: { type: 'realtime', object: 'realtime.session', id: 'composer-hold-provider', model: OPENAI_REALTIME_DEFAULT_SETTINGS.model.id } });
            if (path === '/v1/realtime/calls') return new Response('v=0\r\na=composer-hold-answer\r\n', { status: 201 });
            throw new Error(`Unexpected provider HTTP request: ${path}`);
        }));
        voiceConversationRuntimeMachine.reset();
        const hostLease = createBundledConversationRuntimeHostLease();
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: entry.pluginId, occurrenceId: 'composer-openai-hold', declarations: [entry.declaration], hostPlatform: 'web',
            runtimeHost: { ...hostLease.host, createMicSession: () => browser.micSession },
            isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
            hostBindingsByLocalId: { [entry.declaration.id]: { recipientContract: recipient, descriptor: 'bundled' } },
        });
        const { loadBundledVoiceRuntimeActivate } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
        (await loadBundledVoiceRuntimeActivate(entry))(scope.api);
        await scope.commit();
        const adapter = getExternalVoiceProviderRegistration(entry.providerId)?.adapter;
        if (!adapter) throw new Error('OpenAI Voice adapter was not activated');
        const beginHoldToTalk = () => adapter.beginHoldToTalk?.({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID }) ?? null;
        try {
            const start = adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
            const peer = await browser.peerCreated();
            await peer.remoteDescriptionSet;
            expect(peer.setRemoteDescription).toHaveBeenCalled();
            browser.peer.channel.open();
            await start;
            expect(adapter.getSnapshot()).toMatchObject({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, status: 'connected', canHoldToTalk: true });
            await adapter.setMuted({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, muted: true });
            const firstHeldFrame = browser.peer.channel.sent.length;
            render(scene({ beginHoldToTalk }));
            await act(async () => { control().props.onLongPress(); });
            expect(browser.micTrack.enabled).toBe(true);
            const gesture = tree!.root.findAll((node) => typeof node.type === 'string'
                && node.props.testID === 'session-composer-voice-gesture')[0]!;
            if (outcome === 'background') await act(async () => {
                update(scene({ beginHoldToTalk, isActivelyFocused: false }));
            });
            await act(async () => {
                if (outcome === 'jitter') gesture.props.onTouchMove?.();
                if (outcome === 'drag') {
                    const onPressOut = tree!.root.findByType(IconButton).props.onPressOut;
                    if (!onPressOut) throw new Error('Expected the held Voice button to handle press-out');
                    onPressOut({ nativeEvent: { type: 'touchmove' } });
                }
                if (outcome === 'cancel') gesture.props.onTouchCancel();
                if (outcome === 'blur') {
                    const onFocusChange = tree!.root.findByType(IconButton).props.onFocusChange;
                    if (!onFocusChange) throw new Error('Expected the held Voice button to handle focus changes');
                    onFocusChange(false);
                }
                gesture.props.onTouchEnd();
                gesture.props.onPointerUp();
            });
            expect(browser.micTrack.enabled).toBe(false);
            // The same channel also carries the initial tool/session envelope;
            // assert the held turn's wire contract after that real preparation.
            const sent = browser.peer.channel.sent.slice(firstHeldFrame).map(value => JSON.parse(value) as unknown);
            expect(sent).toEqual(outcome === 'release' || outcome === 'jitter' ? [
                { type: 'input_audio_buffer.clear' }, { type: 'input_audio_buffer.commit' }, { type: 'response.create' },
            ] : [{ type: 'input_audio_buffer.clear' }, { type: 'input_audio_buffer.clear' }]);
            expect(onPress).not.toHaveBeenCalled();
        } finally {
            await adapter.stop({ sessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
            expect(voiceConversationRuntimeMachine.getSnapshot().state).toBe('disconnected');
            await scope.unwind();
            hostLease.revoke();
            voiceSessionBindingStore.getState().unbind('composer-hold-history');
            if (previousBinding) voiceSessionBindingStore.getState().bind(previousBinding);
            await account.dispose();
            storage.setState(initialStorage, true);
            browser.restore();
            voiceConversationRuntimeMachine.reset();
        }
    });
});
