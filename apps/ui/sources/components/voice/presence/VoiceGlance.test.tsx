import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
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
        recoveryShortLabel: control.recoveryAvailable ? 'Retry' : null,
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
});

describe('VoiceGlance', () => {
    it('routes Mute, Interrupt and End to three different handlers', async () => {
        const voice = attempt();
        const model = surface(voice);
        screen = await renderScreen(<VoiceGlance model={model} presentation="companion" />);

        screen.pressByTestId('voice-glance-mute');
        expect(voice.onToggleMute).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-glance-interrupt');
        expect(model.onBargeIn).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-glance-end');
        expect(voice.onToggle).toHaveBeenCalledTimes(1);
        expect(voice.onToggleMute).toHaveBeenCalledTimes(1);
    });

    it('offers the admitted recovery in Mute’s place while End stays reachable', async () => {
        const voice = attempt({ reconnecting: true });
        screen = await renderScreen(<VoiceGlance model={surface(voice, { canBargeIn: false })} presentation="popover" />);

        expect(screen.findByTestId('voice-glance-mute')).toBeNull();
        screen.pressByTestId('voice-glance-recover');
        expect(voice.onRecover).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-glance-end');
        expect(voice.onToggle).toHaveBeenCalledTimes(1);
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

        expect(screen.findByTestId('voice-glance-end')).toBeNull();
        expect(screen.getTextContent()).toContain('4:12');
        screen.pressByTestId('voice-glance-open-conversation');
        expect(voice.onOpenConversation).toHaveBeenCalledTimes(1);
        screen.pressByTestId('voice-glance-start-again');
        expect(voice.onPrimaryAction).toHaveBeenCalledTimes(1);
    });
});
