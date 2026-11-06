import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';

import { VoiceGlance } from './VoiceGlance';

/**
 * The Voice section (Companion, popovers, sheet) renders the canonical surface model: Mute, the
 * barge-in Interrupt and End reach their own handlers, recovery replaces Mute only when offered,
 * and delegated work stays on its own channel instead of becoming the section's caption.
 */

function attempt(overrides: Partial<{ reconnecting: boolean }> = {}): VoiceAttemptControlProjection {
    const surfaceState = overrides.reconnecting ? 'reconnecting' as const : 'speaking' as const;
    const control = resolveVoiceAttemptControl({
        surfaceState,
        tone: overrides.reconnecting ? 'pending' : 'active',
        status: 'connected',
        sessionId: 'voice-1',
        canStop: true,
        muted: false,
        capturing: true,
        startAdmitted: true,
        hasRecovery: overrides.reconnecting === true,
    });
    return {
        ...control,
        statusWord: 'Speaking',
        statusLabel: 'Speaking',
        elapsedStartedAt: null,
        canHoldToTalk: false,
        beginHoldToTalk: () => null,
        openConversationSessionAddress: null,
        canOpenConversation: false,
        primaryActionLabel: 'End Voice',
        primaryActionHint: null,
        recoveryLabel: control.recoveryAvailable ? 'Retry' : null,
        recoveryIcon: control.recoveryAvailable ? 'arrow-clockwise' as const : null,
        micStateLabel: 'Microphone active',
        captionLabel: '',
        onPrimaryAction: vi.fn(),
        onToggle: vi.fn(),
        onToggleMute: vi.fn(),
        onRecover: vi.fn(),
        openConversationSessionId: null,
        onOpenConversation: vi.fn(),
    };
}

function surface(voice: VoiceAttemptControlProjection, overrides: Partial<VoiceSurfaceViewModel> = {}): VoiceSurfaceViewModel {
    return {
        attemptControl: voice,
        activityFeedEnabled: true,
        canBargeIn: true,
        canCancelTurn: false,
        canOpenConversation: false,
        canTeleportToSessionRoot: false,
        controlsDisabled: false,
        controlsLoading: false,
        delegatedWork: null,
        expanded: true,
        isMicCaptureActive: true,
        micStateLabel: 'Microphone active',
        mode: 'speaking',
        muteLabel: 'Mute microphone',
        providerLabel: 'OpenAI Realtime',
        startStopLabel: 'End Voice',
        status: 'connected',
        subtitle: null,
        targetLabel: null,
        toggleActivityLabel: 'Toggle voice activity',
        transcriptEntries: [],
        variant: 'sidebar',
        visibleTranscriptEntries: [],
        onBargeIn: vi.fn(),
        onCancelTurn: vi.fn(),
        onOpenConversation: vi.fn(),
        onTeleport: vi.fn(),
        onToggleExpanded: vi.fn(),
        ...overrides,
    };
}

let screen: RenderScreenResult | null = null;
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    vi.useRealTimers();
});

