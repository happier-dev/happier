import { describe, expect, it, vi } from 'vitest';

import { setPreferredLanguageFromSettings, t } from '@/text';
import { ca } from '@/text/translations/ca';
import { en } from '@/text/translations/en';
import { es } from '@/text/translations/es';
import { fr } from '@/text/translations/fr';
import { it as itLocale } from '@/text/translations/it';
import { ja } from '@/text/translations/ja';
import { pl } from '@/text/translations/pl';
import { pt } from '@/text/translations/pt';
import { ru } from '@/text/translations/ru';
import { zhHans } from '@/text/translations/zh-Hans';
import { zhHant } from '@/text/translations/zh-Hant';

import {
    resolveAgentContinuationSubmitPresentation,
    resolveArmedComposerContinuation,
    resolveArmedSubmitContinuation,
} from './agentContinuationSubmitPresentation';

const pickerIconScale = vi.hoisted(() => vi.fn((_agentId: string) => 1));

// The per-Agent optical correction is owned by the Agent registry and is the
// thing under test here — that this control reuses it rather than boxing every
// mark at one nominal size.
vi.mock('@/agents/registry/registryUi', () => ({
    getAgentPickerIconScale: (agentId: string) => pickerIconScale(agentId),
}));

vi.mock('@/agents/registry/registryCore', () => ({
    isBundledAgentId: (value: unknown) => value !== 'not-in-this-build',
}));

