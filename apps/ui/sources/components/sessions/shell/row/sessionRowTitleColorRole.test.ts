import { describe, expect, it } from 'vitest';

import { resolveSessionRowTitleColorRole } from './sessionRowTitleColorRole';

describe('resolveSessionRowTitleColorRole', () => {
    it('keeps activity-and-attention behavior as the default policy', () => {
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
            attentionState: 'thinking',
            titleTone: 'emphasized',
        })).toBe('primary');
    });

    it('can limit active color to user attention states', () => {
        expect(resolveSessionRowTitleColorRole({
            mode: 'attentionOnly',
            selected: false,
            isConnected: true,
            isSessionActive: true,
            attentionState: 'thinking',
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
});
