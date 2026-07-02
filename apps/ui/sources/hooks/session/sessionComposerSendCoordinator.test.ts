import { describe, expect, it, vi } from 'vitest';

import {
    clearComposerAfterOutboundHandoff,
    restoreComposerAfterFailedOutboundHandoff,
} from './sessionComposerSendCoordinator';

describe('sessionComposerSendCoordinator', () => {
    it('clears transient state only after the submitted snapshot is handed off', () => {
        const clearDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const clearTransientInputState = vi.fn();
        const isSemanticSnapshotCurrent = vi.fn(() => true);
        const clearSemanticDraftValues = vi.fn();

        const didClear = clearComposerAfterOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState,
            isSemanticSnapshotCurrent,
            clearSemanticDraftValues,
        });

        expect(didClear).toBe(true);
        expect(clearDraftForSessionIfCurrentValueMatches).toHaveBeenCalledWith({
            sessionId: 'session-a',
            text: 'submitted prompt',
        });
        expect(clearSemanticDraftValues).toHaveBeenCalledTimes(1);
        expect(clearTransientInputState).toHaveBeenCalledTimes(1);
    });

    it('does not clear text or transient state when semantic state changed before handoff', () => {
        const clearDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const clearTransientInputState = vi.fn();
        const clearSemanticDraftValues = vi.fn();

        const didClear = clearComposerAfterOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState,
            isSemanticSnapshotCurrent: () => false,
            clearSemanticDraftValues,
        });

        expect(didClear).toBe(false);
        expect(clearDraftForSessionIfCurrentValueMatches).not.toHaveBeenCalled();
        expect(clearSemanticDraftValues).not.toHaveBeenCalled();
        expect(clearTransientInputState).not.toHaveBeenCalled();
    });

    it('restores a failed handoff only while the composer still matches the cleared value', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValues = vi.fn();

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            restoreDraftForSessionIfCurrentValueMatches,
            restoreTransientInputState,
            restoreSemanticDraftValues,
        });

        expect(didRestore).toBe(true);
        expect(restoreDraftForSessionIfCurrentValueMatches).toHaveBeenCalledWith({
            sessionId: 'session-a',
            text: 'submitted prompt',
        }, '');
        expect(restoreSemanticDraftValues).toHaveBeenCalledTimes(1);
        expect(restoreTransientInputState).toHaveBeenCalledTimes(1);
    });

    it('does not restore a failed handoff over newer semantic state', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValues = vi.fn();
        const isSemanticRestoreSafe = vi.fn(() => false);

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            restoreDraftForSessionIfCurrentValueMatches,
            isSemanticRestoreSafe,
            restoreTransientInputState,
            restoreSemanticDraftValues,
        });

        expect(didRestore).toBe(false);
        expect(isSemanticRestoreSafe).toHaveBeenCalledTimes(1);
        expect(restoreDraftForSessionIfCurrentValueMatches).not.toHaveBeenCalled();
        expect(restoreSemanticDraftValues).not.toHaveBeenCalled();
        expect(restoreTransientInputState).not.toHaveBeenCalled();
    });
});
