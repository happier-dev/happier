import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Text } from '@/components/ui/text/Text';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { t } from '@/text';

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
    microphone?: 'granted' | 'denied' | 'unavailable' | 'unknown';
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
        canStart: facts.canTry,
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
        expect(screen.findByTestId('voice-setup.step.first_turn.phrase')).toBeNull();
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

    it('marks a site-blocked microphone as needing you and checks again through the permission request', async () => {
        // A browser has no system settings to open: the producer passes no settings action.
        const handlers = { ...actions(), onOpenSystemSettings: null };
        screen = await renderScreen(
            <VoiceSetupPanel testID="setup" model={model({ done: [true, true, false, false], microphone: 'denied' })} actions={handlers} />,
        );

        // The blocked step is drawn in the rail's attention mood (lab TS: warning tone), not a neutral numeral.
        const rail = screen.find((node) => Array.isArray(node.props?.steps) && typeof node.props?.renderStateGlyph === 'function');
        expect(rail.props.steps.find((step: { key: string }) => step.key === 'microphone')?.state).toBe('waiting');
        const text = screen.getTextContent();
        expect(text).toContain(t('voiceMoments.setupMicrophoneDeniedDetailSite'));
        expect(text).not.toContain(t('voiceMoments.setupMicrophoneDeniedDetail'));
        screen.pressByTestId('voice-setup.step.microphone.checkAgain');
        expect(handlers.onAllowMicrophone).toHaveBeenCalledTimes(1);
    });

    it('says a missing microphone plainly and checks again on press, instead of an Allow that does nothing', async () => {
        const handlers = actions();
        const facts = model({ done: [true, true, false, false], microphone: 'unavailable' });
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={facts} actions={handlers} />);

        expect(facts.facts.steps.find((step) => step.id === 'microphone')?.state).toBe('blocked');
        expect(screen.getTextContent()).toContain(t('voiceMoments.setupMicrophoneMissingTitle'));
        expect(screen.findByTestId('voice-setup.step.microphone.allow')).toBeNull();
        expect(screen.findByTestId('voice-setup.step.microphone.openSettings')).toBeNull();
        screen.pressByTestId('voice-setup.step.microphone.checkAgain');
        expect(handlers.onAllowMicrophone).toHaveBeenCalledTimes(1);
    });

    it('sends a service that is not ready to its recovery and only then offers Try', async () => {
        const handlers = actions();
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, false, true, false] })} actions={handlers} />);
        expect(screen.findByTestId('voice-setup.step.first_turn.phrase')).toBeNull();
        screen.pressByTestId('voice-setup.step.readiness.recover');
        expect(handlers.onRecover).toHaveBeenCalledTimes(1);
        await screen.unmount();

        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, true, true, false] })} actions={handlers} />);
        // The phrase card is the action: one press target, no second "Try it" beside the step's title.
        screen.pressByTestId('voice-setup.step.first_turn.phrase');
        expect(handlers.onTry).toHaveBeenCalledTimes(1);
    });

    it('names where the speech models live once the service is ready on a machine', async () => {
        const facts = { ...model({ done: [true, true, false, false] }), speechModelsMachine: 'devbox' };
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={facts} actions={actions()} />);

        expect(screen.getTextContent()).toContain(t('voiceMoments.setupReadinessDoneOnMachine', { machine: 'devbox' }));
        expect(screen.getTextContent()).not.toContain(t('voiceMoments.setupReadinessDone'));
    });

    it('can be left at every step with Not now, and the ready state closes through Done instead', async () => {
        const handlers = actions();
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [false, false, false, false] })} actions={handlers} />);
        screen.pressByTestId('setup.notNow');
        expect(handlers.onClose).toHaveBeenCalledTimes(1);
        await screen.unmount();

        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, true, true, true] })} actions={handlers} />);
        expect(screen.findByTestId('setup.notNow')).toBeNull();
    });

    it('ends on the ready state, whose Done is the only way forward', async () => {
        const handlers = actions();
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, true, true, true] })} actions={handlers} />);

        expect(screen.findByTestId('setup.steps')).toBeNull();
        screen.pressByTestId('setup.done');
        expect(handlers.onDone).toHaveBeenCalledTimes(1);
    });

    it('offers the phrase to say before Try, with nothing lit until it is really heard', async () => {
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, true, true, false] })} actions={actions()} />);

        expect(screen.findByTestId('voice-setup.step.first_turn.phrase')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('voiceMoments.setupTryPhrase'));
        expect(screen.findByTestId('voice-setup.step.first_turn.phrase.heard')).toBeNull();
    });

    it('stays on the Try step while the call runs, says the call is already the conversation, and is ready only once it ends', async () => {
        const handlers = actions();
        // The first reply completes setup while the call is still live (lab T1): no "Voice is ready" over a live call.
        const live = { ...model({ done: [true, true, true, true] }), tryLive: true };
        screen = await renderScreen(
            <VoiceSetupPanel testID="setup" model={live} actions={handlers} renderTry={<Text>live try</Text>} />,
        );
        expect(screen.getTextContent()).toContain('live try');
        expect(screen.getTextContent()).toContain(t('voiceMoments.setupTryTitle'));
        expect(screen.getTextContent()).not.toContain(t('voiceMoments.setupDoneTitle'));
        // Once talking, "Nothing is sent until you speak" is no longer true.
        expect(screen.getTextContent()).not.toContain(t('voiceMoments.setupFooterNote'));
        expect(screen.getTextContent()).toContain(t('voiceMoments.setupInCallNote'));
        expect(screen.findByTestId('setup.notNow')).toBeNull();
        screen.pressByTestId('setup.done');
        expect(handlers.onDone).toHaveBeenCalledTimes(1);
        await screen.unmount();

        // Before the first reply, Done only closes the card: the call goes on in the conversation.
        const talking = { ...model({ done: [true, true, true, false] }), tryLive: true };
        screen = await renderScreen(
            <VoiceSetupPanel testID="setup" model={talking} actions={handlers} renderTry={<Text>live try</Text>} />,
        );
        expect(screen.getTextContent()).toContain('live try');
        expect(screen.getTextContent()).not.toContain(t('voiceMoments.setupFooterNote'));
        screen.pressByTestId('setup.done');
        expect(handlers.onClose).toHaveBeenCalledTimes(1);
        expect(handlers.onDone).toHaveBeenCalledTimes(1);
        await screen.unmount();

        screen = await renderScreen(
            <VoiceSetupPanel testID="setup" model={model({ done: [true, true, true, true] })} actions={handlers} renderTry={<Text>live try</Text>} />,
        );
        expect(screen.getTextContent()).toContain(t('voiceMoments.setupDoneTitle'));
        expect(screen.getTextContent()).not.toContain('live try');
    });

    it('says how to start once: the ready description, not a repeated Tap chip', async () => {
        screen = await renderScreen(<VoiceSetupPanel testID="setup" model={model({ done: [true, true, true, true] })} actions={actions()} />);
        expect(screen.getTextContent()).toContain(t('voiceMoments.setupDoneBody'));
        expect(screen.getTextContent()).not.toContain(t('voiceMoments.setupGestureStartEnd'));
    });
});
