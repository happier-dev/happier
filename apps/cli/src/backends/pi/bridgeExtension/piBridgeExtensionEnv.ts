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
 * Pi CLI flag enabling the full session-agent tool surface (session_list,
 * session_message_send, session_spawn_new, … — every Happier built-in tool declared on
 * the `session_agent` action surface). Absent (the default) keeps the surface off: only
 * the launch-flag-gated change_title/memory tools register, preserving the conservative
 * baseline while the surface is being rolled out.
 */
export const PI_BRIDGE_SESSION_TOOLS_FLAG = 'happy-session-tools';

/**
 * Single-line JSON marker type the bridge extension writes to the Pi child's stderr after
 * each assistant message, carrying the live context usage (`used`, `size`). The Pi RPC
 * backend parses these markers off stderr and merges them into its per-turn token_count
 * agent message, so the UI can display a live context-size badge for Pi sessions (parity
 * with Claude/OpenCode). Stderr is an existing machine-readable side channel (usage-limit
 * markers already ride it) and does not pollute the LLM context.
 */
export const PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE = 'happy-pi-token-count';

/**
 * Pi CLI flag carrying the daemon-resolved action ids disabled for the
 * `session_agent` surface. The value is a JSON string array. The generated extension
 * uses this projection to filter native tool registration and to guard
 * `action_execute`, while the daemon remains the actions-policy owner.
 */
export const PI_BRIDGE_DISABLED_ACTION_IDS_FLAG = 'happy-session-disabled-actions';
