/**
 * The current newest / flagship Claude model id shared by Agent implementations.
 *
 * This is Agent policy rather than a model-Provider declaration: Claude uses it for
 * its bare `opus` alias, Pi uses it for Anthropic startup, and OpenCode uses it as
 * the replacement for retired Claude models. The Claude selectable-model catalog
 * separately verifies that this id remains selectable.
 */
export const CURRENT_FLAGSHIP_CLAUDE_MODEL_ID = 'claude-opus-5';
