/** @vitest-environment jsdom */
import * as React from 'react';
import { View } from 'react-native';
import { makeMutable } from 'react-native-reanimated';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { hitAreaOverlap, readHitArea, type HitArea } from '@/dev/testkit/harness/hitFrameReach';
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
// Browser hardware, rather than viewport width, establishes the mobile-web touch floor.
vi.hoisted(() => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => ({
        matches: query === '(pointer: coarse)' || query === '(hover: none)',
        addEventListener() {}, removeEventListener() {},
    }) });
});
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
        status: phase === 'idle' || phase === 'failed' ? 'disconnected' : phase === 'connecting' ? 'connecting' : 'connected',
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
        recoveryIcon: control.recoveryAvailable ? 'arrow-clockwise' as const : null,
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

    /** Measures the drawn control once, as the layout would, and returns the hit area it then has around it. */
    async function hitAreaOf(testID: string): Promise<HitArea> {
        const frame = frameOf(screen!, testID);
        const drawn = { width: Number(frame.width), height: Number(frame.height) };
        await act(async () => {
            screen!.findHostByTestId(testID)!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: drawn.width, height: drawn.height } } });
        });
        return readHitArea(screen!.findHostByTestId(testID)!, drawn);
    }

    it.each([['ios', 44], ['android', 48], ['web', 44]] as const)('keeps the external-plugin touch transport at its design size with a non-overlapping enlarged %s hit area', async (os, floor) => {
        host.os = os;
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: os, colorScheme: 'light' }}>
            <VoiceTransport voice={projection('listening')} size="touch" />
        </HappierUiPlatformProvider>);
        const mute = await hitAreaOf('voice-transport-mute');
        const end = await hitAreaOf('voice-transport-end');
        for (const area of [mute, end]) {
            expect(area.drawn).toEqual({ width: 34, height: 34 });
            expect(area.height).toBe(floor);
            expect(area.width).toBeGreaterThan(area.drawn.width);
        }
        const gap = frameOf(screen, 'voice-transport').gap;
        expect(gap).toBe(8);
        expect(hitAreaOverlap(mute, end, { axis: 'horizontal', gap })).toBe(0);
    });

    it.each([['ios', 44], ['android', 48]] as const)('draws the native %s tablet mark at the pill and reaches the physical touch floor by hit area', async (os, floor) => {
        host.os = os;
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: os, colorScheme: 'light' }}>
            <AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}}
                trailing={<VoiceTopBarPresence voice={projection('listening')} />} />
        </HappierUiPlatformProvider>);
        const mark = await hitAreaOf('voice-top-bar-mark');
        expect(mark.drawn.width).toBe(28);
        expect(mark.drawn.height).toBe(28);
        // The label sits flush beside the mark, so the hit area grows above and below it only.
        expect(mark.height).toBe(floor);
        expect(mark.width).toBe(28);
    });

    it('keeps the resting top-bar mic out of the right rail below it: its hit area reaches the window edge above and stops 4 px under the 28 px mic', async () => {
        host.os = 'ios';
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <AppShellTitleStrip columnVisible columnToggleAvailable onToggleColumn={() => {}}
                trailing={<VoiceTopBarPresence voice={projection('idle')} />} />
        </HappierUiPlatformProvider>);
        const { insets: slop } = await hitAreaOf('voice-top-bar-rest');
        // The 40 px title strip leaves 6 px under the mic; the rail's first action keeps its own 2 px of it.
        expect({ top: slop.top, bottom: slop.bottom }).toEqual({ top: 6, bottom: 4 });
    });

    it('draws the composer Voice control and Island transport at their design size and reaches the 44 floor by hit area, the composer control stopping at its 2 px gap to Send', async () => {
        host.os = 'ios';
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <VoiceComposerPlanet pose="mic" muted={false} accessibilityLabel="Voice" accessibilityHint="Talk" onPress={() => {}} />
            <VoiceTransport voice={projection('listening')} size="island" />
        </HappierUiPlatformProvider>);
        for (const id of ['session-composer-voice', 'voice-transport-mute', 'voice-transport-end']) {
            const area = await hitAreaOf(id);
            expect(area.drawn.height, `${id} drawn height`).toBeLessThan(44);
            // The composer Voice control sits 2 px above Send, so its hit area reaches only 1 px of that gap.
            expect(area.height, `${id} hit height`).toBe(id === 'session-composer-voice' ? area.drawn.height + 2 : 44);
        }
    });

    it('keeps the Island mark slot at its design size under a finger and reaches the platform target by hit area, on the desktop and the phone Island alike', async () => {
        host.os = 'ios';
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        for (const phone of [false, true]) {
            screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <VoiceIsland voice={projection('listening')} phone={phone} width={330} anchorRef={React.createRef<View>()}
                    sectionOpen={false} onOpenSection={() => {}} shouldSuppressPress={() => false} />
            </HappierUiPlatformProvider>);
            const mark = await hitAreaOf('voice-island-mark');
            expect(mark.drawn, `phone=${phone} drawn slot`).toEqual({ width: 40, height: 40 });
            expect(mark.height, `phone=${phone} hit height`).toBe(44);
            const transport = await hitAreaOf('voice-island-transport-mute');
            expect(transport.drawn.height, `phone=${phone} transport drawn`).toBe(32);
            await screen.unmount();
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

    it('draws and announces the recovery with its one label', async () => {
        const voice = { ...projection('failed'), recoveryLabel: 'Set up', recoveryIcon: 'gear' as const };
        screen = await renderScreen(<VoiceTransport voice={voice} size="island" />);

        expect(screen.findByTestId('voice-transport-recover')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Set up');
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
    it('keeps the disconnected failure in its pill with recovery and dismissal', async () => {
        const voice = projection('failed');
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} />);

        expect(screen.findByTestId('voice-top-bar-rest')).toBeNull();
        expect(screen.findByTestId('voice-top-bar-transport-mute')).toBeNull();
        expect(screen.findByTestId('voice-top-bar-transport-end')).toBeNull();
        screen.pressByTestId('voice-top-bar-transport-recover');
        expect(voice.onRecover).toHaveBeenCalledOnce();
        screen.pressByTestId('voice-top-bar-transport-dismiss');
        expect(voice.onDismissFailedAttempt).toHaveBeenCalledOnce();
    });

    it('is a quiet microphone at rest that starts Voice', async () => {
        const voice = projection('idle');
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} />);

        expect(screen.findByTestId('voice-top-bar-mark')).toBeNull();
        screen.pressByTestId('voice-top-bar-rest');
        expect(voice.onPrimaryAction).toHaveBeenCalledTimes(1);
    });

    it('grows into the live pill whose mark ends and whose admitted presentation opens the section', async () => {
        const voice = projection('listening');
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} />);

        expect(screen.findByTestId('voice-top-bar-rest')).toBeNull();
        const { setVoiceGlanceOpen } = await import('./voiceCompanionSectionReveal');
        await act(async () => { setVoiceGlanceOpen(true); });
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

    it('opens its options chip toward the window centre from either side, pinned to one edge only', async () => {
        // On web the first branch's offsets become the chip's static class; a branch that leaves the
        // other edge unset keeps it, so a right-resting Orb opened its chip off-screen.
        for (const [x, near, far] of [[300, 'right', 'left'], [40, 'left', 'right']] as const) {
            await screen?.unmount();
            screen = await renderScreen(<VoiceOrb voice={projection('listening')} anchorRef={React.createRef<View>()}
                sectionOpen={false} onOpenSection={() => {}} shouldSuppressPress={() => false}
                translateX={makeMutable<number>(x)} hostWidth={400} />);
            const slot = frameOf(screen, 'voice-orb-options-slot');
            expect(typeof slot[near]).toBe('number');
            expect(slot[far]).toBe('auto');
        }
    });
});

