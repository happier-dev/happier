import { parseIntEnv } from "@/config/env";

export function resolveGitHubHttpTimeoutMs(env: NodeJS.ProcessEnv): number {
    const seconds = parseIntEnv(env.GITHUB_HTTP_TIMEOUT_SECONDS, 10, { min: 1, max: 120 });
    return seconds * 1000;
}

