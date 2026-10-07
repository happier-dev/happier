/** @vitest-environment jsdom */
import * as React from 'react';
import { View } from 'react-native';
import { makeMutable } from 'react-native-reanimated';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import type { VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { t } from '@/text';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { projectCanonicalVoiceTranscriptEvent } from '@/voice/transcript/voiceConversationTranscript';

import { VoiceIsland } from './VoiceIsland';
import { VoiceOrb } from './VoiceOrb';
import { VoiceTopBarPresence } from './VoiceTopBarPresence';
import { VoiceTransport } from './VoiceTransport';
import { VoiceStatusLine } from './VoiceStatusLine';
import { VoiceComposerPlanet } from '../composer/VoiceComposerPlanet';
import { AppShellTitleStrip } from '@/components/navigation/shell/appRail/AppShellTitleStrip';

const host = vi.hoisted(() => ({ os: 'web' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const mock = await createReactNativeWebMock();
    return { ...mock, Platform: { ...mock.Platform, get OS() { return host.os; },
        select: (choices: Record<string, unknown>) => choices[host.os] ?? choices.default } };
});

/**
 * The presence containers draw the canonical attempt projection and route every press back to its
 * handlers (§4.1/§4.3): Mute and End stay separate, recovery takes Mute's place only when the
 * attempt actually offers one, the mark is always start/end, and a container's body opens the
 * Voice section rather than ending the call. Facts come from the real `resolveVoiceAttemptControl`.
 */

type Phase = 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'failed';

function projection(phase: Phase, overrides: Partial<{ muted: boolean }> = {}): VoiceAttemptControlProjection {
    const surfaceState: VoiceSurfaceState = phase === 'idle' ? 'idle' : phase === 'failed' ? 'error' : phase;
    const control = resolveVoiceAttemptControl({
        surfaceState,
        tone: resolveVoiceSurfaceStatusPresentation(surfaceState).tone,
        status: phase === 'idle' ? 'disconnected' : phase === 'connecting' ? 'connecting' : phase === 'failed' ? 'error' : 'connected',
        sessionId: phase === 'idle' ? null : 'voice-1',
        canStop: phase !== 'idle' && phase !== 'failed',
        muted: overrides.muted === true,
        capturing: phase === 'listening',
        startAdmitted: true,
        hasRecovery: phase === 'reconnecting' || phase === 'failed',
        canDismissFailedAttempt: phase === 'failed',
    });
    return {
        ...control,
        statusWord: surfaceState,
        statusLabel: surfaceState,
        elapsedStartedAt: null,
        canHoldToTalk: false,
        beginHoldToTalk: () => null,
        primaryActionLabel: control.primaryAction === 'end' ? 'End Voice' : 'Start Voice',
        primaryActionHint: null,
        recoveryLabel: control.recoveryAvailable ? 'Retry' : null,
        recoveryShortLabel: control.recoveryAvailable ? 'Retry' : null,
        micStateLabel: 'Microphone active',
        captionLabel: '',
        onPrimaryAction: vi.fn(),
        onToggle: vi.fn(),
        onToggleMute: vi.fn(),
        onRecover: vi.fn(),
        onDismissFailedAttempt: vi.fn(),
        openConversationSessionId: null,
        openConversationSessionAddress: null,
        canOpenConversation: false,
        onOpenConversation: vi.fn(),
    };
}

let screen: RenderScreenResult | null = null;
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    host.os = 'web';
});

function frameOf(screen: RenderScreenResult, testID: string) {
    const prop = screen.findByTestId(testID)?.props.style;
    const style = typeof prop === 'function' ? prop({ pressed: false, focused: false }) : prop;
    return Object.assign({}, ...(Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean));
}