describe('the ended conversation', () => {
    it('keeps a running call controllable alongside its separate read-aloud Stop', async () => {
        const voice = projection('listening');
        const stop = vi.fn();
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} readAloud={{ phase: 'speaking', stop }} />);
        expect(screen.findByTestId('voice-top-bar-read-aloud')).toBeNull();
        screen.pressByTestId('voice-top-bar-transport-read-aloud-stop');
        expect(stop).toHaveBeenCalledTimes(1);
        expect(voice.onPrimaryAction).not.toHaveBeenCalled();
        screen.pressByTestId('voice-top-bar-transport-end');
        expect(voice.onToggle).toHaveBeenCalledTimes(1);
    });

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

    it.each(['top_bar', 'island', 'orb'] as const)('keeps read-aloud and Stop reachable over retained ended and failed calls in %s', async (container) => {
        for (const retained of [ended(), projection('failed')]) {
            let phase: 'preparing' | 'speaking' | 'idle' = 'preparing';
            const stop = vi.fn(() => { phase = 'idle'; });
            const render = () => {
                const readAloud = { phase, stop };
                if (container === 'top_bar') return <VoiceTopBarPresence voice={retained} readAloud={readAloud} />;
                if (container === 'island') return <VoiceIsland voice={retained} readAloud={readAloud} phone width={358}
                    anchorRef={React.createRef()} sectionOpen={false} onOpenSection={() => {}} shouldSuppressPress={() => false} />;
                return <VoiceOrb voice={retained} readAloud={readAloud} anchorRef={React.createRef()}
                    sectionOpen={false} onOpenSection={() => {}} shouldSuppressPress={() => false}
                    translateX={makeMutable(0)} hostWidth={390} />;
            };
            screen = await renderScreen(render());
            expect(screen.getTextContent()).toContain(t('voicePresence.readAloud.preparing'));
            phase = 'speaking';
            await screen.update(render());
            expect(screen.getTextContent()).toContain(t('voicePresence.readAloud.speaking'));
            if (container === 'orb' && retained.canDismissFailedAttempt) {
                const body = screen.findByTestId('voice-orb-body')!;
                expect(body.props.accessibilityActions).toContainEqual({ name: 'activate', label: t('voicePresence.readAloud.stop') });
                await act(async () => { body.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }); });
            } else {
                screen.pressByTestId(container === 'orb' ? 'voice-orb-body'
                    : container === 'top_bar' ? 'voice-top-bar-read-aloud-stop' : 'voice-island-read-aloud-stop');
            }
            expect(stop).toHaveBeenCalledTimes(1);
            expect(retained.onPrimaryAction).not.toHaveBeenCalled();
            await screen.update(render());
            expect(screen.findByTestId('voice-read-aloud-status')).toBeNull();
            if (container !== 'orb') {
                const prefix = container === 'top_bar' ? 'voice-top-bar' : 'voice-island';
                screen.pressByTestId(`${prefix}-transport-dismiss`);
                expect(retained.ended ? retained.onDismissEnded : retained.onDismissFailedAttempt).toHaveBeenCalledTimes(1);
            } else {
                screen.pressByTestId('voice-orb-body');
                expect(retained.onPrimaryAction).toHaveBeenCalledTimes(1);
            }
            await screen.unmount();
            screen = null;
        }
    });
});

