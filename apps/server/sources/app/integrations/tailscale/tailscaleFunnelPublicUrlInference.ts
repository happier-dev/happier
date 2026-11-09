import {
    TailscaleCommandError,
    runTailscaleFunnelStatus,
    sanitizeTailscaleEnv,
} from "@happier-dev/cli-common/tailscale";

import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import { logger } from '@/utils/logging/log';
import { inferPublicServerUrlFromTailscaleStatus } from "./inferPublicServerUrlFromTailscaleStatus";

type TailscaleFunnelStatusRunner = (params: Readonly<{
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    tailscaleBin?: string;
}>) => Promise<string>;

async function runLocalTailscaleFunnelStatus(params: Readonly<{
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    tailscaleBin?: string;
}>): Promise<string> {
    const timeoutMs = Math.max(1, Math.min(10_000, Math.trunc(params.timeoutMs)));
    const mergedEnv = sanitizeTailscaleEnv({ ...process.env, ...params.env });
    return await runTailscaleFunnelStatus({
        env: mergedEnv,
        tailscaleBin: params.tailscaleBin,
        timeoutMs,
    });
}

function resolveTailscaleFunnelStatusTimeoutMs(env: NodeJS.ProcessEnv): number {
    const raw = String(env.HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS ?? "").trim();
    return parseIntEnv(raw, 750, { min: 1, max: 10_000 });
}

function shouldInferFromEnv(env: NodeJS.ProcessEnv): boolean {
    return parseBooleanEnv(env.HAPPIER_TAILSCALE_INFER_PUBLIC_URL, true);
}

export async function inferTailscaleFunnelPublicServerUrl(
    env: NodeJS.ProcessEnv,
    deps?: Readonly<{ runTailscaleFunnelStatus?: TailscaleFunnelStatusRunner }>,
): Promise<string | null> {
    if (!shouldInferFromEnv(env)) return null;

    const statusTimeoutMs = resolveTailscaleFunnelStatusTimeoutMs(env);

    try {
        const status = await (deps?.runTailscaleFunnelStatus ?? runLocalTailscaleFunnelStatus)({
            timeoutMs: statusTimeoutMs,
            env,
        });
        return inferPublicServerUrlFromTailscaleStatus(env, status);
    } catch (error) {
        if (error instanceof TailscaleCommandError && error.failure) {
            logger.warn({ ...error.failure, phase: 'tailscale.funnel.status' }, error.message);
        }
        return null;
    }
}
