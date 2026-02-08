import { parseBooleanEnv } from "@/config/env";

export type UiConfig = {
    dir: string | null;
    /**
     * UI mount prefix for route registration (no trailing slash).
     * - "/" means "mounted at root"
     * - "/ui" means "mounted under /ui"
     */
    prefix: string;
    mountRoot: boolean;
    /**
     * When true, server startup should fail closed if the UI bundle is missing/incomplete.
     * This is intended for local stack orchestration where "serve UI" is an explicit capability.
     */
    required: boolean;
};

export function resolveUiConfig(env: NodeJS.ProcessEnv = process.env): UiConfig {
    const dirRaw = env.HAPPIER_SERVER_UI_DIR ?? env.HAPPIER_SERVER_LIGHT_UI_DIR;
    const dir = typeof dirRaw === 'string' && dirRaw.trim() ? dirRaw.trim() : null;

    const prefixRaw = env.HAPPIER_SERVER_UI_PREFIX ?? env.HAPPIER_SERVER_LIGHT_UI_PREFIX;
    const prefixNormalized = typeof prefixRaw === 'string' && prefixRaw.trim() ? prefixRaw.trim() : '/';
    const mountRoot = prefixNormalized === '/' || prefixNormalized === '';
    const prefix = mountRoot
        ? '/'
        : prefixNormalized.endsWith('/')
            ? prefixNormalized.slice(0, -1)
            : prefixNormalized;

    const requiredRaw = env.HAPPIER_SERVER_UI_REQUIRED ?? env.HAPPIER_SERVER_LIGHT_UI_REQUIRED;
    const required = parseBooleanEnv(requiredRaw, false);

    return { dir, prefix, mountRoot, required };
}