describe('physical Voice targets', () => {
    it('keeps the native Orb options target inside its interactive container bounds', async () => {
        host.os = 'ios';
        screen = await renderScreen(<VoiceOrb voice={projection('listening')} anchorRef={React.createRef()}
            sectionOpen={false} onOpenSection={() => {}} shouldSuppressPress={() => false}
            translateX={makeMutable(320)} hostWidth={390} />);
        const slotWidth = frameOf(screen, 'voice-orb-options-slot').width;
        expect(frameOf(screen, 'voice-orb').width).toBeGreaterThanOrEqual(slotWidth + 44 + 8);
    });

    it.each([['ios', 44], ['android', 48]] as const)('gives the native %s tablet mark a physical touch floor', async (os, floor) => {
        host.os = os;
        screen = await renderScreen(<AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}}
            trailing={<VoiceTopBarPresence voice={projection('listening')} />} />);
        const frame = frameOf(screen, 'voice-top-bar-mark');
        expect(frame.width).toBeGreaterThanOrEqual(floor);
        expect(frame.height).toBeGreaterThanOrEqual(floor);
        expect(frameOf(screen, 'app-shell-title-strip').height).toBeGreaterThanOrEqual(floor);
    });

    it('keeps mobile-web composer and Island transport at their declared 44 square floor', async () => {
        screen = await renderScreen(<><VoiceComposerPlanet pose="mic" muted={false} accessibilityLabel="Voice" accessibilityHint="Talk" onPress={() => {}} />
            <VoiceTransport voice={projection('listening')} size="touch" /></>);
        for (const id of ['session-composer-voice', 'voice-transport-mute', 'voice-transport-end']) {
            const frame = frameOf(screen, id);
            expect(frame.width).toBeGreaterThanOrEqual(44);
            expect(frame.height).toBeGreaterThanOrEqual(44);
        }
    });
});

describe('VoiceTransport', () => {
    it('keeps Mute and End as two controls that reach two different handlers', async () => {
        const voice = projection('listening');
        screen = await renderScreen(<VoiceTransport voice={voice} size="island" />);

        screen.pressByTestId('voice-transport-mute');
        expect(voice.onToggleMute).toHaveBeenCalledTimes(1);
        expect(voice.onToggle).not.toHaveBeenCalled();

        screen.pressByTestId('voice-transport-end');
        expect(voice.onToggle).toHaveBeenCalledTimes(1);
        expect(voice.onToggleMute).toHaveBeenCalledTimes(1);
    });

    it('puts the admitted recovery in Mute’s place and keeps End while the call can still be ended', async () => {
        const voice = projection('reconnecting');
        screen = await renderScreen(<VoiceTransport voice={voice} size="island" />);

        expect(screen.findByTestId('voice-transport-mute')).toBeNull();
        screen.pressByTestId('voice-transport-recover');
        expect(voice.onRecover).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-transport-end');
        expect(voice.onToggle).toHaveBeenCalledTimes(1);
    });

    it('draws the short recovery verb while keeping the full recovery as its accessible name', async () => {
        const voice = { ...projection('failed'), recoveryLabel: 'Open Settings', recoveryShortLabel: 'Set up' };
        screen = await renderScreen(<VoiceTransport voice={voice} size="island" />);

        const recover = screen.findByTestId('voice-transport-recover');
        expect(recover?.props.accessibilityLabel).toBe('Open Settings');
        expect(screen.getTextContent()).toContain('Set up');
        expect(screen.getTextContent()).not.toContain('Open Settings');
    });

    it('pairs recovery with dismissal for a failed attempt with no ended record', async () => {
        const voice = projection('failed');
        screen = await renderScreen(<VoiceTransport voice={voice} size="pill" />);

        expect(screen.findByTestId('voice-transport-mute')).toBeNull();
        expect(screen.findByTestId('voice-transport-end')).toBeNull();
        screen.pressByTestId('voice-transport-recover');
        expect(voice.onRecover).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-transport-dismiss');
        expect(voice.onDismissFailedAttempt).toHaveBeenCalledTimes(1);
        expect(voice.ended).toBeUndefined();
    });
});

