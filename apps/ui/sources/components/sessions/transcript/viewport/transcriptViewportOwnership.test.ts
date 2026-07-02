import { describe, expect, it } from 'vitest';

import { createTranscriptViewportOwnership } from './transcriptViewportOwnership';

describe('transcript viewport ownership', () => {
    describe('initial state', () => {
        it('starts with follow as the active owner and only follow may write', () => {
            const ownership = createTranscriptViewportOwnership();

            expect(ownership.activeOwner()).toBe('follow');
            expect(ownership.canWrite('follow')).toBe(true);
            expect(ownership.canWrite('entry')).toBe(false);
            expect(ownership.canWrite('prepend')).toBe(false);
            expect(ownership.canWrite('explicit')).toBe(false);
            expect(ownership.canWrite('idle')).toBe(false);
        });
    });

    describe('openTransaction', () => {
        it('grants exclusive write access to the opened owner', () => {
            const ownership = createTranscriptViewportOwnership();

            expect(ownership.openTransaction('entry')).toEqual({ opened: true });
            expect(ownership.activeOwner()).toBe('entry');
            expect(ownership.canWrite('entry')).toBe(true);
            expect(ownership.canWrite('follow')).toBe(false);
            expect(ownership.canWrite('prepend')).toBe(false);
            expect(ownership.canWrite('explicit')).toBe(false);
        });

        it('rejects a double open by the same owner', () => {
            const ownership = createTranscriptViewportOwnership();
            ownership.openTransaction('entry');

            expect(ownership.openTransaction('entry')).toEqual({ opened: false, activeOwner: 'entry' });
            expect(ownership.activeOwner()).toBe('entry');
        });

        it('keeps entry and prepend mutually exclusive', () => {
            const entryFirst = createTranscriptViewportOwnership();
            entryFirst.openTransaction('entry');
            expect(entryFirst.openTransaction('prepend')).toEqual({ opened: false, activeOwner: 'entry' });
            expect(entryFirst.activeOwner()).toBe('entry');

            const prependFirst = createTranscriptViewportOwnership();
            prependFirst.openTransaction('prepend');
            expect(prependFirst.openTransaction('entry')).toEqual({ opened: false, activeOwner: 'prepend' });
            expect(prependFirst.activeOwner()).toBe('prepend');
        });

        it('rejects opening while an explicit transaction is active', () => {
            const ownership = createTranscriptViewportOwnership();
            ownership.openTransaction('explicit');

            expect(ownership.openTransaction('entry')).toEqual({ opened: false, activeOwner: 'explicit' });
            expect(ownership.openTransaction('prepend')).toEqual({ opened: false, activeOwner: 'explicit' });
        });
    });

    describe('closeTransaction', () => {
        it('returns ownership to follow when the active owner closes', () => {
            const ownership = createTranscriptViewportOwnership();
            ownership.openTransaction('entry');

            expect(ownership.closeTransaction('entry', 'confirmed')).toEqual({
                closed: true,
                owner: 'entry',
                outcome: 'confirmed',
            });
            expect(ownership.activeOwner()).toBe('follow');
            expect(ownership.canWrite('follow')).toBe(true);
            expect(ownership.canWrite('entry')).toBe(false);
        });

        it('rejects a close from a non-active owner without state change', () => {
            const ownership = createTranscriptViewportOwnership();
            ownership.openTransaction('entry');

            expect(ownership.closeTransaction('prepend', 'abandoned-user-scroll')).toEqual({
                closed: false,
                activeOwner: 'entry',
            });
            expect(ownership.activeOwner()).toBe('entry');
            expect(ownership.canWrite('entry')).toBe(true);
        });

        it('rejects a close when no transaction is open', () => {
            const ownership = createTranscriptViewportOwnership();

            expect(ownership.closeTransaction('entry', 'deadline')).toEqual({
                closed: false,
                activeOwner: 'follow',
            });
            expect(ownership.activeOwner()).toBe('follow');
        });

        it('allows a new transaction after the previous one closed', () => {
            const ownership = createTranscriptViewportOwnership();
            ownership.openTransaction('entry');
            ownership.closeTransaction('entry', 'confirmed');

            expect(ownership.openTransaction('prepend')).toEqual({ opened: true });
            expect(ownership.activeOwner()).toBe('prepend');

            ownership.closeTransaction('prepend', 'mvcp-preserved');
            expect(ownership.activeOwner()).toBe('follow');
        });
    });

    describe('preempt', () => {
        it('lets explicit preempt an open entry transaction', () => {
            const ownership = createTranscriptViewportOwnership();
            ownership.openTransaction('entry');

            expect(ownership.preempt('explicit')).toEqual({ opened: true, preemptedOwner: 'entry' });
            expect(ownership.activeOwner()).toBe('explicit');
            expect(ownership.canWrite('explicit')).toBe(true);
            expect(ownership.canWrite('entry')).toBe(false);
        });

        it('lets explicit preempt an open prepend transaction', () => {
            const ownership = createTranscriptViewportOwnership();
            ownership.openTransaction('prepend');

            expect(ownership.preempt('explicit')).toEqual({ opened: true, preemptedOwner: 'prepend' });
            expect(ownership.activeOwner()).toBe('explicit');
        });

        it('lets a new explicit action preempt a still-open explicit transaction', () => {
            const ownership = createTranscriptViewportOwnership();
            ownership.openTransaction('explicit');

            expect(ownership.preempt('explicit')).toEqual({ opened: true, preemptedOwner: 'explicit' });
            expect(ownership.activeOwner()).toBe('explicit');
        });

        it('opens an explicit transaction when nothing is open', () => {
            const ownership = createTranscriptViewportOwnership();

            expect(ownership.preempt('explicit')).toEqual({ opened: true, preemptedOwner: null });
            expect(ownership.activeOwner()).toBe('explicit');
        });

        it('gives entry and prepend no preemption power', () => {
            const ownership = createTranscriptViewportOwnership();
            ownership.openTransaction('prepend');

            expect(ownership.preempt('entry')).toEqual({ opened: false, preemptedOwner: null, activeOwner: 'prepend' });
            expect(ownership.activeOwner()).toBe('prepend');

            ownership.closeTransaction('prepend', 'fallback-restored');
            ownership.openTransaction('entry');
            expect(ownership.preempt('prepend')).toEqual({ opened: false, preemptedOwner: null, activeOwner: 'entry' });
            expect(ownership.activeOwner()).toBe('entry');
        });

        it('lets entry or prepend preempt-open when nothing is open', () => {
            const ownership = createTranscriptViewportOwnership();

            expect(ownership.preempt('entry')).toEqual({ opened: true, preemptedOwner: null });
            expect(ownership.activeOwner()).toBe('entry');
        });
    });

    describe('sequences', () => {
        it('handles entry → explicit preempt → close → prepend lifecycle', () => {
            const ownership = createTranscriptViewportOwnership();

            expect(ownership.openTransaction('entry')).toEqual({ opened: true });
            expect(ownership.preempt('explicit')).toEqual({ opened: true, preemptedOwner: 'entry' });
            expect(ownership.closeTransaction('entry', 'confirmed')).toEqual({
                closed: false,
                activeOwner: 'explicit',
            });
            expect(ownership.closeTransaction('explicit', 'confirmed')).toEqual({
                closed: true,
                owner: 'explicit',
                outcome: 'confirmed',
            });
            expect(ownership.openTransaction('prepend')).toEqual({ opened: true });
            expect(ownership.closeTransaction('prepend', 'abandoned-identity')).toEqual({
                closed: true,
                owner: 'prepend',
                outcome: 'abandoned-identity',
            });
            expect(ownership.activeOwner()).toBe('follow');
        });

        it('never grants write access to idle', () => {
            const ownership = createTranscriptViewportOwnership();
            expect(ownership.canWrite('idle')).toBe(false);

            ownership.openTransaction('entry');
            expect(ownership.canWrite('idle')).toBe(false);

            ownership.closeTransaction('entry', 'preempted');
            expect(ownership.canWrite('idle')).toBe(false);
        });
    });
});
