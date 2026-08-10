import { AGENT_ACTIVITY_STATUSES_V1, resolveAgentActivityTone } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';

import {
    resolveAgentActivityStatusWord,
    resolveAgentActivityToneStyle,
} from './agentActivityToneStyle';

/**
 * Tone -> ink is the single binding between the protocol vocabulary and the theme (4.5). The rule
 * it enforces is a *surface* rule, not a status rule: agent-row text sits on `Item`'s ordinary
 * surface, so it takes `state.X.foreground`. `state.X.onTint` exists only for text on a
 * `state.X.background` tint, i.e. `StatusPill chrome='pill'`. Reaching for `onTint` here would
 * create a second colour language for the same concept.
 */
describe('agentActivityToneStyle', () => {
    it('inks from state.*.foreground, never from the tint-only onTint role', () => {
        expect(resolveAgentActivityToneStyle('success', lightTheme).ink)
            .toBe(lightTheme.colors.state.success.foreground);
        expect(resolveAgentActivityToneStyle('danger', lightTheme).ink)
            .toBe(lightTheme.colors.state.danger.foreground);
        expect(resolveAgentActivityToneStyle('attention', lightTheme).ink)
            .toBe(lightTheme.colors.state.warning.foreground);

        const onTints = new Set(
            Object.values(lightTheme.colors.state).map((variant) => variant.onTint),
        );
        for (const status of AGENT_ACTIVITY_STATUSES_V1) {
            const { ink } = resolveAgentActivityToneStyle(resolveAgentActivityTone(status), lightTheme);
            expect(onTints.has(ink)).toBe(false);
        }
    });

    it('paints the live tone with state.active — the app\'s connecting hue, not informational indigo', () => {
        expect(resolveAgentActivityToneStyle('live', lightTheme).ink)
            .toBe(lightTheme.colors.state.active.foreground);
        expect(resolveAgentActivityToneStyle('live', lightTheme).ink)
            .not.toBe(lightTheme.colors.state.info.foreground);
    });

    it('never inks meaning with the banned text.tertiary', () => {
        for (const status of AGENT_ACTIVITY_STATUSES_V1) {
            const { ink } = resolveAgentActivityToneStyle(resolveAgentActivityTone(status), lightTheme);
            expect(ink).not.toBe(lightTheme.colors.text.tertiary);
        }
    });

    it('gives every status a distinct translated word so colour is never the only carrier', () => {
        const words = AGENT_ACTIVITY_STATUSES_V1.map(resolveAgentActivityStatusWord);

        for (const word of words) {
            expect(word.trim().length).toBeGreaterThan(0);
            // A raw enum leaking through is exactly defect A1; the words are sentence case.
            expect(AGENT_ACTIVITY_STATUSES_V1).not.toContain(word);
        }
        expect(new Set(words).size).toBe(AGENT_ACTIVITY_STATUSES_V1.length);
    });

    it('tells the two danger statuses apart, because their recovery differs', () => {
        expect(resolveAgentActivityStatusWord('failed'))
            .not.toBe(resolveAgentActivityStatusWord('timedOut'));
    });
});