describe('VoiceStatusLine', () => {
    it('keeps the canonical attention status in every compact container accessible name', async () => {
        const voice = { ...projection('listening'), statusWord: 'Needs you', statusLabel: 'Approval required', statusCell: 'needs_you' as const };
        const anchor = React.createRef<View>();
        screen = await renderScreen(<>
            <VoiceTopBarPresence voice={voice} />
            <VoiceIsland voice={voice} phone={false} width={330} anchorRef={anchor} sectionOpen={false}
                onOpenSection={() => {}} shouldSuppressPress={() => false} />
            <VoiceOrb voice={voice} anchorRef={anchor} sectionOpen={false} onOpenSection={() => {}}
                shouldSuppressPress={() => false} translateX={makeMutable(300)} hostWidth={400} />
        </>);
        for (const id of ['voice-top-bar-label', 'voice-island-body', 'voice-orb-body']) {
            expect(screen.findByTestId(id)?.props.accessibilityLabel).toBe(t('voicePresence.containerA11y', { status: voice.statusLabel }));
        }
    });

    it('exposes the full accessible status while rendering its compact word', async () => {
        const voice = { ...projection('failed'), statusWord: 'Blocked', statusLabel: 'Microphone permission is required' };
        screen = await renderScreen(<VoiceStatusLine voice={voice} size="island" />);
        const status = screen.findByTestId('voice-status-line')?.findAll((node) => node.props.accessibilityLabel === voice.statusLabel);
        expect(status?.length).toBeGreaterThan(0);
        expect(status?.some((node) => node.props.children === voice.statusWord)).toBe(true);
    });

    it('runs the clock only while a conversation is underway, never while opening, blocked or failed', async () => {
        const startedAt = Date.now() - 134_000;
        const clocked = () => /\d:\d\d/.test(screen?.getTextContent() ?? '');
        for (const [phase, expected] of [['listening', true], ['reconnecting', true], ['connecting', false], ['failed', false]] as const) {
            screen = await renderScreen(<VoiceStatusLine voice={{ ...projection(phase), elapsedStartedAt: startedAt }} size="island" />);
            expect([phase, clocked()]).toEqual([phase, expected]);
            await screen.unmount();
            screen = null;
        }
        screen = await renderScreen(<VoiceStatusLine voice={{ ...projection('listening'), surfaceState: 'permission_required', tone: 'error', elapsedStartedAt: startedAt }} size="island" />);
        expect(clocked()).toBe(false);
    });

    it('reads the shared session status word instead of replacing work with the listening phase', async () => {
        const voice = { ...projection('listening'), statusWord: 'Working', statusLabel: 'Working', statusCell: 'working' as const };
        screen = await renderScreen(<VoiceStatusLine voice={voice} size="pill" />);
        const texts = screen.findByTestId('voice-status-line')?.findAll((node) => typeof node.props.children === 'string')
            .map((node) => node.props.children);
        expect(texts).toContain('Working');
    });
});

