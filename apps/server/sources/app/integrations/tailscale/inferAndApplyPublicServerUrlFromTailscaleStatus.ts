import { tailscaleServeHttpsUrlForInternalServerUrlFromStatus } from "@happier-dev/cli-common/tailscale";

import { parseIntEnv } from "@/config/env";

function resolveApiPort(env: NodeJS.ProcessEnv): number {
    const raw = String(env.PORT ?? "").trim();
    return parseIntEnv(raw, 3005, { min: 1, max: 65_535 });
}

function resolveInternalServerUrl(port: number): string {
    return `http://127.0.0.1:${port}`;
}

export function inferAndApplyPublicServerUrlFromTailscaleStatus(
    env: NodeJS.ProcessEnv,
    statusText: string,
): string | null {
    const inferred = tailscaleServeHttpsUrlForInternalServerUrlFromStatus(
        statusText,
        resolveInternalServerUrl(resolveApiPort(env)),
    );
    if (!inferred) return null;
    if (String(env.HAPPIER_PUBLIC_SERVER_URL ?? "").trim()) return null;
    env.HAPPIER_PUBLIC_SERVER_URL = inferred;
    return inferred;
}
