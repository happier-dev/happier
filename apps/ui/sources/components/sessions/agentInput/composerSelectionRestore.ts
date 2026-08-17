/**
 * Decides whether the composer may re-apply a PERSISTED selection.
 *
 * The persisted selection exists to resume where the user left off, so it is only
 * meaningful at OPEN, against the text it was captured for. Once the user types, it
 * describes text that no longer exists at those offsets — and because the store keeps
 * whatever the input reported, that stale value can be a RANGE (a word selected by a
 * double-tap, autocorrect, or spell-check). Re-applying a stale range mid-typing selects
 * a word and the next keystroke replaces it, silently corrupting the draft.
 *
 * Hence two rules, both required:
 *  - apply at most once per restore generation (`token`), and
 *  - never apply after the user has edited the text since this composer opened.
 *
 * The edit flag is what makes this robust: it holds regardless of WHICH producer moved
 * the token (an async draft load, a basis latch flipping late, a send-failure rollback),
 * so no future restore producer can reintroduce the corruption.
 */
export type ComposerSelectionRestoreDecision = Readonly<{
    apply: boolean;
    /** Token to record as seen, whether or not it was applied. */
    consumedToken: string | null;
}>;

export function resolveComposerSelectionRestore(input: Readonly<{
    /** Current restore generation, or null/undefined when persistence is absent. */
    token: string | null | undefined;
    /** The generation already handled by this composer instance. */
    lastConsumedToken: string | null;
    /** True once the user has changed the text since this composer opened. */
    hasEditedSinceOpen: boolean;
    /** Whether a persisted selection is actually available to restore. */
    hasSelection: boolean;
}>): ComposerSelectionRestoreDecision {
    const token = input.token ?? null;

    if (!input.hasSelection) {
        return { apply: false, consumedToken: input.lastConsumedToken };
    }

    // Already handled this generation: never re-apply, even if the effect re-runs.
    if (token !== null && token === input.lastConsumedToken) {
        return { apply: false, consumedToken: input.lastConsumedToken };
    }

    // The user has moved on: burn the generation without applying it, so a later
    // effect run cannot resurrect it either.
    if (input.hasEditedSinceOpen) {
        return { apply: false, consumedToken: token };
    }

    return { apply: true, consumedToken: token };
}
