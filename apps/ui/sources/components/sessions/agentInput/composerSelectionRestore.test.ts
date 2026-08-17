import { describe, it, expect } from 'vitest';

import { resolveComposerSelectionRestore } from './composerSelectionRestore';

// Generations are the tokens useSessionAgentInputComposerPersistence builds:
// `<ownerKey>:<scopeKey>:<restoreEpoch>:<adopted|pending>`.
describe('resolveComposerSelectionRestore', () => {
    it('applies the persisted selection on the first generation after open', () => {
        const decision = resolveComposerSelectionRestore({
            token: 'session:s1:scope:0:adopted',
            lastConsumedToken: null,
            hasEditedSinceOpen: false,
            hasSelection: true,
        });

        expect(decision).toEqual({ apply: true, consumedToken: 'session:s1:scope:0:adopted' });
    });

    it('never re-applies the same generation, however often the effect re-runs', () => {
        const decision = resolveComposerSelectionRestore({
            token: 'session:s1:scope:0:adopted',
            lastConsumedToken: 'session:s1:scope:0:adopted',
            hasEditedSinceOpen: false,
            hasSelection: true,
        });

        expect(decision.apply).toBe(false);
    });

    it('refuses to restore after the user has typed, even for a NEW generation', () => {
        // The reported corruption: a stale persisted RANGE re-applied mid-typing selects
        // a word, and the next keystroke replaces it. A late-arriving generation (async
        // draft load, basis latch flipping late, rollback) must not resurrect it.
        const decision = resolveComposerSelectionRestore({
            token: 'session:s1:scope:1:adopted',
            lastConsumedToken: 'session:s1:scope:0:pending',
            hasEditedSinceOpen: true,
            hasSelection: true,
        });

        expect(decision.apply).toBe(false);
    });

    it('burns the generation it refused, so a later re-run cannot resurrect it', () => {
        const refused = resolveComposerSelectionRestore({
            token: 'session:s1:scope:1:adopted',
            lastConsumedToken: null,
            hasEditedSinceOpen: true,
            hasSelection: true,
        });
        expect(refused).toEqual({ apply: false, consumedToken: 'session:s1:scope:1:adopted' });

        // Same generation seen again once the edit flag is somehow cleared: still refused.
        const replay = resolveComposerSelectionRestore({
            token: 'session:s1:scope:1:adopted',
            lastConsumedToken: refused.consumedToken,
            hasEditedSinceOpen: false,
            hasSelection: true,
        });
        expect(replay.apply).toBe(false);
    });

    it('applies a fresh generation when the composer has not been edited (e.g. a new session opened)', () => {
        const decision = resolveComposerSelectionRestore({
            token: 'session:s2:scope:0:adopted',
            lastConsumedToken: 'session:s1:scope:0:adopted',
            hasEditedSinceOpen: false,
            hasSelection: true,
        });

        expect(decision).toEqual({ apply: true, consumedToken: 'session:s2:scope:0:adopted' });
    });

    it('does nothing when there is no persisted selection to restore', () => {
        const decision = resolveComposerSelectionRestore({
            token: 'session:s1:scope:0:adopted',
            lastConsumedToken: null,
            hasEditedSinceOpen: false,
            hasSelection: false,
        });

        expect(decision).toEqual({ apply: false, consumedToken: null });
    });

    it('treats absent persistence as a no-op without losing the consumed generation', () => {
        const decision = resolveComposerSelectionRestore({
            token: undefined,
            lastConsumedToken: 'session:s1:scope:0:adopted',
            hasEditedSinceOpen: false,
            hasSelection: false,
        });

        expect(decision).toEqual({ apply: false, consumedToken: 'session:s1:scope:0:adopted' });
    });
});