describe('VoiceIsland', () => {
    function island(voice: VoiceAttemptControlProjection, suppress = false) {
        const anchor = React.createRef<View>();
        const onOpenSection = vi.fn();
        const element = (
            <VoiceIsland
                voice={voice}
                phone={false}
                width={330}
                anchorRef={anchor}
                sectionOpen={false}
                onOpenSection={onOpenSection}
                shouldSuppressPress={() => suppress}
            />
        );
        return { element, onOpenSection };
    }

    it('ends from the mark and opens the Voice section from its body', async () => {
        const voice = projection('listening');
        const { element, onOpenSection } = island(voice);
        screen = await renderScreen(element);

        screen.pressByTestId('voice-island-body');
        expect(onOpenSection).toHaveBeenCalledTimes(1);
        expect(voice.onPrimaryAction).not.toHaveBeenCalled();

        screen.pressByTestId('voice-island-mark');
        expect(voice.onPrimaryAction).toHaveBeenCalledTimes(1);
    });

    it('lets its quiet line say what the call needs before it repeats the last thing said', async () => {
        const store = getStorage();
        const settings = store.getState().settings;
        store.setState({ settings: { ...settings, voice: voiceSettingsParse({ providerId: 'local_conversation', ui: { activityFeedEnabled: true } }) } });
        voiceSessionBindingStore.getState().bind({
            adapterId: 'local_conversation', controlSessionId: 'voice-1', conversationSessionId: 'compact-container',
            conversationSessionAddress: { serverId: 'compact-server', sessionId: 'compact-container' },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt: 1,
        });
        projectCanonicalVoiceTranscriptEvent({ conversationSessionId: 'compact-container', event: {
            v: 1, epoch: 1, type: 'voice.transcript.updated', itemId: 'line', sequence: 1, revision: 1,
            eventId: 'compact-container-line', role: 'assistant', provenance: 'live', text: 'Two of five relay tests pass.',
        } });
        try {
            screen = await renderScreen(island(projection('listening')).element);
            expect(screen.getTextContent()).toContain('“Two of five relay tests pass.”');
            await screen.unmount();

            screen = await renderScreen(island(projection('listening', { muted: true })).element);
            expect(screen.getTextContent()).toContain(t('voicePresence.captions.muted'));
            expect(screen.getTextContent()).not.toContain('relay tests');
            await screen.unmount();

            screen = await renderScreen(island(projection('reconnecting')).element);
            expect(screen.getTextContent()).toContain(t('voicePresence.captions.reconnecting'));
            await screen.unmount();

            screen = await renderScreen(island(projection('connecting')).element);
            expect(screen.getTextContent()).toContain(t('voicePresence.captions.connecting'));
            await screen.unmount();

            // A failure names its reason; the stale last line would read as if the call were fine.
            const reason = 'OpenAI Realtime isn’t set up on this device';
            screen = await renderScreen(island({ ...projection('failed'), captionLabel: reason }).element);
            expect(screen.getTextContent()).toContain(reason);
            expect(screen.getTextContent()).not.toContain('relay tests');
            await screen.unmount();

            screen = await renderScreen(island({ ...projection('listening'), surfaceState: 'permission_required', tone: 'error', captionLabel: t('voicePresence.captions.blocked') }).element);
            expect(screen.getTextContent()).toContain(t('voicePresence.captions.blocked'));
            expect(screen.getTextContent()).not.toContain('relay tests');
        } finally {
            await screen?.unmount();
            screen = null;
            voiceSessionBindingStore.getState().unbind('compact-container');
            store.setState({ settings });
        }
    });

    it('keeps the newest words of a long line in view rather than its opening', async () => {
        const store = getStorage();
        const settings = store.getState().settings;
        store.setState({ settings: { ...settings, voice: voiceSettingsParse({ providerId: 'local_conversation', ui: { activityFeedEnabled: true } }) } });
        voiceSessionBindingStore.getState().bind({
            adapterId: 'local_conversation', controlSessionId: 'voice-1', conversationSessionId: 'compact-tail',
            conversationSessionAddress: { serverId: 'compact-server', sessionId: 'compact-tail' },
            lifetime: 'runtime_attempt', transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt: 1,
        });
        projectCanonicalVoiceTranscriptEvent({ conversationSessionId: 'compact-tail', event: {
            v: 1, epoch: 1, type: 'voice.transcript.updated', itemId: 'line', sequence: 1, revision: 1,
            eventId: 'compact-tail-line', role: 'assistant', provenance: 'live',
            text: 'Codex finished the backoff. Two of five relay tests pass.',
        } });
        try {
            // Web has no head ellipsis: the line shows its latest sentence, marked as a tail.
            screen = await renderScreen(island(projection('listening')).element);
            expect(screen.getTextContent()).toContain('“…Two of five relay tests pass.”');
            expect(screen.getTextContent()).not.toContain('Codex finished');
            await screen.unmount();

            // Native ellipsizes the head of the whole line instead.
            host.os = 'ios';
            screen = await renderScreen(island(projection('listening')).element);
            const line = screen.findByTestId('voice-compact-transcript');
            expect(line?.props.ellipsizeMode).toBe('head');
            expect(screen.getTextContent()).toContain('“Codex finished the backoff. Two of five relay tests pass.”');
        } finally {
            await screen?.unmount();
            screen = null;
            voiceSessionBindingStore.getState().unbind('compact-tail');
            store.setState({ settings });
        }
    });

    it('swallows the tap that ends a drag', async () => {
        const voice = projection('listening');
        const { element, onOpenSection } = island(voice, true);
        screen = await renderScreen(element);

        screen.pressByTestId('voice-island-mark');
        screen.pressByTestId('voice-island-body');
        expect(voice.onPrimaryAction).not.toHaveBeenCalled();
        expect(onOpenSection).not.toHaveBeenCalled();
    });
});

describe('VoiceTopBarPresence', () => {
    it('is a quiet microphone at rest that starts Voice', async () => {
        const voice = projection('idle');
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} />);

        expect(screen.findByTestId('voice-top-bar-mark')).toBeNull();
        screen.pressByTestId('voice-top-bar-rest');
        expect(voice.onPrimaryAction).toHaveBeenCalledTimes(1);
    });

    it('grows into the live pill whose mark ends and whose label opens the section', async () => {
        const voice = projection('listening');
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} />);

        expect(screen.findByTestId('voice-top-bar-rest')).toBeNull();
        await screen.pressByTestIdAsync('voice-top-bar-label');
        expect(voice.onPrimaryAction).not.toHaveBeenCalled();
        expect(screen.findAllByTestId('voice-top-bar-label').some((node) => node.props['aria-expanded'] === true)).toBe(true);

        screen.pressByTestId('voice-top-bar-mark');
        expect(voice.onPrimaryAction).toHaveBeenCalledTimes(1);
    });
});

