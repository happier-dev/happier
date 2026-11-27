import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { t } from '@/text';
import { VoiceSetupTryPhrase } from './VoiceSetupTryPhrase';

let screen: RenderScreenResult | null = null;
afterEach(async () => { await screen?.unmount(); });

it('shows thinking before each reply, never beside that reply, and keeps settled status', async () => {
    const thinking = t('voiceAssistant.thinking');
    for (const turn of [
        { reply: null, phase: 'thinking', state: thinking, thinking: true },
        { reply: 'Nothing is actively working', phase: 'thinking', state: thinking, thinking: false },
        { reply: null, phase: 'thinking', state: thinking, thinking: true },
        { reply: 'Second answer', phase: 'listening', state: t('voiceAssistant.listening'), thinking: false },
    ] as const) {
        const element = <VoiceSetupTryPhrase testID="voice-setup.try" heard={{ kind: 'own', text: 'What are my sessions doing?' }}
            microphone={{ label: 'Microphone active', state: turn.state, phase: turn.phase }} reply={turn.reply} />;
        if (screen) await screen.update(element);
        else screen = await renderScreen(element);
        expect(screen.getTextContent().includes(thinking)).toBe(turn.thinking);
        if (turn.reply) expect(screen.getTextContent()).toContain(turn.reply);
        if (turn.phase === 'listening') expect(screen.getTextContent()).toContain(turn.state);
    }
});
