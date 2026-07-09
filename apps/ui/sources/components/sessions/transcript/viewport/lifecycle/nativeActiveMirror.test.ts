import { describe, expect, it } from 'vitest';

import {
    resolveNativeDragActiveMirrorApplyEffects,
    resolveNativeMomentumActiveMirrorApplyEffects,
    type NativeDragActiveMirrorApplyEffect,
    type NativeMomentumActiveMirrorApplyEffect,
} from './nativeActiveMirror';

const momentumEffect = (
    overrides: Partial<NativeMomentumActiveMirrorApplyEffect> = {},
): NativeMomentumActiveMirrorApplyEffect => ({
    active: true,
    sessionId: 'session-a',
    type: 'native-momentum-active-mirror',
    ...overrides,
});

const dragEffect = (
    overrides: Partial<NativeDragActiveMirrorApplyEffect> = {},
): NativeDragActiveMirrorApplyEffect => ({
    active: true,
    sessionId: 'session-a',
    type: 'native-drag-active-mirror',
    ...overrides,
});

describe('native active mirror apply effects', () => {
    it('returns no momentum apply effects when none match the current session', () => {
        expect(resolveNativeMomentumActiveMirrorApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveNativeMomentumActiveMirrorApplyEffects({
            effects: [
                momentumEffect({ sessionId: 'session-b' }),
                dragEffect(),
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns current-session momentum mirror effects in order', () => {
        const effects = [
            momentumEffect({ active: true }),
            momentumEffect({ active: false }),
        ];

        expect(resolveNativeMomentumActiveMirrorApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('returns no drag apply effects when none match the current session', () => {
        expect(resolveNativeDragActiveMirrorApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveNativeDragActiveMirrorApplyEffects({
            effects: [
                dragEffect({ sessionId: 'session-b' }),
                momentumEffect(),
            ],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns current-session drag mirror effects in order', () => {
        const effects = [
            dragEffect({ active: true }),
            dragEffect({ active: false }),
        ];

        expect(resolveNativeDragActiveMirrorApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual(effects);
    });

    it('filters mixed lifecycle effects by active mirror type and current session', () => {
        const currentMomentum = momentumEffect({ active: false });
        const currentDrag = dragEffect({ active: false });
        const effects = [
            momentumEffect({ sessionId: 'session-b' }),
            dragEffect({ sessionId: 'session-b' }),
            {
                sessionId: 'session-a',
                type: 'web-immediate-release-live-tail',
            },
            {
                sessionId: 'session-a',
                type: 'web-user-scroll-preempt-entry-restore',
            },
            {
                sessionId: 'session-a',
                timestampMs: 10,
                type: 'native-touch-record-intent-timestamp',
            },
            {
                sessionId: 'session-a',
                type: 'native-bottom-follow-rearm-reset',
            },
            currentMomentum,
            currentDrag,
        ];

        expect(resolveNativeMomentumActiveMirrorApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual([currentMomentum]);
        expect(resolveNativeDragActiveMirrorApplyEffects({
            effects,
            sessionId: 'session-a',
        })).toEqual([currentDrag]);
    });
});