describe('the caption reveals the Companion section when it is on screen', () => {
    it('reveals the mounted section instead of opening a popover copy, and opens the popover otherwise', async () => {
        const { registerVoiceCompanionSection, setVoiceGlanceOpen } = await import('./voiceCompanionSectionReveal');
        const reveal = vi.fn(() => true);
        const unregister = registerVoiceCompanionSection(reveal);
        const voice = projection('listening');
        screen = await renderScreen(<VoiceTopBarPresence voice={voice} />);

        await act(async () => { setVoiceGlanceOpen(true); });
        expect(reveal).toHaveBeenCalledTimes(1);
        expect(screen.findAllByTestId('voice-top-bar-label').some((node) => node.props['aria-expanded'] === true)).toBe(false);

        unregister();
        await act(async () => { setVoiceGlanceOpen(true); });
        expect(reveal).toHaveBeenCalledTimes(1);
        expect(screen.findAllByTestId('voice-top-bar-label').some((node) => node.props['aria-expanded'] === true)).toBe(true);
        expect(voice.onPrimaryAction).not.toHaveBeenCalled();
    });
    it('opens the glance when the mounted Companion cannot reveal its transport', async () => {
        const { registerVoiceCompanionSection, setVoiceGlanceOpen } = await import('./voiceCompanionSectionReveal');
        const unregister = registerVoiceCompanionSection(() => false);
        try {
            screen = await renderScreen(<VoiceTopBarPresence voice={projection('listening')} />);
            await act(async () => { setVoiceGlanceOpen(true); });
            expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(true);
        } finally { unregister(); }
    });
});