describe('VoiceOrb', () => {
    function orb(voice: VoiceAttemptControlProjection) {
        const onOpenSection = vi.fn();
        const element = (
            <VoiceOrb
                voice={voice}
                anchorRef={React.createRef<View>()}
                sectionOpen={false}
                onOpenSection={onOpenSection}
                shouldSuppressPress={() => false}
                translateX={makeMutable(300)}
                hostWidth={400}
            />
        );
        return { element, onOpenSection };
    }

    it('stays at rest as the microphone and starts Voice on tap', async () => {
        const voice = projection('idle');
        const { element } = orb(voice);
        screen = await renderScreen(element);

        screen.pressByTestId('voice-orb-body');
        expect(voice.onPrimaryAction).toHaveBeenCalledTimes(1);
    });

    it('opens its options through an accessible action without ending the call', async () => {
        const voice = projection('listening');
        const { element, onOpenSection } = orb(voice);
        screen = await renderScreen(element);

        const body = screen.findByTestId('voice-orb-body');
        body?.props.onAccessibilityAction({ nativeEvent: { actionName: 'options' } });
        expect(onOpenSection).toHaveBeenCalledTimes(1);
        expect(voice.onPrimaryAction).not.toHaveBeenCalled();
    });

    it('keeps the live status in its options chip over time, independently of the primary tap', async () => {
        vi.useFakeTimers();
        try {
            const voice = projection('listening');
            const { element, onOpenSection } = orb(voice);
            screen = await renderScreen(element);
            await act(async () => { vi.advanceTimersByTime(4000); });
            // The chip keeps saying what the call is doing; it never swaps to a generic label.
            expect(screen.getTextContent()).toContain(voice.statusWord);
            expect(screen.getTextContent()).not.toContain(t('voicePresence.options'));
            expect(screen.findByTestId('voice-orb-options')?.props.accessibilityLabel).toBe(t('voicePresence.options'));
            screen.pressByTestId('voice-orb-options');
            expect(onOpenSection).toHaveBeenCalledOnce();
            expect(voice.onPrimaryAction).not.toHaveBeenCalled();
            screen.pressByTestId('voice-orb-body');
            expect(voice.onPrimaryAction).toHaveBeenCalledOnce();
        } finally { vi.useRealTimers(); }
    });
});

describe('the ended conversation', () => {
    function ended(): VoiceAttemptControlProjection {
        return {
            ...projection('idle'),
            ended: { sessionId: 'voice-1', adapterId: 'local_direct', startedAt: 1_000, endedAt: 253_000, reason: { kind: 'stopped' as const }, conversationSessionAddress: null, targetSessionAddress: null, transcriptMode: null, accountScope: null, conversationScope: null },
            statusWord: 'Voice ended',
            onDismissEnded: vi.fn(),
        };
    }

    it('keeps the top bar pill after a clean End, with its length, a way to talk again and a way to put it away', async () => {
        const voice = ended();
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} />);

        expect(screen.findByTestId('voice-top-bar-rest')).toBeNull();
        expect(screen.getTextContent()).toContain('Voice ended');
        expect(screen.getTextContent()).toContain('4:12');
        screen.pressByTestId('voice-top-bar-transport-dismiss');
        expect(voice.onDismissEnded).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-top-bar-mark');
        expect(voice.onPrimaryAction).toHaveBeenCalledTimes(1);
    });

    it('is the microphone at rest again once nothing has just ended', async () => {
        const voice = projection('idle');
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} />);
        expect(screen.findByTestId('voice-top-bar-rest')).toBeTruthy();
        expect(screen.findByTestId('voice-top-bar-label')).toBeNull();
    });
});

describe('the caption reveals the Companion section when it is on screen', () => {
    it('reveals the mounted section instead of opening a popover copy, and opens the popover otherwise', async () => {
        const { registerVoiceCompanionSection } = await import('./voiceCompanionSectionReveal');
        const reveal = vi.fn(() => true);
        const unregister = registerVoiceCompanionSection(reveal);
        const voice = projection('listening');
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} />);

        await screen.pressByTestIdAsync('voice-top-bar-label');
        expect(reveal).toHaveBeenCalledTimes(1);
        expect(screen.findAllByTestId('voice-top-bar-label').some((node) => node.props['aria-expanded'] === true)).toBe(false);

        unregister();
        await screen.pressByTestIdAsync('voice-top-bar-label');
        expect(reveal).toHaveBeenCalledTimes(1);
        expect(screen.findAllByTestId('voice-top-bar-label').some((node) => node.props['aria-expanded'] === true)).toBe(true);
        expect(voice.onPrimaryAction).not.toHaveBeenCalled();
    });
    it('opens the glance when the mounted Companion cannot reveal its transport', async () => {
        const { registerVoiceCompanionSection } = await import('./voiceCompanionSectionReveal');
        const unregister = registerVoiceCompanionSection(() => false);
        try {
            screen = await renderScreen(<VoiceTopBarPresence voice={projection('listening')} />);
            await screen.pressByTestIdAsync('voice-top-bar-label');
            expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(true);
        } finally { unregister(); }
    });
});
