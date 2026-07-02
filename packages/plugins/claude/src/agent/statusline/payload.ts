/**
 * Claude Code statusline payload (probe-verified against Claude 2.1.170).
 *
 * Claude pipes this JSON to the configured `statusLine.command` on every state change
 * (~300ms debounce); Happier's statusline forwarder wrapper POSTs it to the session
 * hook server (`/hook/statusline`).
 *
 * EVERY field is optional: the payload shape is Claude-owned and versions freely
 * (`effort.level` was already absent on haiku). Unknown additions pass through untouched.
 */
export interface ClaudeStatuslinePayload {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    version?: string;
    model?: {
        id?: string;
        display_name?: string;
        [key: string]: unknown;
    };
    workspace?: {
        current_dir?: string;
        project_dir?: string;
        added_dirs?: unknown;
        repo?: unknown;
        [key: string]: unknown;
    };
    output_style?: { name?: string; [key: string]: unknown };
    cost?: {
        total_cost_usd?: number;
        total_duration_ms?: number;
        total_api_duration_ms?: number;
        total_lines_added?: number;
        total_lines_removed?: number;
        [key: string]: unknown;
    };
    context_window?: {
        total_input_tokens?: number;
        total_output_tokens?: number;
        context_window_size?: number;
        current_usage?: number | null;
        used_percentage?: number | null;
        remaining_percentage?: number | null;
        [key: string]: unknown;
    };
    exceeds_200k_tokens?: boolean;
    fast_mode?: boolean;
    thinking?: { enabled?: boolean; [key: string]: unknown };
    effort?: { level?: string; [key: string]: unknown };
    [key: string]: unknown;
}

/**
 * Lenient parse: any JSON object is a valid payload (all fields optional, unknown fields
 * preserved); anything else is rejected with `null` so consumers never see junk shapes.
 */
export function parseClaudeStatuslinePayload(raw: unknown): ClaudeStatuslinePayload | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as ClaudeStatuslinePayload;
}
