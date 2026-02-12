export function buildScmNonInteractiveEnv(
    overrides?: Record<string, string | undefined>,
): Record<string, string | undefined> {
    return {
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        ...(overrides ?? {}),
    };
}
