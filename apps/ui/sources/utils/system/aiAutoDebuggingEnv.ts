export const AI_AUTO_DEBUG_PUBLIC_ENV_KEY = 'PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING';

function readBooleanFlag(value: unknown): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return false;

    // Conventional env bool parsing. Treat anything else (including "0", "false") as disabled.
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Guarded opt-in for local-only remote logging that may include sensitive data.
 * Always returns false in production.
 */
export function readAiAutoDebugRemoteLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.NODE_ENV === 'production') return false;
    return readBooleanFlag(env[AI_AUTO_DEBUG_PUBLIC_ENV_KEY]);
}
