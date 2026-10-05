import { describe, expect, it } from 'vitest';

import {
    describeSessionListDropOutcome,
    describeSessionListDropReason,
} from './sessionListDropPresentation';

describe('describeSessionListDropOutcome', () => {
    it('names the effect and its limit for an allowed relation drop', () => {
        const outcome = describeSessionListDropOutcome({
            phase: 'carrying',
            admission: { status: 'allowed', effect: {
                actionId: 'session.reports_to.set',
                input: { sessionId: 'a', leadSessionId: 'b', expectedLeadSessionId: null },
                preview: { verb: 'Put under Fix settings modal remount', target: 'Fix settings modal remount', consequence: 'Reports to it · both keep running' },
            } },
        });
        expect(outcome).toEqual({
            tone: 'allowed',
            glyph: 'nest',
            title: 'Put under Fix settings modal remount',
            detail: 'Reports to it · both keep running',
        });
    });

    it('marks a refusal as refused with the owner reason, never as the effect it would have had', () => {
        const outcome = describeSessionListDropOutcome({
            phase: 'carrying',
            admission: { status: 'refused', reason: describeSessionListDropReason('read'),
                preview: { verb: 'Can’t put under Docs search index', target: 'Docs search index' } },
        });
        expect(outcome?.tone).toBe('refused');
        expect(outcome?.title).toBe('Can’t put under Docs search index');
        expect(outcome?.detail).toBe(describeSessionListDropReason('read').message);
    });

    it('stays visibly uncommitted while a released relation waits for its owner', () => {
        const outcome = describeSessionListDropOutcome({
            phase: 'pending',
            admission: { status: 'allowed', effect: {
                actionId: 'session.reports_to.set',
                input: {},
                preview: { verb: 'Put under Lead', target: 'Lead', consequence: 'Reports to it · both keep running' },
            } },
        });
        expect(outcome?.tone).toBe('pending');
        expect(outcome?.title).not.toBe('Put under Lead');
    });

    it('draws the order or folder mark for organization moves', () => {
        const effect = (instructionKind: string) => ({ status: 'allowed' as const, effect: {
            actionId: 'session.organization.move', input: { instructionKind }, preview: { verb: 'x', target: 'y' },
        } });
        expect(describeSessionListDropOutcome({ phase: 'carrying', admission: effect('reorder-before') })?.glyph).toBe('above');
        expect(describeSessionListDropOutcome({ phase: 'carrying', admission: effect('reorder-after') })?.glyph).toBe('below');
        expect(describeSessionListDropOutcome({ phase: 'carrying', admission: effect('nest-into') })?.glyph).toBe('folder');
        expect(describeSessionListDropOutcome({ phase: 'carrying', admission: effect('move-to-root') })?.glyph).toBe('topLevel');
    });

    it.each(['before', 'after'] as const)('draws the same %s order mark for flat-list Action envelopes', placement => {
        const position = { anchorId: 'b', placement };
        for (const [actionId, input] of [
            ['todos.reorder', { position }],
            ['session.pending.reorder', { position }],
            ['connectedServices.pools.reorder', { move: { position } }],
            ['home.hub.layout.update', { intent: { position } }],
        ] as const) {
            expect(describeSessionListDropOutcome({ phase: 'carrying', admission: { status: 'allowed', effect: {
                actionId, input, preview: { verb: 'Move relative to B', target: 'B' },
            } } })?.glyph).toBe(placement === 'before' ? 'above' : 'below');
        }
    });

    it('shows nothing while nothing under the pointer takes the item', () => {
        expect(describeSessionListDropOutcome({ phase: 'carrying', admission: null })).toBeNull();
        expect(describeSessionListDropOutcome({ phase: 'carrying',
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
});
