import { describe, expect, it } from 'vitest';

import type { WorkStatusPresentation } from './resolveWorkStatusTone';
import { resolveWorkStatusRowMark, resolveWorkStatusRowWord } from './workStatusRowMark';

const status = (state: string, bucket: WorkStatusPresentation['bucket'], tone: WorkStatusPresentation['tone'] = 'neutral',
    attentionType: WorkStatusPresentation['attentionType'] = null): WorkStatusPresentation =>
    ({ state, bucket, tone, word: state, attentionType });

describe('resolveWorkStatusRowMark (calm list rows, owner ruling 2026-11-01)', () => {
    it('leaves calm rows unmarked so the slot shows their age', () => {
        for (const calm of [
            status('waiting', 'idle'), status('ready', 'finished'), status('stopped', 'idle'), status('cancelled', 'finished'),
            status('succeeded', 'finished'), status('disconnected', 'offline'), status('usage_limited', 'idle'),
            status('locked', 'idle'), status('archived', 'idle'), status('unknown', 'idle'),
        ]) expect(resolveWorkStatusRowMark(calm)).toBe('none');
    });

    it('marks news (unread, mentioned, finished and not seen) with the small ink dot', () => {
        for (const state of ['unread', 'mentioned', 'finished_unseen']) {
            expect(resolveWorkStatusRowMark(status(state, state === 'finished_unseen' ? 'finished' : 'idle'))).toBe('news');
        }
    });

    it('draws working as the spinner, needs-you as the amber dot and failure as the rose dot', () => {
        expect(resolveWorkStatusRowMark(status('thinking', 'working'))).toBe('working');
        expect(resolveWorkStatusRowMark(status('permission_required', 'needs_you', 'attention', 'approval'))).toBe('attention');
        expect(resolveWorkStatusRowMark(status('failed', 'idle', 'danger'))).toBe('danger');
    });

    it('lets tone win over activity: a run waiting for review is amber, not a spinner', () => {
        expect(resolveWorkStatusRowMark(status('waiting_for_review', 'working', 'attention'))).toBe('attention');
        expect(resolveWorkStatusRowMark(status('failed', 'finished', 'danger'))).toBe('danger');
    });
});

describe('resolveWorkStatusRowWord (restored animated working text, owner amendment 2026-11-01)', () => {
    const working = status('thinking', 'working');
    it('keeps the plain word unless the row is working and the preference is on', () => {
        expect(resolveWorkStatusRowWord(working, { animatedWorkingText: false, seed: 's1' })).toBe('thinking');
        expect(resolveWorkStatusRowWord(status('failed', 'idle', 'danger'), { animatedWorkingText: true, seed: 's1' })).toBe('failed');
    });

    it('gives a working row a stable playful verb per row, as 0.2 did', () => {
        const first = resolveWorkStatusRowWord(working, { animatedWorkingText: true, seed: 'session-a' });
        expect(first).not.toBe('thinking');
        expect(first).toMatch(/^[a-z]+…$/);
        expect(resolveWorkStatusRowWord(working, { animatedWorkingText: true, seed: 'session-a' })).toBe(first);
    });
});
