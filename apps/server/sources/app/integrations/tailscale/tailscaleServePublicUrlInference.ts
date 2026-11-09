import {
    TailscaleCommandError,
    runTailscaleServeStatus,
    sanitizeTailscaleEnv,
} from "@happier-dev/cli-common/tailscale";

import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import { logger } from '@/utils/logging/log';
import { inferPublicServerUrlFromTailscaleStatus } from "./inferPublicServerUrlFromTailscaleStatus";

type TailscaleServeStatusRunner = (params: Readonly<{
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    tailscaleBin?: string;
}>) => Promise<string>;

async function runLocalTailscaleServeStatus(params: Readonly<{
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    tailscaleBin?: string;
}>): Promise<string> {
    const timeoutMs = Math.max(1, Math.min(10_000, Math.trunc(params.timeoutMs)));
    const mergedEnv = sanitizeTailscaleEnv({ ...process.env, ...params.env });
    return await runTailscaleServeStatus({
        env: mergedEnv,
        tailscaleBin: params.tailscaleBin,
        timeoutMs,
    });
}

function resolveTailscaleServeStatusTimeoutMs(env: NodeJS.ProcessEnv): number {
    const raw = String(env.HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS ?? "").trim();
    return parseIntEnv(raw, 750, { min: 1, max: 10_000 });
}

function shouldInferFromEnv(env: NodeJS.ProcessEnv): boolean {
    return parseBooleanEnv(env.HAPPIER_TAILSCALE_INFER_PUBLIC_URL, true);
}

export async function inferTailscaleServePublicServerUrl(
    env: NodeJS.ProcessEnv,
    deps?: Readonly<{ runTailscaleServeStatus?: TailscaleServeStatusRunner }>,
): Promise<string | null> {
    if (!shouldInferFromEnv(env)) return null;

    const statusTimeoutMs = resolveTailscaleServeStatusTimeoutMs(env);

    try {
        const status = await (deps?.runTailscaleServeStatus ?? runLocalTailscaleServeStatus)({
            timeoutMs: statusTimeoutMs,
            env,
        });
        return inferPublicServerUrlFromTailscaleStatus(env, status);
    } catch (error) {
        if (error instanceof TailscaleCommandError && error.failure) {
            logger.warn({ ...error.failure, phase: 'tailscale.serve.status' }, error.message);
        }
        return null;
    }
}
