import { describe, expect, it } from 'vitest';

import { canAutoFollowTranscriptBottom } from './transcriptAutoFollowGate';

const baseParams = {
    autoFollowWhenPinned: true,
    bottomFollowMode: 'following' as const,
    isExplicitUserCommand: false,
    jumpToSeqActive: false,
    pinEnabled: true,
    reason: 'stream-append' as const,
    wantsPinned: true,
};

describe('transcript auto-follow gate', () => {
    it('allows ordinary stream appends only while following', () => {
        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            bottomFollowMode: 'following',
            reason: 'stream-append',
        })).toBe(true);

        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            bottomFollowMode: 'escaping',
            reason: 'stream-append',
        })).toBe(false);

        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            bottomFollowMode: 'released',
            reason: 'stream-append',
        })).toBe(false);
    });

    it.each([
        'content-size-change',
        'layout-change',
        'mount-settle',
        'passive-drift',
    ] as const)('blocks automatic %s while escaping or released', (reason) => {
        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            bottomFollowMode: 'escaping',
            reason,
        })).toBe(false);

        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            bottomFollowMode: 'released',
            reason,
        })).toBe(false);
    });

    it('allows explicit jump-to-bottom from escaping and released', () => {
        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            bottomFollowMode: 'escaping',
            isExplicitUserCommand: true,
            reason: 'jump-to-bottom',
        })).toBe(true);

        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            bottomFollowMode: 'released',
            isExplicitUserCommand: true,
            reason: 'jump-to-bottom',
        })).toBe(true);
    });

    it('respects disabled pin settings, active jump-to-seq, and legacy wantsPinned', () => {
        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            pinEnabled: false,
        })).toBe(false);

        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            autoFollowWhenPinned: false,
        })).toBe(false);

        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            jumpToSeqActive: true,
        })).toBe(false);

        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            wantsPinned: false,
        })).toBe(false);
    });
});
