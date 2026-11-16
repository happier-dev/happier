// A resume response can carry the complete Codex thread. Preserve the established
// 0.2 app-server boundary instead of introducing a lower plugin-only rejection cap.
const DEFAULT_JSON_LINE_MAX_CHARS = 128 * 1024 * 1024;

export const CODEX_APP_SERVER_MAX_JSON_LINE_CHARS_ENV_KEY = 'HAPPIER_CODEX_APP_SERVER_MAX_JSON_LINE_CHARS';

function readPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function readJsonLineMaxChars(env: Readonly<Record<string, string | undefined>>): number {
    return readPositiveInteger(env[CODEX_APP_SERVER_MAX_JSON_LINE_CHARS_ENV_KEY], DEFAULT_JSON_LINE_MAX_CHARS);
}
