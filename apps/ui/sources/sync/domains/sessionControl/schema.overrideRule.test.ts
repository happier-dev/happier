import { describe, expect, it } from 'vitest';

import { AgentModelOptionOverrideRuleSchema } from '@happier-dev/protocol/models/descriptor';

import { parseSessionModesState, SessionOptionOverrideRuleSchema } from './schema';

/**
 * The UI rule schema is the read side of a fact only the producing agent can author. If it accepts
 * a shape the producer contract forbids, the UI can hold an override rule that the strict
 * owner-metadata envelope will refuse to persist — state that can never round-trip.
 */
const CANDIDATE_RULES: readonly unknown[] = [
    { optionIds: ['reasoning_effort'], forcedValue: 'xhigh' },
    { optionIds: ['reasoning_effort'] },
    { optionIds: ['reasoning_effort', 'thinking'] },
    { optionIds: [] },
    { optionIds: ['   '] },
    { optionIds: ['a'.repeat(129)] },
    { optionIds: ['reasoning_effort'], forcedValue: '' },
    { optionIds: 'reasoning_effort' },
    { forcedValue: 'xhigh' },
    {},
    null,
    'reasoning_effort',
];

describe('SessionOptionOverrideRuleSchema', () => {
    it('reads retained V1 and V2 mode catalogs while validating known modes', () => {
        const mode = { id: 'review', name: 'Review' };
        const catalog = { agentId: 'codex', updatedAt: 1, availableModes: [{ ...mode, retired: { enabled: true } }], retired: true };
        expect(parseSessionModesState({ ...catalog, v: 1, currentModeId: 'review' })).toEqual({
            v: 2, agentId: 'codex', updatedAt: 1, currentModeId: 'review', availableModes: [mode],
        });
        expect(parseSessionModesState({ ...catalog, v: 2, currentModeId: null })).toEqual({
            v: 2, agentId: 'codex', updatedAt: 1, currentModeId: null, availableModes: [mode],
        });
        expect(parseSessionModesState({ ...catalog, v: 2, currentModeId: null, availableModes: [{ id: '', name: 'Review' }] })).toBeNull();
    });
    it('agrees with the canonical producer contract on every candidate rule shape', () => {
        for (const candidate of CANDIDATE_RULES) {
            const canonical = AgentModelOptionOverrideRuleSchema.safeParse(candidate);
            const ui = SessionOptionOverrideRuleSchema.safeParse(candidate);
            expect(ui.success, `acceptance disagreed for ${JSON.stringify(candidate)}`)
                .toBe(canonical.success);
            if (canonical.success && ui.success) {
                expect(ui.data).toEqual(canonical.data);
            }
        }
    });

    it('strips an unrecognized producer field instead of rejecting the whole rule', () => {
        // Deliberate and documented divergence: this schema sits inside persisted session metadata
        // on the READ side. The canonical envelope is strict because a producer must not write an
        // undeclared field; an older client reading a newer producer's rule must degrade to the
        // fields it knows rather than failing the entire metadata parse.
        expect(AgentModelOptionOverrideRuleSchema.safeParse({
            optionIds: ['reasoning_effort'],
            futureProducerField: 1,
        }).success).toBe(false);

        const parsed = SessionOptionOverrideRuleSchema.safeParse({
            optionIds: ['reasoning_effort'],
            futureProducerField: 1,
        });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data).toEqual({ optionIds: ['reasoning_effort'] });
    });
});
