import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { t } from '@/text';
import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import type {
    VoiceSurfaceDelegatedWork,
    VoiceSurfaceViewModel,
} from '@/components/voice/surface/useVoiceSurfaceModel';

import { VoiceHorizon } from './VoiceHorizon';

/**
 * §8.2 — delegated work is its own channel, and Horizon is what makes it visible.
 *
 * The model has produced `delegatedWork` since the subtitle was narrowed to
 * target/error, but nothing rendered it: an agent-authored `display_status`
 * ("Codex is editing X") reached the surface and was dropped. These tests pin the
 * two channels rendering **at the same time** and staying distinct, because the
 * failure this replaces was exactly one flattened string carrying both.
 */

const SUBTITLE = 'Target session: Dashboard auth';
const STATUS_TEXT = 'Codex is editing AgentInput.tsx';
const DELEGATED_TEST_ID = 'voice-surface-delegated:sidebar';

function noop(): void {}

function buildAttemptControl(): VoiceAttemptControlProjection {
    return {
        availability: 'ready', live: true, canStart: false, canStop: true, canMute: true,
        muted: false, capturing: true, micStateLabel: 'Microphone active',
        captionLabel: 'Microphone active', primaryAction: 'end', primaryActionLabel: 'End Voice',
        primaryActionHint: 'End Voice', recoveryAvailable: false, recoveryLabel: null,
        surfaceState: 'listening', tone: 'active', stop: 'cool', sessionId: 'session-1',
        onToggle: noop, onToggleMute: noop, onRecover: noop, onPrimaryAction: noop,
        openConversationSessionId: null, onOpenConversation: noop,
    };
}

function buildModel(delegatedWork: VoiceSurfaceDelegatedWork | null): VoiceSurfaceViewModel {
    return {
        attemptControl: buildAttemptControl(),
        activityFeedEnabled: false,
        canBargeIn: false,
        canCancelTurn: false,
        canOpenConversation: false,
        canTeleportToSessionRoot: false,
        controlsDisabled: false,
        controlsLoading: false,
        delegatedWork,
        expanded: false,
        isMicCaptureActive: true,
        micStateLabel: 'Microphone active',
        mode: 'listening',
        muteLabel: 'Mute microphone',
        providerLabel: null,
        startStopLabel: 'End Voice',
        status: 'connected',
        subtitle: SUBTITLE,
        toggleActivityLabel: 'Toggle voice activity',
        transcriptEntries: [],
        variant: 'sidebar',
        visibleTranscriptEntries: [],
        onBargeIn: noop,
        onCancelTurn: noop,
        onOpenConversation: noop,
        onTeleport: noop,
        onToggleExpanded: noop,
    };
}

async function renderHorizon(delegatedWork: VoiceSurfaceDelegatedWork | null): Promise<RenderScreenResult> {
    return renderScreen(
        <VoiceEnergyProvider
            state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
            previewTimeMs={1_100}
        >
            <VoiceHorizon model={buildModel(delegatedWork)} />
        </VoiceEnergyProvider>,
    );
}

function readText(screen: RenderScreenResult, testID: string): string | null {
    const node = screen.findByTestId(testID);
    if (!node) return null;
    const children = node.props?.children;
    return typeof children === 'string' ? children : null;
}

describe('VoiceHorizon delegated work', () => {
    it('renders the agent-authored status beside the target label, not instead of it', async () => {
        const screen = await renderHorizon({
            sessionId: 'session-1',
            statusText: STATUS_TEXT,
            thinking: true,
        });

        // Both channels, at once, on different nodes. A presentation that folded
        // them back into one string passes neither half of this.
        expect(readText(screen, DELEGATED_TEST_ID)).toBe(STATUS_TEXT);
        expect(screen.root.findAll((node) => node.props?.children === SUBTITLE).length)
            .toBeGreaterThan(0);

        await screen.unmount();
    });

    it('says the delegated session is working when it is thinking with no authored status', async () => {
        const screen = await renderHorizon({
            sessionId: 'session-1',
            statusText: null,
            thinking: true,
        });

        expect(readText(screen, DELEGATED_TEST_ID)).toBe(t('voiceSurface.delegatedWorking'));

        await screen.unmount();
    });

    it('carries the delegated line into the status block’s accessible label', async () => {
        const screen = await renderHorizon({
            sessionId: 'session-1',
            statusText: STATUS_TEXT,
            thinking: true,
        });

        const statusBlock = screen.findByTestId('voice-surface-status-block:sidebar');
        expect(statusBlock?.props.accessibilityLabel).toContain(STATUS_TEXT);
        expect(statusBlock?.props.accessibilityLabel).toContain(SUBTITLE);

        await screen.unmount();
    });

    it('renders no delegated line when Voice has delegated nothing', async () => {
        const screen = await renderHorizon(null);

        expect(screen.findByTestId(DELEGATED_TEST_ID)).toBeNull();
        expect(screen.root.findAll((node) => node.props?.children === SUBTITLE).length)
            .toBeGreaterThan(0);

        await screen.unmount();
    });
});
