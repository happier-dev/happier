import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';

import type { Message } from '@happier-dev/session-core/messages';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';

import { VoiceSetupPanel, type VoiceSetupPanelActions, type VoiceSetupPanelModel } from './VoiceSetupPanel';
import { deriveVoiceSetupFacts } from './voiceSetupFacts';

const ready: VoiceRoleReadiness = {
    role: 'realtime_conversation', providerId: 'test.service', status: 'ready', code: 'ready',
    reasonKey: 'voice.readiness.ready', recoveryAction: 'none',
};
const meta = { happier: { kind: 'conversation_turn.v1', payload: { v: 1 },
    conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' } } } as const;
const turn: Message[] = [
    { kind: 'user-text', id: 'input', localId: null, seq: 1, createdAt: 10, text: 'hello', meta },
    { kind: 'agent-text', id: 'reply', localId: null, seq: 2, createdAt: 20, text: 'Hi', meta },
] as Message[];

/**
 * The open "Set up voice" block asks only for the current step and routes each press to its owner:
 * a step already true is never asked again, a denied microphone leads to system settings instead of
 * prompting again, Try waits for a ready service, and the done state closes through Done.
 */

function model(input: Readonly<{
    done: readonly [boolean, boolean, boolean, boolean];
    microphone?: 'granted' | 'denied' | 'unknown';
}>): VoiceSetupPanelModel {
    // m-core's real facts owner: the readiness fact is the only input the test chooses beyond the toggles.
    const facts = deriveVoiceSetupFacts({
        providerId: input.done[0] ? 'test.service' : null,
        readiness: input.done[1] ? ready : null,
        microphonePermission: input.done[2] ? 'granted' : input.microphone ?? 'unknown',
        messages: input.done[3] ? turn : [],
    });
    return {
        facts,
        serviceTitle: input.done[0] ? 'Service' : null,
        serviceTiles: [],
        readiness: null,
        tryLive: false,
        shortcutLabel: null,
    };
}

function actions(): VoiceSetupPanelActions & Readonly<{ [K in keyof VoiceSetupPanelActions]: ReturnType<typeof vi.fn> }> {
    return {
        onSelectService: vi.fn(),
        onRecover: vi.fn(),
        onAllowMicrophone: vi.fn(),
        onOpenSystemSettings: vi.fn(),
        onTry: vi.fn(),
        onDone: vi.fn(),
        onOpenSettings: vi.fn(),
        onClose: vi.fn(),
    } as never;
}

let screen: RenderScreenResult | null = null;
afterEach(async () => {
    await screen?.unmount();
    screen = null;
});

describe('VoiceSetupPanel', () => {
    it('asks only for the current step and never again for a step that is already true', async () => {
        const handlers = actions();
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, true, false, false] })} actions={handlers} />);

        expect(screen.findByTestId('voice-setup.step.readiness.recover')).toBeNull();
        expect(screen.findByTestId('voice-setup.step.first_turn.try')).toBeNull();
        expect(screen.findByTestId('setup.caption')).not.toBeNull();
        screen.pressByTestId('voice-setup.step.microphone.allow');
        expect(handlers.onAllowMicrophone).toHaveBeenCalledTimes(1);
        expect(handlers.onTry).not.toHaveBeenCalled();
    });

    it('leads a denied microphone to system settings instead of prompting again', async () => {
        const handlers = actions();
        screen = await renderScreen(
            <VoiceSetupPanel testID="setup" model={model({ done: [true, true, false, false], microphone: 'denied' })} actions={handlers} />,
        );

        expect(screen.findByTestId('voice-setup.step.microphone.allow')).toBeNull();
        screen.pressByTestId('voice-setup.step.microphone.openSettings');
        expect(handlers.onOpenSystemSettings).toHaveBeenCalledTimes(1);
        expect(handlers.onAllowMicrophone).not.toHaveBeenCalled();
    });

    it('sends a service that is not ready to its recovery and only then offers Try', async () => {
        const handlers = actions();
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, false, true, false] })} actions={handlers} />);
        expect(screen.findByTestId('voice-setup.step.first_turn.try')).toBeNull();
        screen.pressByTestId('voice-setup.step.readiness.recover');
        expect(handlers.onRecover).toHaveBeenCalledTimes(1);
        await screen.unmount();

        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, true, true, false] })} actions={handlers} />);
        screen.pressByTestId('voice-setup.step.first_turn.try');
        expect(handlers.onTry).toHaveBeenCalledTimes(1);
    });

    it('ends on the ready state, whose Done is the only way forward', async () => {
        const handlers = actions();
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, true, true, true] })} actions={handlers} />);

        expect(screen.findByTestId('setup.steps')).toBeNull();
        // One message per state: the title already says Voice is ready, so the planet carries no caption.
        expect(screen.findByTestId('setup.caption')).toBeNull();
        screen.pressByTestId('setup.done');
        expect(handlers.onDone).toHaveBeenCalledTimes(1);
    });
});
