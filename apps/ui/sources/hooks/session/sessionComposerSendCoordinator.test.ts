import { describe, expect, it, vi } from 'vitest';

import {
    captureComposerTransientInputStateForOutboundHandoff,
    clearComposerAfterOutboundHandoff,
    restoreComposerAfterFailedOutboundHandoff,
} from './sessionComposerSendCoordinator';

describe('sessionComposerSendCoordinator', () => {
    it('captures transient input handlers for the outbound lifecycle before owner refs change', () => {
        const ownerAState = { expanded: true, scrollY: 42, updatedAt: 1 };
        const captureOwnerA = vi.fn(() => ownerAState);
        const clearOwnerA = vi.fn();
        const restoreOwnerA = vi.fn();
        const captureOwnerB = vi.fn(() => null);
        const clearOwnerB = vi.fn();
        const restoreOwnerB = vi.fn();

        const captured = captureComposerTransientInputStateForOutboundHandoff({
            captureTransientInputState: captureOwnerA,
            clearTransientInputState: clearOwnerA,
            restoreTransientInputState: restoreOwnerA,
        });

        const currentHandlers = {
            captureTransientInputState: captureOwnerB,
            clearTransientInputState: clearOwnerB,
            restoreTransientInputState: restoreOwnerB,
        };
        currentHandlers.clearTransientInputState();
        currentHandlers.restoreTransientInputState(null);

        captured.clearTransientInputState();
        captured.restoreTransientInputState();

        expect(captureOwnerA).toHaveBeenCalledTimes(1);
        expect(captured.transientInputStateSnapshot).toBe(ownerAState);
        expect(clearOwnerA).toHaveBeenCalledTimes(1);
        expect(restoreOwnerA).toHaveBeenCalledWith(ownerAState);
        expect(captureOwnerB).not.toHaveBeenCalled();
        expect(clearOwnerB).toHaveBeenCalledTimes(1);
        expect(restoreOwnerB).toHaveBeenCalledWith(null);
    });

    it('clears transient state only after the submitted snapshot is handed off', () => {
        const clearDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const clearTransientInputState = vi.fn();
        const clearSemanticDraftValuesMatchingSnapshot = vi.fn();

        const didClear = clearComposerAfterOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState,
            clearSemanticDraftValuesMatchingSnapshot,
        });

        expect(didClear).toBe(true);
        expect(clearDraftForSessionIfCurrentValueMatches).toHaveBeenCalledWith({
            sessionId: 'session-a',
            text: 'submitted prompt',
        });
        expect(clearSemanticDraftValuesMatchingSnapshot).toHaveBeenCalledTimes(1);
        expect(clearTransientInputState).toHaveBeenCalledTimes(1);
    });

    it('clears text while leaving field-level semantic currentness to the draft owner', () => {
        const clearDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const clearTransientInputState = vi.fn();
        const clearSemanticDraftValuesMatchingSnapshot = vi.fn();

        const didClear = clearComposerAfterOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState,
            clearSemanticDraftValuesMatchingSnapshot,
        });

        expect(didClear).toBe(true);
        expect(clearDraftForSessionIfCurrentValueMatches).toHaveBeenCalledTimes(1);
        expect(clearSemanticDraftValuesMatchingSnapshot).toHaveBeenCalledTimes(1);
        expect(clearTransientInputState).toHaveBeenCalledTimes(1);
    });

    it('clears matching semantic fields when newer text keeps the text and transient input state', () => {
        const clearDraftForSessionIfCurrentValueMatches = vi.fn(() => false);
        const clearTransientInputState = vi.fn();
        const clearSemanticDraftValuesMatchingSnapshot = vi.fn(() => true);

        const didClear = clearComposerAfterOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            clearDraftForSessionIfCurrentValueMatches,
            clearTransientInputState,
            clearSemanticDraftValuesMatchingSnapshot,
        });

        expect(didClear).toBe(true);
        expect(clearDraftForSessionIfCurrentValueMatches).toHaveBeenCalledTimes(1);
        expect(clearSemanticDraftValuesMatchingSnapshot).toHaveBeenCalledTimes(1);
        expect(clearTransientInputState).not.toHaveBeenCalled();
    });

    it('restores a failed handoff only while the composer still matches the cleared value', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValuesMatchingClearedSnapshot = vi.fn();

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            isCanonicalOutboundHandoffPresent: () => false,
            restoreDraftForSessionIfCurrentValueMatches,
            restoreTransientInputState,
            restoreSemanticDraftValuesMatchingClearedSnapshot,
        });

        expect(didRestore).toBe(true);
        expect(restoreDraftForSessionIfCurrentValueMatches).toHaveBeenCalledWith({
            sessionId: 'session-a',
            text: 'submitted prompt',
        }, '');
        expect(restoreSemanticDraftValuesMatchingClearedSnapshot).toHaveBeenCalledTimes(1);
        expect(restoreTransientInputState).toHaveBeenCalledTimes(1);
    });

    it('delegates semantic restore currentness to the draft owner', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValuesMatchingClearedSnapshot = vi.fn();

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            isCanonicalOutboundHandoffPresent: () => false,
            restoreDraftForSessionIfCurrentValueMatches,
            restoreTransientInputState,
            restoreSemanticDraftValuesMatchingClearedSnapshot,
        });

        expect(didRestore).toBe(true);
        expect(restoreDraftForSessionIfCurrentValueMatches).toHaveBeenCalledTimes(1);
        expect(restoreSemanticDraftValuesMatchingClearedSnapshot).toHaveBeenCalledTimes(1);
        expect(restoreTransientInputState).toHaveBeenCalledTimes(1);
    });

    it('does not restore after the submitted local id reaches a canonical message owner', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => true);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValuesMatchingClearedSnapshot = vi.fn();

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            isCanonicalOutboundHandoffPresent: () => true,
            restoreDraftForSessionIfCurrentValueMatches,
            restoreTransientInputState,
            restoreSemanticDraftValuesMatchingClearedSnapshot,
        });

        expect(didRestore).toBe(false);
        expect(restoreDraftForSessionIfCurrentValueMatches).not.toHaveBeenCalled();
        expect(restoreSemanticDraftValuesMatchingClearedSnapshot).not.toHaveBeenCalled();
        expect(restoreTransientInputState).not.toHaveBeenCalled();
    });

    it('does not restore transient input over newer composer text while still delegating semantic recovery', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => false);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValuesMatchingClearedSnapshot = vi.fn();

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            isCanonicalOutboundHandoffPresent: () => false,
            restoreDraftForSessionIfCurrentValueMatches,
            restoreTransientInputState,
            restoreSemanticDraftValuesMatchingClearedSnapshot,
        });

        expect(didRestore).toBe(false);
        expect(restoreDraftForSessionIfCurrentValueMatches).toHaveBeenCalledWith({
            sessionId: 'session-a',
            text: 'submitted prompt',
        }, '');
        expect(restoreSemanticDraftValuesMatchingClearedSnapshot).toHaveBeenCalledTimes(1);
        expect(restoreTransientInputState).not.toHaveBeenCalled();
    });

    it('restores matching semantic fields after a failed handoff without overwriting newer text', () => {
        const restoreDraftForSessionIfCurrentValueMatches = vi.fn(() => false);
        const restoreTransientInputState = vi.fn();
        const restoreSemanticDraftValuesMatchingClearedSnapshot = vi.fn(() => true);

        const didRestore = restoreComposerAfterFailedOutboundHandoff({
            snapshot: { sessionId: 'session-a', text: 'submitted prompt' },
            wasClearedAtHandoff: true,
            isCanonicalOutboundHandoffPresent: () => false,
            restoreDraftForSessionIfCurrentValueMatches,
            restoreTransientInputState,
            restoreSemanticDraftValuesMatchingClearedSnapshot,
        });

        expect(didRestore).toBe(true);
        expect(restoreDraftForSessionIfCurrentValueMatches).toHaveBeenCalledTimes(1);
        expect(restoreSemanticDraftValuesMatchingClearedSnapshot).toHaveBeenCalledTimes(1);
        expect(restoreTransientInputState).not.toHaveBeenCalled();
    });
});
