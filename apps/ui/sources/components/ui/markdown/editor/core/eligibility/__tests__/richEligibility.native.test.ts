import { describe, expect, it } from 'vitest';

import { resolveRichEligibility } from '../richEligibility.native';
import { resolveRichEligibility as resolveFromBase } from '../richEligibility';

const OPTS = { language: 'markdown', maxBytes: 256_000, htmlRoundTripMaxBytes: 50_000 } as const;

describe('resolveRichEligibility (native)', () => {
    it('admits clean markdown', () => {
        expect(resolveRichEligibility('# Clean native doc', OPTS)).toEqual({ eligible: true });
    });

    it('blocks HTML-containing markdown (no round-trip adapter on native)', () => {
        expect(resolveRichEligibility('# Doc\n\n<div>x</div> native', OPTS)).toEqual({
            eligible: false,
            reason: 'html-or-jsx',
        });
    });

    it('blocks .mdx via the language gate', () => {
        expect(resolveRichEligibility('# Doc native mdx', { ...OPTS, language: 'mdx' })).toEqual({
            eligible: false,
            reason: 'mdx',
        });
    });

    it('is re-exported unchanged from the base richEligibility module', () => {
        expect(resolveFromBase).toBe(resolveRichEligibility);
    });
});