describe('VoiceGlance', () => {
    it('keeps the full failure caption readable and selectable', async () => {
        const detail = 'The selected speech provider could not start. Check the account key and its restrictions before trying again.';
        const voice = {
            ...attempt(),
            ...resolveVoiceAttemptControl({ surfaceState: 'error', tone: 'error', status: 'error',
                sessionId: 'voice-1', canStop: false, muted: false, capturing: false,
                startAdmitted: true, hasRecovery: true }),
            captionLabel: detail,
        };
        screen = await renderScreen(<VoiceGlance model={surface(voice, { canBargeIn: false })} presentation="companion" />);
        expect(screen.getTextContent()).toContain(detail);
        expect(screen.findAllByProps({ children: detail }).some(node =>
            node.props.selectable === true && node.props.numberOfLines === undefined,
        )).toBe(true);
    });

    it.each(['connecting', 'permission_required', 'error'] as const)('does not show a running-call clock in the %s header', async (surfaceState) => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(200_000);
        const control = resolveVoiceAttemptControl({
            surfaceState, tone: surfaceState === 'connecting' ? 'pending' : 'error',
            status: surfaceState === 'connecting' ? 'connecting' : 'error',
            sessionId: 'voice-1', canStop: surfaceState !== 'error', muted: false,
            capturing: false, startAdmitted: true, hasRecovery: surfaceState !== 'connecting',
        });
        const voice = { ...attempt(), ...control, elapsedStartedAt: 80_000 };
        screen = await renderScreen(<VoiceGlance model={surface(voice, { canBargeIn: false })} presentation="companion" />);
        expect(vi.getTimerCount()).toBe(0);
        expect(screen.getTextContent()).not.toContain('2:00');
    });

    describe('Speaks from', () => {
        const prepared = { serverId: 'home-a', sessionId: 'captain' };
        const speaksFrom = (name: string) => t('sessionVoice.speaksFrom', { name });
        const withCaptain = () => storage.getState().applySessions([createSessionFixture({
            id: 'captain', serverId: 'home-a',
            metadata: { path: '/w', host: 'h', summary: { text: 'Release captain', updatedAt: 1 } },
        })]);
        const bound = (preparedInstructionsFor: typeof prepared | null) => ({
            ...attempt(), targetSessionAddress: prepared, preparedInstructionsFor,
        });

        it('says whose instructions the call speaks from once they were prepared for this attempt', async () => {
            withCaptain();
            screen = await renderScreen(<VoiceGlance model={surface(bound(prepared))} presentation="companion" />);
            expect(screen.getTextContent()).toContain(speaksFrom('Release captain'));
            expect(screen.findHostByTestId('voice-glance-speaks-from')).toBeTruthy();
        });

        it('says nothing before preparation succeeded (or once the attempt is superseded), in global mode, or when the Session cannot be named', async () => {
            withCaptain();
            screen = await renderScreen(<VoiceGlance model={surface(bound(null))} presentation="companion" />);
            expect(screen.findHostByTestId('voice-glance-speaks-from')).toBeNull();
            await screen.unmount();
            screen = await renderScreen(<VoiceGlance model={surface(attempt())} presentation="companion" />);
            expect(screen.findHostByTestId('voice-glance-speaks-from')).toBeNull();
            await screen.unmount();
            screen = await renderScreen(<VoiceGlance
                model={surface({ ...bound(prepared), preparedInstructionsFor: { serverId: 'home-a', sessionId: 'unknown-session' } })}
                presentation="companion" />);
            expect(screen.findHostByTestId('voice-glance-speaks-from')).toBeNull();
        });
    });

    it('routes Mute, Interrupt and End to three different handlers', async () => {
        const voice = attempt();
        const model = surface(voice);
        screen = await renderScreen(<VoiceGlance model={model} presentation="companion" />);

        screen.pressByTestId('voice-glance-transport-mute');
        expect(voice.onToggleMute).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-glance-transport-interrupt');
        expect(model.onBargeIn).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-glance-transport-end');
        expect(voice.onToggle).toHaveBeenCalledTimes(1);
        expect(voice.onToggleMute).toHaveBeenCalledTimes(1);
    });

    it('keeps Mute named and pressable, icon-only only where the measured row is too narrow for labelled pills', async () => {
        const voice = attempt();
        const mutedLabel = t('voicePresence.mute');
        const measure = (width: number) => act(async () => {
            screen?.findByTestId('voice-glance-transport')?.props.onLayout({ nativeEvent: { layout: { width, height: 26 } } });
        });
        screen = await renderScreen(<VoiceGlance model={surface(voice, { canBargeIn: false })} presentation="companion" />);
        // The Companion assumes its narrow column before it has been measured.
        expect(screen.getTextContent()).not.toContain(mutedLabel);
        expect(screen.findByTestId('voice-glance-transport-mute')?.props.accessibilityLabel).toBeTruthy();
        expect(screen.getTextContent()).toContain(t('voicePresence.end'));
        screen.pressByTestId('voice-glance-transport-mute');
        expect(voice.onToggleMute).toHaveBeenCalledTimes(1);
        // The same row at phone width has room for the labelled pill; narrowed again, it steps back down.
        await measure(282);
        expect(screen.getTextContent()).toContain(mutedLabel);
        await measure(232);
        expect(screen.getTextContent()).not.toContain(mutedLabel);
        await screen.unmount();

        screen = await renderScreen(<VoiceGlance model={surface(voice, { canBargeIn: false })} presentation="popover" />);
        expect(screen.getTextContent()).toContain(mutedLabel);
        await measure(232);
        expect(screen.getTextContent()).not.toContain(mutedLabel);
    });

    it('offers the admitted recovery in Mute’s place while End stays reachable', async () => {
        const voice = attempt({ reconnecting: true });
        screen = await renderScreen(<VoiceGlance model={surface(voice, { canBargeIn: false })} presentation="popover" />);

        expect(screen.findByTestId('voice-glance-transport-mute')).toBeNull();
        screen.pressByTestId('voice-glance-transport-recover');
        expect(voice.onRecover).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-glance-transport-end');
        expect(voice.onToggle).toHaveBeenCalledTimes(1);
    });

    it.each(['popover', 'sheet'] as const)('offers a failed attempt its recovery and its dismissal in %s, as the transport does everywhere', async (presentation) => {
        const failed = resolveVoiceAttemptControl({ surfaceState: 'error', tone: 'error', status: 'error',
            sessionId: 'voice-1', canStop: false, muted: false, capturing: false, startAdmitted: true, hasRecovery: true });
        const voice = { ...attempt(), ...failed, recoveryLabel: 'Retry', canDismissFailedAttempt: true, onDismissFailedAttempt: vi.fn() };
        screen = await renderScreen(<VoiceGlance model={surface(voice, { canBargeIn: false })} presentation={presentation} />);
        expect(screen.findByTestId('voice-glance-transport-end')).toBeNull();
        screen.pressByTestId('voice-glance-transport-recover');
        expect(voice.onRecover).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-glance-transport-dismiss');
        expect(voice.onDismissFailedAttempt).toHaveBeenCalledTimes(1);
    });

    it.each(['companion', 'popover', 'sheet'] as const)('submits admitted buffered input separately from Mute and End in %s', async (presentation) => {
        const voice = { ...attempt(), canCommitInput: true, commitInputLabel: t('common.send'), onCommitInput: vi.fn(), muted: true };
        screen = await renderScreen(<VoiceGlance model={surface(voice, { canBargeIn: false })} presentation={presentation} />);
        screen.pressByTestId('voice-glance-transport-send');
        expect(voice.onCommitInput).toHaveBeenCalledTimes(1);
        expect(voice.onToggleMute).not.toHaveBeenCalled();
        expect(voice.onToggle).not.toHaveBeenCalled();
        await screen.unmount();
        screen = await renderScreen(<VoiceGlance model={surface({ ...voice, canCommitInput: false }, { canBargeIn: false })} presentation={presentation} />);
        expect(screen.findByTestId('voice-glance-transport-send')).toBeNull();
    });

    it('keeps delegated work on its own line rather than as the status caption', async () => {
        const voice = attempt();
        screen = await renderScreen(<VoiceGlance
            model={surface(voice, { delegatedWork: { sessionId: 'session-2', statusText: 'Codex is running yarn test relay', thinking: true } })}
            presentation="companion"
        />);

        expect(screen.findByTestId('voice-glance-handoff')).toBeTruthy();
        // The agent's status appears once — on its own line — never as the call's caption.
        expect(screen.getTextContent().split('Codex is running yarn test relay')).toHaveLength(2);
        expect(screen.getTextContent()).toContain(t('voicePresence.captions.speaking'));
        // The row names the work and says what it is doing in the shared working word (lab A).
        const row = screen.findByTestId('voice-glance-handoff');
        expect(row?.props.accessibilityLabel).toBe(`Codex is running yarn test relay, ${t('voiceSurface.delegatedWorking')}`);
    });

    it('turns into "Voice ended" after a clean End: back to the conversation, or talk again', async () => {
        const idle = resolveVoiceAttemptControl({
            surfaceState: 'idle', tone: 'neutral', status: 'disconnected', sessionId: null, canStop: false,
            muted: false, capturing: false, startAdmitted: true, hasRecovery: false,
        });
        const voice: VoiceAttemptControlProjection = {
            ...attempt(),
            ...idle,
            statusWord: 'Voice ended',
            canOpenConversation: true,
            ended: { sessionId: 'voice-1', adapterId: 'local_direct', startedAt: 1_000, endedAt: 253_000, reason: { kind: 'stopped' as const }, conversationSessionAddress: null, targetSessionAddress: null, transcriptMode: null, accountScope: null, conversationScope: null },
        };
        screen = await renderScreen(<VoiceGlance model={surface(voice, { canBargeIn: false })} presentation="companion" />);

        expect(screen.findByTestId('voice-glance-transport-end')).toBeNull();
        expect(screen.getTextContent()).toContain('4:12');
        screen.pressByTestId('voice-glance-open-conversation');
        expect(voice.onOpenConversation).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-glance-start-again');
        expect(voice.onPrimaryAction).toHaveBeenCalledTimes(1);
    });
});
