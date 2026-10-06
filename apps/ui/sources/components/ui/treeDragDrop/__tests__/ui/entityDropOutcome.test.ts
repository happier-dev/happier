import { describe, expect, it } from 'vitest';
import type { EntityDropAdmissionV1, EntityDropPreviewV1 } from '@happier-dev/protocol/plugins/ui';

import { describeEntityDropOutcome, describeEntityDropSettled } from '../../ui/entityDropOutcome';

const allowed = (actionId: string, glyph?: EntityDropPreviewV1['glyph'], verb = 'Verb'): EntityDropAdmissionV1 => ({
    status: 'allowed', effect: { actionId, input: {}, preview: { verb, target: 'Target', glyph } },
});

describe('Happier core outcome vocabulary (lab SYS verbs)', () => {
    it('honors declared core and plugin marks without reinterpreting their Action input', () => {
        for (const glyph of ['copy', 'move', 'board', 'below', 'split'] as const) {
            for (const actionId of ['session.reports_to.set', 'plugin.releases.link']) {
                expect(describeEntityDropOutcome({ phase: 'carrying', admission: allowed(actionId, glyph) })?.glyph).toBe(glyph);
            }
        }
        expect(describeEntityDropOutcome({ phase: 'carrying', admission: allowed('plugin.releases.link') })?.glyph).toBe('add');
    });

    it('treats every "nothing would change" code as a quiet Already here, never a refusal', () => {
        for (const code of ['no-change', 'same-position', 'board-no-change', 'workspace_tab_already_here']) {
            expect(describeEntityDropOutcome({ phase: 'carrying', admission: { status: 'refused', reason: { code, message: 'It’s already here' } } }))
                .toMatchObject({ tone: 'quiet', glyph: 'here' });
        }
    });

    it('names a late relation refusal by item and lead, and any other one by its verb', () => {
        const refused = { status: 'refused' as const, reason: { code: 'changed', message: 'This session was just moved. Try again' } };
        expect(describeEntityDropSettled({ phase: 'settled', admission: allowed('session.reports_to.set', 'nest'), outcome: refused }, 'Review #2481'))
            .toMatchObject({ kind: 'refused', title: 'Couldn’t put Review #2481 under Target', detail: 'This session was just moved. Try again' });
        expect(describeEntityDropSettled({ phase: 'settled', admission: allowed('todos.reorder', 'above', 'Move above Buy milk'), outcome: refused }))
            .toMatchObject({ kind: 'refused', title: 'Move above Buy milk didn’t go through' });
    });
});
