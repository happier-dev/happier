import { describe, expect, it } from 'vitest';

import { resolveSessionRowTitleColorRole } from './sessionRowTitleColorRole';

const quiet = { state: 'waiting', bucket: 'idle', tone: 'neutral', word: 'Idle', attentionType: null } as const;
const working = { state: 'thinking', bucket: 'working', tone: 'neutral', word: 'Working', attentionType: null } as const;
const question = { state: 'action_required', bucket: 'needs_you', tone: 'neutral', word: 'Manager handling this', attentionType: 'decision' } as const;

describe('resolveSessionRowTitleColorRole', () => {
    it('keeps activity visible under the default policy without making it attention', () => {
        expect(resolveSessionRowTitleColorRole({ mode: 'activityAndAttention', selected: false, isSessionActive: true, status: quiet, titleTone: 'quiet' })).toBe('secondary');
        expect(resolveSessionRowTitleColorRole({ mode: 'activityAndAttention', selected: false, isSessionActive: true, status: working, titleTone: 'normal' })).toBe('primary');
        expect(resolveSessionRowTitleColorRole({ mode: 'attentionOnly', selected: false, isSessionActive: true, status: working, titleTone: 'normal' })).toBe('secondary');
    });

    it('keeps manager-handled questions quiet despite their admitted C1 classification', () => {
        expect(resolveSessionRowTitleColorRole({ mode: 'attentionOnly', selected: false, isSessionActive: true, status: question, titleTone: 'normal' })).toBe('secondary');
    });

    it('can color active sessions and preserves selection independently of status', () => {
        expect(resolveSessionRowTitleColorRole({ mode: 'allActive', selected: false, isSessionActive: true, status: quiet, titleTone: 'quiet' })).toBe('primary');
        expect(resolveSessionRowTitleColorRole({ mode: 'allActive', selected: false, isSessionActive: false, status: quiet, titleTone: 'quiet' })).toBe('secondary');
        expect(resolveSessionRowTitleColorRole({ mode: 'allActive', selected: true, isSessionActive: false, status: { ...quiet, state: 'disconnected', bucket: 'offline' }, titleTone: 'quiet' })).toBe('primary');
    });

    it('steps stopped and offline titles down to tertiary ink unless the row is open (calm ruling 2026-11-01)', () => {
        const stopped = { ...quiet, state: 'stopped' } as const;
        const offline = { ...quiet, state: 'disconnected', bucket: 'offline' } as const;
        for (const status of [stopped, offline]) {
            for (const mode of ['activityAndAttention', 'attentionOnly', 'allActive'] as const) {
                expect(resolveSessionRowTitleColorRole({ mode, selected: false, isSessionActive: false, status, titleTone: 'quiet' })).toBe('tertiary');
            }
            expect(resolveSessionRowTitleColorRole({ mode: 'activityAndAttention', selected: true, isSessionActive: false, status, titleTone: 'quiet' })).toBe('primary');
        }
        expect(resolveSessionRowTitleColorRole({ mode: 'activityAndAttention', selected: false, isSessionActive: false, status: quiet, titleTone: 'quiet' })).toBe('secondary');
    });

    it('keeps every Bot name in primary ink in the roster, whatever its activity or availability', () => {
        const offline = { ...quiet, state: 'disconnected', bucket: 'offline' } as const;
        for (const status of [quiet, offline]) {
            for (const mode of ['activityAndAttention', 'attentionOnly', 'allActive'] as const) {
                expect(resolveSessionRowTitleColorRole({ mode, selected: false, isSessionActive: false, status, titleTone: 'quiet', roster: true })).toBe('primary');
            }
        }
    });
});
