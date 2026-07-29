import { describe, expect, it } from 'vitest';

import type { EntryRestoreTransactionOutcome } from './entryRestoreTransaction';
import {
    resolveEntryRestoreCloseEffects,
    resolveEntryRestoreDisposeEffects,
    type EntryRestoreCloseWriteContext,
} from './entryRestoreCloseEffects';

const anchorWriteContext: EntryRestoreCloseWriteContext = {
    distanceFromBottom: 120,
    issuedContentHeight: 2400,
    issuedLayoutHeight: 600,
    kind: 'anchor',
};

const distanceWriteContext: EntryRestoreCloseWriteContext = {
    distanceFromBottom: 180,
    issuedContentHeight: 3000,
    issuedLayoutHeight: 700,
    kind: 'distance',
};

const bottomWriteContext: EntryRestoreCloseWriteContext = {
    distanceFromBottom: 0,
    issuedContentHeight: 2200,
    issuedLayoutHeight: 640,
    kind: 'bottom',
};

describe('entry restore close effects', () => {
    it('maps a confirmed current-session native anchor close to confirmed ownership, restored telemetry, and native applied effect', () => {
        expect(resolveEntryRestoreCloseEffects({
            currentSessionId: 'session-1',
            outcome: 'confirmed',
            platform: 'native',
            sessionId: 'session-1',
            writeContext: anchorWriteContext,
        })).toEqual([
            { outcome: 'confirmed', type: 'close-entry-ownership' },
            {
                contentHeight: 2400,
                layoutHeight: 600,
                mode: 'restore-anchor',
                offsetY: 120,
                reason: 'restored',
                type: 'restore-decision',
            },
            { type: 'native-initial-viewport-applied' },
        ]);
    });

    it('maps deadline and preempted current-session native closes to paint release without native applied', () => {
        const cases: ReadonlyArray<Readonly<{
            expectedOwnership: 'deadline' | 'preempted';
            expectedReason: 'not-ready' | 'skipped';
            outcome: EntryRestoreTransactionOutcome;
        }>> = [
            { expectedOwnership: 'deadline', expectedReason: 'not-ready', outcome: 'deadline' },
            { expectedOwnership: 'preempted', expectedReason: 'skipped', outcome: 'preempted-user-scroll' },
        ];

        for (const item of cases) {
            expect(resolveEntryRestoreCloseEffects({
                currentSessionId: 'session-1',
                outcome: item.outcome,
                platform: 'native',
                sessionId: 'session-1',
                writeContext: distanceWriteContext,
            })).toEqual([
                { outcome: item.expectedOwnership, type: 'close-entry-ownership' },
                {
                    contentHeight: 3000,
                    layoutHeight: 700,
                    mode: 'restore-distance',
                    offsetY: 180,
                    reason: item.expectedReason,
                    type: 'restore-decision',
                },
                { type: 'release-native-entry-paint' },
            ]);
        }
    });

    it('does not run native paint effects for web or non-current session closes', () => {
        expect(resolveEntryRestoreCloseEffects({
            currentSessionId: 'session-1',
            outcome: 'confirmed',
            platform: 'web',
            sessionId: 'session-1',
            writeContext: anchorWriteContext,
        })).toEqual([
            { outcome: 'confirmed', type: 'close-entry-ownership' },
            {
                contentHeight: 2400,
                layoutHeight: 600,
                mode: 'restore-anchor',
                offsetY: 120,
                reason: 'restored',
                type: 'restore-decision',
            },
        ]);

        expect(resolveEntryRestoreCloseEffects({
            currentSessionId: 'session-2',
            outcome: 'confirmed',
            platform: 'native',
            sessionId: 'session-1',
            writeContext: anchorWriteContext,
        })).toEqual([
            { outcome: 'confirmed', type: 'close-entry-ownership' },
            {
                contentHeight: 2400,
                layoutHeight: 600,
                mode: 'restore-anchor',
                offsetY: 120,
                reason: 'restored',
                type: 'restore-decision',
            },
        ]);
    });

    it('maps bottom write context to follow-bottom telemetry mode', () => {
        expect(resolveEntryRestoreCloseEffects({
            currentSessionId: 'session-1',
            outcome: 'confirmed',
            platform: 'web',
            sessionId: 'session-1',
            writeContext: bottomWriteContext,
        })).toContainEqual(expect.objectContaining({
            mode: 'follow-bottom',
            reason: 'restored',
            type: 'restore-decision',
        }));
    });

    it('maps dispose-on-exit to transaction-session telemetry without current-session native effects', () => {
        expect(resolveEntryRestoreDisposeEffects({
            sessionId: 'session-1',
            writeContext: anchorWriteContext,
        })).toEqual([
            { outcome: 'preempted', type: 'close-entry-ownership' },
            {
                mode: 'restore-anchor',
                offsetY: 120,
                reason: 'skipped',
                sessionId: 'session-1',
                type: 'restore-decision-for-session',
            },
        ]);
    });
});
