/**
 * Optional runtime configuration handed to the renderer.
 *
 * The app reads `window.__HAPPIER_WEB_RUNTIME_CONFIG__` (see
 * `apps/ui/sources/sync/runtime/webRuntimeConfig.ts`) to learn which relay to talk to. Without it —
 * and without a relay baked into the web bundle at export time — the app starts with no server and
 * shows "Relay not supported"; that is true of the Tauri target too, which normally receives the
 * value from a stack launch. Setting `HAPPIER_DESKTOP_SERVER_URL` gives this target the same
 * starting point without rebuilding the bundle.
 *
 * It travels as a preload argument rather than an environment read because a sandboxed preload
 * reaches `process.argv`, which is the documented channel for host-supplied startup data.
 */

export const RUNTIME_CONFIG_ARGUMENT_PREFIX = '--happier-runtime-config=';

export type DesktopRuntimeConfig = Readonly<{
    serverUrl?: string;
    serverContext?: string;
}>;

export function readRuntimeConfigFromEnvironment(
    readEnv: (key: string) => string | undefined = (key) => process.env[key],
): DesktopRuntimeConfig | null {
    const serverUrl = readEnv('HAPPIER_DESKTOP_SERVER_URL')?.trim();
    const serverContext = readEnv('HAPPIER_DESKTOP_SERVER_CONTEXT')?.trim();
    if (!serverUrl && !serverContext) return null;
    return {
        ...(serverUrl ? { serverUrl } : {}),
        ...(serverContext ? { serverContext } : {}),
    };
}

export function encodeRuntimeConfigArgument(config: DesktopRuntimeConfig): string {
    return `${RUNTIME_CONFIG_ARGUMENT_PREFIX}${JSON.stringify(config)}`;
}

export function decodeRuntimeConfigArgument(argv: readonly string[]): DesktopRuntimeConfig | null {
    const argument = argv.find((value) => value.startsWith(RUNTIME_CONFIG_ARGUMENT_PREFIX));
    if (argument === undefined) return null;
    try {
        const parsed: unknown = JSON.parse(argument.slice(RUNTIME_CONFIG_ARGUMENT_PREFIX.length));
        if (!parsed || typeof parsed !== 'object') return null;
        const record = parsed as Record<string, unknown>;
        const serverUrl = typeof record.serverUrl === 'string' ? record.serverUrl : undefined;
        const serverContext = typeof record.serverContext === 'string' ? record.serverContext : undefined;
        if (serverUrl === undefined && serverContext === undefined) return null;
        return {
            ...(serverUrl ? { serverUrl } : {}),
            ...(serverContext ? { serverContext } : {}),
        };
    } catch {
        return null;
    }
}
