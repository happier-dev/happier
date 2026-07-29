/**
 * The current newest / flagship Claude model id.
 *
 * Single source of truth for the contexts that want "the best Claude model available right
 * now" rather than a pinned version: the Pi backend startup model, the OpenCode retired-model
 * replacement, and the bare `opus` alias. Bump this ONE constant when a new flagship Opus ships
 * — the selectable Claude catalog (`packages/plugins/claude`) is maintained separately.
 *
 * Lives in protocol because it is shared by several independent plugins (claude, pi, opencode)
 * that must not depend on one another. Invariant: this must be an id present in the Claude static
 * catalog (guarded by a catalog test), so it can never drift to a non-selectable model.
 */
export const CURRENT_FLAGSHIP_CLAUDE_MODEL_ID = 'claude-opus-5';
