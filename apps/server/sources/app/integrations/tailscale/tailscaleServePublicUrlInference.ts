import { spawn } from "node:child_process";

import { parseBooleanEnv, parseIntEnv } from "@/config/env";
import { parseTailscaleServeHttpsBaseUrlForPort } from "./tailscaleServeStatusParse";

type TailscaleServeStatusRunner = (params: Readonly<{
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    tailscaleBin: string;
}>) => Promise<string>;

function resolveTailscaleServeStatusTimeoutMs(env: NodeJS.ProcessEnv): number {
    const raw = String(env.HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS ?? "").trim();
    return parseIntEnv(raw, 750, { min: 1, max: 10_000 });
}

function resolveTailscaleBin(env: NodeJS.ProcessEnv): string {
    const explicit = String(env.HAPPIER_TAILSCALE_BIN ?? "").trim();
    return explicit || "tailscale";
}

function resolveApiPort(env: NodeJS.ProcessEnv): number {
    const raw = String(env.PORT ?? "").trim();
    return parseIntEnv(raw, 3005, { min: 1, max: 65_535 });
}

function shouldInferFromEnv(env: NodeJS.ProcessEnv): boolean {
    return parseBooleanEnv(env.HAPPIER_TAILSCALE_INFER_PUBLIC_URL, true);
}

async function runTailscaleServeStatus(params: Readonly<{
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    tailscaleBin: string;
}>): Promise<string> {
    const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
    const tailscaleBin = String(params.tailscaleBin ?? "").trim() || "tailscale";

    return await new Promise<string>((resolve, reject) => {
        const child = spawn(tailscaleBin, ["serve", "status"], {
            env: params.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // ignore
            }
            reject(new Error("tailscale serve status timeout"));
        }, timeoutMs);
        timer.unref?.();

        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk ?? "");
        });
        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk ?? "");
        });

        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
                return;
            }
            reject(new Error(`tailscale serve status failed (${code ?? "unknown"}): ${stderr}`));
        });
    });
}

export async function inferAndApplyTailscaleServePublicServerUrl(
    env: NodeJS.ProcessEnv,
    deps?: Readonly<{ runTailscaleServeStatus?: TailscaleServeStatusRunner }>,
): Promise<string | null> {
    if (String(env.HAPPIER_PUBLIC_SERVER_URL ?? "").trim()) return null;
    if (!shouldInferFromEnv(env)) return null;

    const port = resolveApiPort(env);
    const statusTimeoutMs = resolveTailscaleServeStatusTimeoutMs(env);
    const tailscaleBin = resolveTailscaleBin(env);

    try {
        const status = await (deps?.runTailscaleServeStatus ?? runTailscaleServeStatus)({
            timeoutMs: statusTimeoutMs,
            env,
            tailscaleBin,
        });
        const inferred = parseTailscaleServeHttpsBaseUrlForPort(status, port);
        if (!inferred) return null;
        if (String(env.HAPPIER_PUBLIC_SERVER_URL ?? "").trim()) return null;
        env.HAPPIER_PUBLIC_SERVER_URL = inferred;
        return inferred;
    } catch {
        return null;
    }
}
