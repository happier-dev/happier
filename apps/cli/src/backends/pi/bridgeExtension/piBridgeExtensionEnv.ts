/**
 * Contract shared by the Happier Pi launcher, generated bridge, and RPC decoder.
 * The launcher passes the protected configuration path only alongside the explicit
 * bridge extension. The configuration binds tools, prompt guidance, and observed
 * extension input to that Happier session; unbound extensions remain inert.
 */

/** Pi CLI flag selecting the protected Happier session configuration. */
export const PI_BRIDGE_CONFIG_PATH_FLAG = 'happy-tools-config';

/**
 * Single-line JSON marker type the bridge extension writes to the Pi child's stderr after
 * each assistant message, carrying the live context usage (`used`, `size`). The Pi RPC
 * backend parses these markers off stderr and merges them into its per-turn token_count
 * agent message, so the UI can display a live context-size badge for Pi sessions (parity
 * with Claude/OpenCode). Stderr is an existing machine-readable side channel (usage-limit
 * markers already ride it) and does not pollute the LLM context.
 */
export const PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE = 'happy-pi-token-count';

/** Structured payload carried by Pi's public RPC UI notification channel. */
export const PI_BRIDGE_USER_INPUT_MARKER_TYPE = 'happy-pi-user-input';
