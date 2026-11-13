import { describe, expect, it } from 'vitest';

import { readHistoryGapRecoveryPresentation } from './historyGapRecoveryPresentation';

describe('readHistoryGapRecoveryPresentation (DEPLOY-REACCEPT-1113 D8)', () => {
    it('treats the watcher facts still arriving as resolving, never as unavailable', () => {
        for (const projectionPhase of ['idle', 'loading'] as const) {
            expect(readHistoryGapRecoveryPresentation({ projectionPhase, canRecover: false, recovering: false, recoveryFailed: false }))
                .toBe('resolving');
        }
    });

    it('offers recovery once its owner says it can run, and holds it while it runs', () => {
        expect(readHistoryGapRecoveryPresentation({ projectionPhase: 'ready', canRecover: true, recovering: false, recoveryFailed: false }))
            .toBe('ready');
        expect(readHistoryGapRecoveryPresentation({ projectionPhase: 'ready', canRecover: true, recovering: true, recoveryFailed: false }))
            .toBe('recovering');
    });

    it('says recovery is unavailable only after the owner settled that it cannot run', () => {
        expect(readHistoryGapRecoveryPresentation({ projectionPhase: 'ready', canRecover: false, recovering: false, recoveryFailed: false }))
            .toBe('unavailable');
        expect(readHistoryGapRecoveryPresentation({ projectionPhase: 'error', canRecover: false, recovering: false, recoveryFailed: false }))
            .toBe('unavailable');
    });

    it('keeps an unconfirmed recovery as its own state with a retry', () => {
        expect(readHistoryGapRecoveryPresentation({ projectionPhase: 'ready', canRecover: true, recovering: false, recoveryFailed: true }))
            .toBe('failed');
    });
});
