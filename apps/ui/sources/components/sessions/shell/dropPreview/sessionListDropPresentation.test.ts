import { describe, expect, it } from 'vitest';

import { describeEntityDropOutcome } from '@/components/ui/treeDragDrop/ui/entityDropOutcome';

import { describeSessionListDropReason, describeSessionListDropPreview, describeSessionListRefusedPutUnder, type SessionListDropTargetPreview } from './sessionListDropPresentation';
import { entityReorderPreview } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';

// The Session list words its previews and reasons; the one outcome presenter turns them into the card.
describe('Session-list verdicts through the one outcome presenter', () => {
    it('names the effect and its limit for an allowed relation drop', () => {
        const outcome = describeEntityDropOutcome({
            phase: 'carrying',
            admission: { status: 'allowed', effect: {
                actionId: 'session.manager.set',
                input: { sessionId: 'a', managerSessionId: 'b', expectedManagerSessionId: null },
                preview: describeSessionListDropPreview({ kind: 'put-under', leadName: 'Fix settings modal remount' }),
            } },
        });
        expect(outcome).toEqual({
            tone: 'allowed',
            glyph: 'nest',
            title: 'Put under Fix settings modal remount',
            detail: 'Reports to it · both keep running',
        });
    });

    it('words section filing in section terms: into a section it keeps running; back, it leaves its section (lab clsections:drag)', () => {
        const into = describeSessionListDropPreview({ kind: 'folder', folderName: 'Launch 0.3' });
        expect([into.verb, into.consequence]).toEqual(['Move to Launch 0.3', 'Keeps running where it is']);
        const back = describeSessionListDropPreview({ kind: 'project' });
        expect([back.verb, back.consequence]).toEqual(['Back to project', 'Leaves its section']);
    });

    it('marks a refusal as refused with the owner reason, never as the effect it would have had', () => {
        const outcome = describeEntityDropOutcome({
            phase: 'carrying',
            admission: { status: 'refused', reason: describeSessionListDropReason('read'),
                preview: describeSessionListRefusedPutUnder('Docs search index') },
        });
        expect(outcome?.tone).toBe('refused');
        expect(outcome?.title).toBe('Can’t put under Docs search index');
        expect(outcome?.detail).toBe(describeSessionListDropReason('read').message);
    });

    it('stays visibly uncommitted while a released relation waits for its owner', () => {
        const outcome = describeEntityDropOutcome({
            phase: 'pending',
            admission: { status: 'allowed', effect: {
                actionId: 'session.manager.set',
                input: {},
                preview: { verb: 'Put under Lead', target: 'Lead', consequence: 'Reports to it · both keep running' },
            } },
        });
        expect(outcome?.tone).toBe('pending');
        expect(outcome?.title).not.toBe('Put under Lead');
    });

    it('draws the order or folder mark for organization moves', () => {
        const cases: readonly [SessionListDropTargetPreview, string][] = [
            [{ kind: 'reorder', edge: 'above', siblingName: 'B' }, 'above'],
            [{ kind: 'reorder', edge: 'below', siblingName: 'B' }, 'below'],
            [{ kind: 'folder', folderName: 'Work' }, 'folder'], [{ kind: 'top-level' }, 'topLevel'],
        ];
        for (const [target, glyph] of cases) {
            expect(describeEntityDropOutcome({ phase: 'carrying', admission: { status: 'allowed', effect: {
                actionId: 'session.organization.move', input: {}, preview: describeSessionListDropPreview(target),
            } } })?.glyph).toBe(glyph);
        }
    });

    it.each(['before', 'after'] as const)('draws the same %s order mark for flat-list Action envelopes', placement => {
        const position = { anchorId: 'b', placement };
        for (const [actionId, input] of [
            ['tasks.internal.reorder', { position }],
            ['session.pending.reorder', { position }],
            ['connectedServices.pools.reorder', { move: { position } }],
            ['home.hub.layout.update', { intent: { position } }],
        ] as const) {
            expect(describeEntityDropOutcome({ phase: 'carrying', admission: { status: 'allowed', effect: {
                actionId, input, preview: entityReorderPreview(position, [{ id: 'b', title: 'B' }]),
            } } })?.glyph).toBe(placement === 'before' ? 'above' : 'below');
        }
    });

    it('shows nothing while nothing under the pointer takes the item', () => {
        expect(describeEntityDropOutcome({ phase: 'carrying', admission: null })).toBeNull();
        expect(describeEntityDropOutcome({ phase: 'carrying',
            admission: { status: 'refused', reason: describeSessionListDropReason('no-target') } })).toBeNull();
    });
});

describe('describeSessionListDropReason', () => {
    it('words every relation and organization refusal code instead of leaking the code', () => {
        for (const code of ['read', 'input', 'pairwise', 'cycle', 'already_under', 'archived', 'different_home', 'unavailable',
            'date-ordering-mode', 'no-change', 'descendant-cycle', 'scope-mismatch', 'target-retired', 'something-new']) {
            const reason = describeSessionListDropReason(code);
            expect(reason.code).toBe(code);
            expect(reason.message).not.toBe(code);
            expect(reason.message.length).toBeGreaterThan(0);
        }
    });

    it('says why for the structural blocks the list tree emits, never the catch-all', () => {
        const generic = describeSessionListDropReason('something-new').message;
        for (const code of ['workspace-scope-mismatch', 'max-depth-exceeded', 'leaf-cannot-be-parent', 'ordering-mode',
            'feature-disabled', 'scope-unavailable', 'unsupported-item']) {
            expect(describeSessionListDropReason(code).message, code).not.toBe(generic);
        }
    });
});
