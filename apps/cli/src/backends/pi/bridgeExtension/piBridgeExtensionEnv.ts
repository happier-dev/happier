/**
 * CLI flag + env contract shared between the Happier Pi launcher and the generated
 * Pi tools-bridge extension.
 *
 * The launcher (createPiBackend) passes these flags to the Pi child ONLY together with
 * the `--extension <path>` argument for the generated bridge asset — both or neither —
 * and the extension stays fully inert when `happy-session-id` is absent.
 */

/** Pi CLI flag carrying the Happier session id the Pi process is bound to. */
export const PI_BRIDGE_SESSION_ID_FLAG = 'happy-session-id';

/** Pi CLI flag suppressing the `change_title` bridge tool. */
export const PI_BRIDGE_DISABLE_RENAME_FLAG = 'happy-disable-rename';

/** Pi CLI flag suppressing the `memory_search` / `memory_get_window` bridge tools. */
export const PI_BRIDGE_DISABLE_MEMORY_FLAG = 'happy-disable-memory';

/** Child env carrying the daemon machine id used by the memory bridge tools. */
export const PI_BRIDGE_MEMORY_MACHINE_ID_ENV = 'HAPPIER_PI_BRIDGE_MEMORY_MACHINE_ID';

/**
 * Single-line JSON marker type the bridge extension writes to the Pi child's stderr after
 * each assistant message, carrying the live context usage (`used`, `size`). The Pi RPC
 * backend parses these markers off stderr and merges them into its per-turn token_count
 * agent message, so the UI can display a live context-size badge for Pi sessions (parity
 * with Claude/OpenCode). Stderr is an existing machine-readable side channel (usage-limit
 * markers already ride it) and does not pollute the LLM context.
 */
export const PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE = 'happy-pi-token-count';
