import { describe, expect, it } from 'vitest';

import { resolveSessionRowTitleColorRole } from './sessionRowTitleColorRole';

describe('resolveSessionRowTitleColorRole', () => {
    it('keeps the current activity-and-attention behavior by default', () => {
        expect(resolveSessionRowTitleColorRole({
            mode: 'activityAndAttention',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'quiet',
            titleTone: 'quiet',
        })).toBe('secondary');

        expect(resolveSessionRowTitleColorRole({
            mode: 'activityAndAttention',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'working',
            titleTone: 'emphasized',
        })).toBe('primary');
    });

    it('can limit active color to user attention states', () => {
        expect(resolveSessionRowTitleColorRole({
            mode: 'attentionOnly',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'working',
            titleTone: 'emphasized',
        })).toBe('secondary');

        expect(resolveSessionRowTitleColorRole({
            mode: 'attentionOnly',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'permission_required',
            titleTone: 'emphasized',
        })).toBe('primary');
    });

    it('can color every active connected session as active', () => {
        expect(resolveSessionRowTitleColorRole({
            mode: 'allActive',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'quiet',
            titleTone: 'quiet',
        })).toBe('primary');

        expect(resolveSessionRowTitleColorRole({
            mode: 'allActive',
            selected: false,
            isConnected: true,
            isSessionActive: false,
            attentionState: 'quiet',
            titleTone: 'quiet',
        })).toBe('secondary');
    });

    it('keeps selected rows primary and steps disconnected rows down to tertiary', () => {
        expect(resolveSessionRowTitleColorRole({
            mode: 'attentionOnly',
            selected: true,
            isConnected: false,
            isSessionActive: false,
            attentionState: 'quiet',
            titleTone: 'quiet',
        })).toBe('primary');

        expect(resolveSessionRowTitleColorRole({
            mode: 'allActive',
            selected: false,
            isConnected: false,
            isSessionActive: true,
            attentionState: 'permission_required',
            titleTone: 'emphasized',
        })).toBe('tertiary');
    });

    it('never lets a disconnected row hide that it is unread', () => {
        for (const mode of ['activityAndAttention', 'attentionOnly', 'allActive'] as const) {
            expect(resolveSessionRowTitleColorRole({
                mode,
                selected: false,
                isConnected: false,
                isSessionActive: false,
                attentionState: 'unread',
                titleTone: 'emphasized',
            })).toBe('primary');
        }
    });
});