describe('resolveAgentContinuationSubmitPresentation', () => {
    it('always names the switch in words, for every Agent', () => {
        // This is the control that commits the switch. A glyph reads as nothing
        // to a screen reader, so the accessible name is a sentence in every case.
        for (const agentId of ['claude', 'codex', 'kimi', 'auggie', 'customAcp', 'not-in-this-build']) {
            expect(resolveAgentContinuationSubmitPresentation({
                agentId,
                agentLabel: 'Target Agent',
            }).accessibilityLabel).toBe(
                t('session.agentContinuation.sendLabel', { agent: 'Target Agent' }),
            );
        }
    });

    it('draws every known Agent its own mark, with no per-Agent exception', () => {
        for (const agentId of ['claude', 'codex', 'kimi', 'kilo', 'auggie', 'customAcp']) {
            expect(resolveAgentContinuationSubmitPresentation({ agentId, agentLabel: 'X' }).markAgentId)
                .toBe(agentId);
        }
    });

    it('sizes the mark through the Agent registry, not a fixed box', () => {
        // A hardcoded size would pass a same-shape assertion, so the scale is
        // driven to values no nominal constant could produce.
        pickerIconScale.mockReturnValue(1.5);
        expect(resolveAgentContinuationSubmitPresentation({ agentId: 'kimi', agentLabel: 'Kimi' }).markSize)
            .toBe(27);
        expect(pickerIconScale).toHaveBeenLastCalledWith('kimi');

        pickerIconScale.mockReturnValue(0.8);
        expect(resolveAgentContinuationSubmitPresentation({ agentId: 'auggie', agentLabel: 'Auggie' }).markSize)
            .toBe(14);
    });

    it('has no mark to draw for an id this build does not know', () => {
        const presentation = resolveAgentContinuationSubmitPresentation({
            agentId: 'not-in-this-build',
            agentLabel: 'Unknown',
        });
        expect(presentation.markAgentId).toBeNull();
    });

    it('lifts the Agent’s name out of the drawn words and leaves the mark in its place', () => {
        const presentation = resolveAgentContinuationSubmitPresentation({
            agentId: 'claude',
            agentLabel: 'Claude',
        });
        const spoken = t('session.agentContinuation.sendLabel', { agent: 'Claude' });

        // The spoken sentence is untouched: this control commits an Agent switch,
        // and a glyph reads as nothing.
        expect(presentation.accessibilityLabel).toBe(spoken);
        // The drawn words are that SAME sentence with the name lifted out — the
        // button must not spell the Agent AND draw its mark.
        expect(presentation.label).not.toContain('Claude');
        // English closes the sentence with the Agent, so that is where the mark goes.
        expect(presentation.markPlacement).toBe('trailing');
        // Reassembling proves the mark stands exactly where the name stood, with
        // no words lost on either side of it.
        expect(`${presentation.label} Claude`).toBe(spoken);
    });

    it('keeps the words spelling the Agent when this build has no mark to draw', () => {
        // The name has to survive somewhere. An id this build cannot draw is the
        // one case where the words must still carry it.
        const presentation = resolveAgentContinuationSubmitPresentation({
            agentId: 'not-in-this-build',
            agentLabel: 'Unknown',
        });
        expect(presentation.markAgentId).toBeNull();
        expect(presentation.label).toBe(presentation.accessibilityLabel);
    });

    it('puts the Agent at one end of the sentence in every language the app ships', () => {
        // The armed control is a label and one mark, so the mark can only sit at
        // an end. Japanese already opens with the Agent where English closes with
        // it, and this is the assumption that shape rests on: a translation that
        // buried the name mid-sentence would need a third slot, and it should
        // fail here rather than silently reorder the button's words.
        const probe = '\u0000';
        const sentences: ReadonlyArray<readonly [string, string]> = [
            ['ca', ca.session.agentContinuation.sendLabel({ agent: probe })],
            ['en', en.session.agentContinuation.sendLabel({ agent: probe })],
            ['es', es.session.agentContinuation.sendLabel({ agent: probe })],
            ['fr', fr.session.agentContinuation.sendLabel({ agent: probe })],
            ['it', itLocale.session.agentContinuation.sendLabel({ agent: probe })],
            ['ja', ja.session.agentContinuation.sendLabel({ agent: probe })],
            ['pl', pl.session.agentContinuation.sendLabel({ agent: probe })],
            ['pt', pt.session.agentContinuation.sendLabel({ agent: probe })],
            ['ru', ru.session.agentContinuation.sendLabel({ agent: probe })],
            ['zh-Hans', zhHans.session.agentContinuation.sendLabel({ agent: probe })],
            ['zh-Hant', zhHant.session.agentContinuation.sendLabel({ agent: probe })],
        ];

        for (const [code, sentence] of sentences) {
            const parts = sentence.split(probe);
            expect(parts, code).toHaveLength(2);
            expect(
                parts[0]!.trim().length === 0 || parts[1]!.trim().length === 0,
                `${code}: "${sentence.replace(probe, '{agent}')}" puts the Agent mid-sentence`,
            ).toBe(true);
        }
    });

    it('opens with the mark in a language that opens with the Agent', () => {
        // Japanese reads "{Agent} で続ける" where English reads "Continue with
        // {Agent}". A mark pinned to the trailing side would put the verb before
        // its subject there, so the side is read off the sentence, never fixed.
        setPreferredLanguageFromSettings('ja');
        try {
            const presentation = resolveAgentContinuationSubmitPresentation({
                agentId: 'claude',
                agentLabel: 'Claude',
            });
            const spoken = t('session.agentContinuation.sendLabel', { agent: 'Claude' });

            expect(presentation.accessibilityLabel).toBe(spoken);
            expect(presentation.markPlacement).toBe('leading');
            expect(presentation.label).not.toContain('Claude');
            expect(`Claude ${presentation.label}`).toBe(spoken);
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });
});


describe('the armed target the chip and the submit control share', () => {
    const target = { agentId: 'codex', label: 'Codex' } as const;

    it('names the arm the moment it exists, with nothing typed', () => {
        // Selection IS the arming. Waiting for a keystroke is a confirm step made
        // of typing, and it is what left the chip naming the running Agent.
        expect(resolveArmedComposerContinuation({ armedContinuationTarget: target })).toBe(target);
    });

    it('has nothing to name when no switch is armed', () => {
        expect(resolveArmedComposerContinuation({ armedContinuationTarget: null })).toBeNull();
        expect(resolveArmedComposerContinuation({ armedContinuationTarget: undefined })).toBeNull();
    });

    it('lets the submit control name the same arm while that control is still the send', () => {
        // Including with nothing to send: an empty composer disables the send, it
        // does not turn it into a different control. This is the reported defect —
        // the button stayed a plain circle until a character was typed.
        expect(resolveArmedSubmitContinuation({
            armedContinuationTarget: target,
            otherActionHoldsSubmit: false,
        })).toBe(target);
    });

    it('silences the submit control while another action owns it', () => {
        // Dictation, the microphone and Stop all take this same button, and
        // "Continue with Codex" on any of them promises what press does not do.
        expect(resolveArmedSubmitContinuation({
            armedContinuationTarget: target,
            otherActionHoldsSubmit: true,
        })).toBeNull();
    });

    it('never lets the two surfaces name different Agents', () => {
        // The narrowing may only subtract. A second decision here is how a chip and
        // a button end up disagreeing about one choice.
        for (const otherActionHoldsSubmit of [false, true]) {
            for (const armedContinuationTarget of [target, null]) {
                const chip = resolveArmedComposerContinuation({ armedContinuationTarget });
                const button = resolveArmedSubmitContinuation({
                    armedContinuationTarget,
                    otherActionHoldsSubmit,
                });
                expect(button === null || button === chip).toBe(true);
            }
        }
    });
});
