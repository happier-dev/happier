import { describe, expect, it } from 'vitest';

import {
    canAutoFollowTranscriptBottom,
    resolveTranscriptAutoFollowPinWaitMs,
} from './transcriptAutoFollowGate';

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

    it('blocks automatic following while a target window is active but keeps explicit bottom commands allowed', () => {
        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            targetWindowActive: true,
        })).toBe(false);

        expect(canAutoFollowTranscriptBottom({
            ...baseParams,
            isExplicitUserCommand: true,
            reason: 'jump-to-bottom',
            targetWindowActive: true,
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

    it('blocks automatic pin scheduling when auto-follow is not allowed', () => {
        expect(resolveTranscriptAutoFollowPinWaitMs({
            autoPinDelayMs: 1000,
            canAutoFollow: false,
            hasRearmedBottomFollow: false,
            lastUserScrollIntentAtMs: Number.NEGATIVE_INFINITY,
            nowMs: 2000,
        })).toBeNull();
    });

    it('schedules immediately after bottom-follow was rearmed', () => {
        expect(resolveTranscriptAutoFollowPinWaitMs({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            hasRearmedBottomFollow: true,
            lastUserScrollIntentAtMs: 1750,
            nowMs: 2000,
        })).toBe(0);
    });

    it('schedules immediately when the user-intent delay has elapsed or there was no recent intent', () => {
        expect(resolveTranscriptAutoFollowPinWaitMs({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            hasRearmedBottomFollow: false,
            lastUserScrollIntentAtMs: 1000,
            nowMs: 2000,
        })).toBe(0);

        expect(resolveTranscriptAutoFollowPinWaitMs({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            hasRearmedBottomFollow: false,
            lastUserScrollIntentAtMs: Number.NEGATIVE_INFINITY,
            nowMs: 2000,
        })).toBe(0);
    });

    it('returns the remaining delay while inside the recent user-intent window', () => {
        expect(resolveTranscriptAutoFollowPinWaitMs({
            autoPinDelayMs: 1000,
            canAutoFollow: true,
            hasRearmedBottomFollow: false,
            lastUserScrollIntentAtMs: 1600,
            nowMs: 2000,
        })).toBe(600);
    });
});
