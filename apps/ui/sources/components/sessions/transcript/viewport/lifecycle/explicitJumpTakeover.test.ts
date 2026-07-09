import { describe, expect, it } from 'vitest';

import {
    resolveExplicitJumpTakeoverApplyEffects,
    type ExplicitJumpTakeoverApplyEffect,
} from './explicitJumpTakeover';

type ExplicitJumpTakeoverEffectType = ExplicitJumpTakeoverApplyEffect['type'];

const explicitJumpEffect = (
    type: ExplicitJumpTakeoverEffectType,
    overrides: Partial<ExplicitJumpTakeoverApplyEffect> = {},
): ExplicitJumpTakeoverApplyEffect => ({
    reason: 'jump-to-seq',
    sessionId: 'session-a',
    type,
    ...overrides,
} as ExplicitJumpTakeoverApplyEffect);

describe('explicit jump takeover apply effects', () => {
    it('returns no apply effects when none match the current session', () => {
        expect(resolveExplicitJumpTakeoverApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveExplicitJumpTakeoverApplyEffects({
            effects: [
                explicitJumpEffect('explicit-jump-preempt-entry-restore', { sessionId: 'session-b' }),
                {
                    sessionId: 'session-a',
                    type: 'follow-bottom-intent-preempt-entry-restore',
                },
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns all current-session explicit jump takeover effects in order', () => {
        const effects = [
            explicitJumpEffect('explicit-jump-cancel-native-mount-settle-bottom-pin'),
            explicitJumpEffect('explicit-jump-suppress-entry-restore'),
            explicitJumpEffect('explicit-jump-preempt-entry-restore'),
            explicitJumpEffect('explicit-jump-clear-native-entry-restore-paint-release-timeout'),
            explicitJumpEffect('explicit-jump-invalidate-native-prepend-transaction'),
            explicitJumpEffect('explicit-jump-clear-native-restore-index-command-cache'),
            explicitJumpEffect('explicit-jump-close-native-prepend-transaction', { reason: 'jump-to-bottom' }),
        ];

        expect(resolveExplicitJumpTakeoverApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('filters mixed lifecycle effects by explicit jump type and current session', () => {
        const currentPreempt = explicitJumpEffect('explicit-jump-preempt-entry-restore');
        const currentClosePrepend = explicitJumpEffect('explicit-jump-close-native-prepend-transaction', {
            reason: 'jump-to-bottom',
        });
        const effects = [
            explicitJumpEffect('explicit-jump-suppress-entry-restore', { sessionId: 'session-b' }),
            {
                sessionId: 'session-a',
                type: 'follow-bottom-intent-preempt-entry-restore',
            },
            {
                sessionId: 'session-a',
                type: 'native-user-scroll-preempt-entry-restore',
            },
            {
                sessionId: 'session-a',
                type: 'web-user-scroll-preempt-entry-restore',
            },
            {
                sessionId: 'session-a',
                timestampMs: 10,
                type: 'web-user-scroll-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                type: 'web-immediate-release-live-tail',
            },
            {
                sessionId: 'session-a',
                timestampMs: 11,
                type: 'native-touch-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                timestampMs: 12,
                type: 'local-interaction-record-intent-timestamp',
            },
            {
                active: true,
                sessionId: 'session-a',
                type: 'native-momentum-active-mirror',
            },
            {
                distanceFromLiveTailPx: 0,
                isPinned: true,
                sessionId: 'session-a',
                source: 'explicit-return',
                type: 'viewport-change',
            },
            {
                requestLoad: true,
                sessionId: 'session-a',
                type: 'deferred-newer-drain',
            },
            {
                sessionId: 'session-a',
                type: 'session-entry-command-controller-reset',
            },
            currentPreempt,
            currentClosePrepend,
        ];

        expect(resolveExplicitJumpTakeoverApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual([currentPreempt, currentClosePrepend]);
    });
});
