import { logger } from '@/ui/logger';

import { readSharedManagedOpenCodeServerStateBestEffort } from './sharedManagedOpenCodeServerState';

const HEALTH_PROBE_TIMEOUT_ENV_KEY = 'HAPPIER_OPENCODE_MANAGED_SERVER_SHUTDOWN_HEALTH_TIMEOUT_MS';
const SHUTDOWN_GRACE_TIMEOUT_ENV_KEY = 'HAPPIER_OPENCODE_MANAGED_SERVER_SHUTDOWN_GRACE_TIMEOUT_MS';
const FORCE_KILL_WAIT_TIMEOUT_ENV_KEY = 'HAPPIER_OPENCODE_MANAGED_SERVER_SHUTDOWN_FORCE_WAIT_TIMEOUT_MS';
const SHUTDOWN_POLL_INTERVAL_ENV_KEY = 'HAPPIER_OPENCODE_MANAGED_SERVER_SHUTDOWN_POLL_INTERVAL_MS';

function resolvePositiveIntEnv(
    key: string,
    fallback: number,
    bounds: Readonly<{ min: number; max: number }>,
): number {
    const raw = typeof process.env[key] === 'string' ? process.env[key]?.trim() : '';
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function buildOpenCodeHealthUrl(baseUrl: string): string | null {
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/global/health`;
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return null;
    }
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
}

async function waitForPidExit(pid: number, timeoutMs: number, intervalMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return !isPidAlive(pid);
}

async function probeOpenCodeHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
    const url = buildOpenCodeHealthUrl(baseUrl);
    if (!url) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
        const response = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
        }).catch(() => null);
        return response?.ok === true;
    } finally {
        clearTimeout(timer);
    }
}

function sendSignalBestEffort(pid: number, signal: NodeJS.Signals): boolean {
    try {
        process.kill(pid, signal);
        return true;
    } catch {
        return false;
    }
}

export async function stopSharedManagedOpenCodeServerBestEffort(): Promise<void> {
    const state = await readSharedManagedOpenCodeServerStateBestEffort();
    if (!state) return;
    if (state.pid <= 1 || state.pid === process.pid) return;
    if (!isPidAlive(state.pid)) return;

    const healthTimeoutMs = resolvePositiveIntEnv(HEALTH_PROBE_TIMEOUT_ENV_KEY, 750, { min: 50, max: 10_000 });
    const isReachableOpenCodeServer = await probeOpenCodeHealth(state.baseUrl, healthTimeoutMs);
    if (!isReachableOpenCodeServer) {
        logger.debug('[DAEMON RUN] Skipping OpenCode managed server shutdown because health probe failed');
        return;
    }

    const graceTimeoutMs = resolvePositiveIntEnv(SHUTDOWN_GRACE_TIMEOUT_ENV_KEY, 5_000, { min: 100, max: 30_000 });
    const forceWaitTimeoutMs = resolvePositiveIntEnv(FORCE_KILL_WAIT_TIMEOUT_ENV_KEY, 500, { min: 50, max: 10_000 });
    const pollIntervalMs = resolvePositiveIntEnv(SHUTDOWN_POLL_INTERVAL_ENV_KEY, 50, { min: 10, max: 1_000 });

    logger.debug(`[DAEMON RUN] Stopping OpenCode managed server pid ${state.pid}`);
    sendSignalBestEffort(state.pid, 'SIGTERM');
    if (await waitForPidExit(state.pid, graceTimeoutMs, pollIntervalMs)) return;

    logger.debug(`[DAEMON RUN] Force stopping OpenCode managed server pid ${state.pid}`);
    sendSignalBestEffort(state.pid, 'SIGKILL');
    await waitForPidExit(state.pid, forceWaitTimeoutMs, pollIntervalMs);
}
