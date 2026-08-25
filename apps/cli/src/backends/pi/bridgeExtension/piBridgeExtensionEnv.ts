/**
 * CLI flag contract shared between the Happier Pi launcher and the generated
 * Pi tools-bridge extension.
 *
 * The launcher (createPiBackend) passes these flags to the Pi child ONLY together with
 * the `--extension <path>` argument for the generated bridge asset — both or neither —
 * and the extension stays fully inert when `happy-session-id` is absent.
 *
 * All bridge configuration rides these flags (no env side channels, no config baked
 * into the generated asset): the daemon resolves the merged coding-prompt settings once
 * per spawn and translates them into flags; the extension derives both its tool
 * registration and the Happier system-prompt addition it appends from the same flags,
 * so the two can never drift.
 */

/** Pi CLI flag carrying the Happier session id the Pi process is bound to. */
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
