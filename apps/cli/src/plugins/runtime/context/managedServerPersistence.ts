import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export type ManagedServerPersistentState = Readonly<{
    v?: 2;
    baseUrl: string;
    pid: number;
    startedAtMs: number;
    status?: 'starting' | 'ready' | 'failed';
    launchEnvFingerprint?: string;
    ownerToken?: string;
    startTimeMs?: number;
    expectedCmdlineHash?: string;
    activeServerDir?: string;
    daemonInstanceId?: string;
}>;

type ManagedServerProcessInfo = Readonly<{
    command: string;
    startedAtMs: number | null;
}>;

type ReleaseFromStateDeps = Readonly<{
    readState: () => Promise<ManagedServerPersistentState | null>;
    removeState: () => Promise<void>;
    isPidAlive: (pid: number) => boolean;
    readProcessInfo: (pid: number) => Promise<ManagedServerProcessInfo | null>;
    killPid: (pid: number, drainMs: number) => Promise<boolean> | boolean;
    isExpectedProcessCommand: (command: string) => boolean;
    expectedOwnerToken: string | null;
    expectedActiveServerDir: string | null;
    expectedDaemonInstanceId: string | null;
    drainMs: number;
    trackedClaimCount: number;
    allowCurrentSessionClaim?: boolean;
    /**
     * Final defense-in-depth gate before the sole-claimant kill: when the server's sole remaining
     * claimant has a turn in flight, refuse the kill and leave BOTH the process AND the state file
     * intact (the orphan-reap collects it at quiescence). Fail-closed: any throw / non-`true` result
     * proceeds with the kill, so a missing in-flight signal never pins a server. Generic across every
     * managed-server provider (OpenCode serve, Codex app-server, …).
     */
    hasInFlightTurnForLaunchFingerprint?: () => Promise<boolean> | boolean;
}>;

export type ManagedServerSwitchReleaseResult = Readonly<{
    released: boolean;
    reason:
        | 'released'
        | 'state_missing'
        | 'state_untrusted'
        | 'owner_token_mismatch'
        | 'daemon_instance_mismatch'
        | 'active_server_dir_mismatch'
        | 'pid_dead'
        | 'process_identity_mismatch'
        | 'tracked_session_claimed'
        | 'in_flight_turn';
}>;

export type ManagedServerStatePathParams = Readonly<{
    env?: NodeJS.ProcessEnv;
    overrideEnvKey: string;
    namespace: string;
    fingerprintInput: Readonly<Record<string, string>>;
}>;

function hashCommandLine(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function hashFingerprintInput(input: Readonly<Record<string, string>>): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readPositiveInt(value: unknown): number | undefined {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
    return Math.floor(numeric);
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
}

function isCompatibleProcessStartTime(expectedMs: number, observedMs: number): boolean {
    return Math.abs(expectedMs - observedMs) <= 2_000;
}

function resolveRemainingTrackedClaimCount(input: Readonly<{
    trackedClaimCount: number;
    allowCurrentSessionClaim: boolean;
}>): number {
    const claimCount = Number.isFinite(input.trackedClaimCount) && input.trackedClaimCount > 0
        ? Math.floor(input.trackedClaimCount)
        : 0;
    return input.allowCurrentSessionClaim ? Math.max(0, claimCount - 1) : claimCount;
}

function isTrustedManagedServerStateV2(state: ManagedServerPersistentState): boolean {
    return state.v === 2
        && Boolean(readNonEmptyString(state.ownerToken))
        && Boolean(readNonEmptyString(state.expectedCmdlineHash))
        && Boolean(readNonEmptyString(state.activeServerDir))
        && Boolean(readNonEmptyString(state.daemonInstanceId))
        && Boolean(Number.isFinite(state.startTimeMs) && (state.startTimeMs ?? 0) > 0);
}

function normalizeState(raw: unknown): ManagedServerPersistentState | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const baseUrl = typeof rec.baseUrl === 'string' ? rec.baseUrl.trim() : '';
    const pidRaw = typeof rec.pid === 'number' ? rec.pid : Number(rec.pid);
    const startedAtMsRaw = typeof rec.startedAtMs === 'number' ? rec.startedAtMs : Number(rec.startedAtMs);
    const statusRaw = typeof rec.status === 'string' ? rec.status.trim() : '';
    if (!baseUrl) return null;
    if (!Number.isFinite(pidRaw) || pidRaw <= 0) return null;
    if (!Number.isFinite(startedAtMsRaw) || startedAtMsRaw <= 0) return null;

    return {
        ...(rec.v === 2 ? { v: 2 as const } : {}),
        baseUrl,
        pid: Math.floor(pidRaw),
        startedAtMs: Math.floor(startedAtMsRaw),
        ...(statusRaw === 'starting' || statusRaw === 'ready' || statusRaw === 'failed' ? { status: statusRaw } : {}),
        ...(readNonEmptyString(rec.launchEnvFingerprint) ? { launchEnvFingerprint: readNonEmptyString(rec.launchEnvFingerprint) ?? undefined } : {}),
        ...(readNonEmptyString(rec.ownerToken) ? { ownerToken: readNonEmptyString(rec.ownerToken) ?? undefined } : {}),
        ...(readPositiveInt(rec.startTimeMs) ? { startTimeMs: readPositiveInt(rec.startTimeMs) } : {}),
        ...(readNonEmptyString(rec.expectedCmdlineHash) ? { expectedCmdlineHash: readNonEmptyString(rec.expectedCmdlineHash) ?? undefined } : {}),
        ...(readNonEmptyString(rec.activeServerDir) ? { activeServerDir: readNonEmptyString(rec.activeServerDir) ?? undefined } : {}),
        ...(readNonEmptyString(rec.daemonInstanceId) ? { daemonInstanceId: readNonEmptyString(rec.daemonInstanceId) ?? undefined } : {}),
    };
}

function sendSignalBestEffort(pid: number, signal: NodeJS.Signals): boolean {
    try {
        process.kill(pid, signal);
        return true;
    } catch {
        return false;
    }
}

async function waitForPidExit(pid: number, timeoutMs: number, intervalMs: number = 50): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return !isPidAlive(pid);
}

async function terminatePidBestEffort(pid: number, drainMs: number): Promise<boolean> {
    sendSignalBestEffort(pid, 'SIGTERM');
    if (await waitForPidExit(pid, Math.max(250, Math.floor(drainMs)))) return true;
    sendSignalBestEffort(pid, 'SIGKILL');
    return await waitForPidExit(pid, 1_000);
}

async function readProcessInfoBestEffort(pid: number): Promise<ManagedServerProcessInfo | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        const command = execFileSync(
            'ps',
            ['-o', 'command=', '-p', String(pid)],
            { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
        ).trim();
        if (!command) return null;
        const startedAtRaw = execFileSync(
            'ps',
            ['-o', 'lstart=', '-p', String(pid)],
            { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
        ).trim();
        const startedAtMs = Number.isFinite(Date.parse(startedAtRaw))
            ? Date.parse(startedAtRaw)
            : null;
        return {
            command,
            startedAtMs,
        };
    } catch {
        return null;
    }
}

async function probeHttpHealth(baseUrl: string, params: Readonly<{
    buildHealthUrl: (baseUrl: string) => string | null;
    timeoutMs: number;
}>): Promise<boolean> {
    const url = params.buildHealthUrl(baseUrl);
    if (!url) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
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

export function resolveManagedServerStatePath(params: ManagedServerStatePathParams): string {
    const env = params.env ?? process.env;
    const raw = typeof env[params.overrideEnvKey] === 'string'
        ? (env[params.overrideEnvKey] as string).trim()
        : '';
    const expanded = expandHomeDirPath(raw, env);
    if (expanded) return expanded;

    const fingerprint = hashFingerprintInput(params.fingerprintInput);
    return join(configuration.happyHomeDir, params.namespace, 'managed-servers', `${fingerprint}.json`);
}

export async function readManagedServerStateAtPathBestEffort(
    statePath: string,
): Promise<ManagedServerPersistentState | null> {
    try {
        if (dirname(statePath) === statePath) return null;
        const raw = await readFile(statePath, 'utf8');
        return normalizeState(JSON.parse(raw));
    } catch {
        return null;
    }
}

export async function readManagedServerStateBestEffort(
    params: ManagedServerStatePathParams,
): Promise<ManagedServerPersistentState | null> {
    return await readManagedServerStateAtPathBestEffort(resolveManagedServerStatePath(params));
}

export async function releaseManagedServerForSwitchFromState(
    deps: ReleaseFromStateDeps,
): Promise<ManagedServerSwitchReleaseResult> {
    const state = await deps.readState();
    if (!state) return { released: false, reason: 'state_missing' };

    if (!isTrustedManagedServerStateV2(state)) {
        await deps.removeState().catch(() => {});
        return { released: false, reason: 'state_untrusted' };
    }

    const expectedOwnerToken = readNonEmptyString(deps.expectedOwnerToken);
    const stateOwnerToken = readNonEmptyString(state.ownerToken);
    if (expectedOwnerToken && stateOwnerToken && stateOwnerToken !== expectedOwnerToken) {
        await deps.removeState().catch(() => {});
        return { released: false, reason: 'owner_token_mismatch' };
    }

    const expectedDaemonInstanceId = readNonEmptyString(deps.expectedDaemonInstanceId);
    const stateDaemonInstanceId = readNonEmptyString(state.daemonInstanceId);
    if (expectedDaemonInstanceId && stateDaemonInstanceId && stateDaemonInstanceId !== expectedDaemonInstanceId) {
        await deps.removeState().catch(() => {});
        return { released: false, reason: 'daemon_instance_mismatch' };
    }

    const expectedActiveServerDir = readNonEmptyString(deps.expectedActiveServerDir);
    const stateActiveServerDir = readNonEmptyString(state.activeServerDir);
    if (expectedActiveServerDir && stateActiveServerDir && stateActiveServerDir !== expectedActiveServerDir) {
        await deps.removeState().catch(() => {});
        return { released: false, reason: 'active_server_dir_mismatch' };
    }

    if (!deps.isPidAlive(state.pid)) {
        await deps.removeState().catch(() => {});
        return { released: false, reason: 'pid_dead' };
    }

    const remainingClaimCount = resolveRemainingTrackedClaimCount({
        trackedClaimCount: deps.trackedClaimCount,
        allowCurrentSessionClaim: deps.allowCurrentSessionClaim === true,
    });
    if (remainingClaimCount > 0) {
        return { released: false, reason: 'tracked_session_claimed' };
    }

    const processInfo = await deps.readProcessInfo(state.pid);
    if (!processInfo || !deps.isExpectedProcessCommand(processInfo.command)) {
        await deps.removeState().catch(() => {});
        return { released: false, reason: 'process_identity_mismatch' };
    }

    const expectedCmdlineHash = readNonEmptyString(state.expectedCmdlineHash);
    if (expectedCmdlineHash && expectedCmdlineHash !== hashCommandLine(processInfo.command)) {
        await deps.removeState().catch(() => {});
        return { released: false, reason: 'process_identity_mismatch' };
    }

    if (Number.isFinite(state.startTimeMs) && state.startTimeMs && processInfo.startedAtMs) {
        if (!isCompatibleProcessStartTime(state.startTimeMs, processInfo.startedAtMs)) {
            await deps.removeState().catch(() => {});
            return { released: false, reason: 'process_identity_mismatch' };
        }
    }

    if (deps.hasInFlightTurnForLaunchFingerprint) {
        const turnInFlight = await Promise.resolve()
            .then(() => deps.hasInFlightTurnForLaunchFingerprint?.())
            .catch(() => false);
        if (turnInFlight === true) {
            return { released: false, reason: 'in_flight_turn' };
        }
    }

    await deps.killPid(state.pid, deps.drainMs);
    await deps.removeState().catch(() => {});
    return { released: true, reason: 'released' };
}

export async function releaseManagedServerForSwitch(params: ManagedServerStatePathParams & Readonly<{
    isExpectedProcessCommand: (command: string) => boolean;
    previousStatePath?: string | null;
    expectedOwnerToken?: string | null;
    expectedActiveServerDir?: string | null;
    expectedDaemonInstanceId?: string | null;
    drainMs: number;
    trackedClaimCount: number;
    allowCurrentSessionClaim?: boolean;
    hasInFlightTurnForLaunchFingerprint?: () => Promise<boolean> | boolean;
}>): Promise<ManagedServerSwitchReleaseResult> {
    const previousStatePath = readNonEmptyString(params.previousStatePath)
        ?? resolveManagedServerStatePath(params);
    return await releaseManagedServerForSwitchFromState({
        readState: async () => await readManagedServerStateAtPathBestEffort(previousStatePath),
        removeState: async () => {
            await rm(previousStatePath, { force: true });
        },
        isPidAlive,
        readProcessInfo: readProcessInfoBestEffort,
        killPid: terminatePidBestEffort,
        isExpectedProcessCommand: params.isExpectedProcessCommand,
        expectedOwnerToken: params.expectedOwnerToken ?? null,
        expectedActiveServerDir: params.expectedActiveServerDir ?? configuration.activeServerDir,
        expectedDaemonInstanceId: params.expectedDaemonInstanceId ?? null,
        drainMs: params.drainMs,
        trackedClaimCount: params.trackedClaimCount,
        allowCurrentSessionClaim: params.allowCurrentSessionClaim,
        ...(params.hasInFlightTurnForLaunchFingerprint
            ? { hasInFlightTurnForLaunchFingerprint: params.hasInFlightTurnForLaunchFingerprint }
            : {}),
    });
}

export async function stopManagedServerBestEffort(params: ManagedServerStatePathParams & Readonly<{
    buildHealthUrl: (baseUrl: string) => string | null;
    healthTimeoutMs: number;
    graceTimeoutMs: number;
    forceWaitTimeoutMs: number;
    pollIntervalMs: number;
    logLabel: string;
}>): Promise<void> {
    const state = await readManagedServerStateBestEffort(params);
    if (!state) return;
    if (state.pid <= 1 || state.pid === process.pid) return;
    if (!isPidAlive(state.pid)) return;

    const isReachableManagedServer = await probeHttpHealth(state.baseUrl, {
        buildHealthUrl: params.buildHealthUrl,
        timeoutMs: params.healthTimeoutMs,
    });
    if (!isReachableManagedServer) {
        logger.debug(`[DAEMON RUN] Skipping ${params.logLabel} managed server shutdown because health probe failed`);
        return;
    }

    logger.debug(`[DAEMON RUN] Stopping ${params.logLabel} managed server pid ${state.pid}`);
    sendSignalBestEffort(state.pid, 'SIGTERM');
    if (await waitForPidExit(state.pid, params.graceTimeoutMs, params.pollIntervalMs)) return;

    logger.debug(`[DAEMON RUN] Force stopping ${params.logLabel} managed server pid ${state.pid}`);
    sendSignalBestEffort(state.pid, 'SIGKILL');
    await waitForPidExit(state.pid, params.forceWaitTimeoutMs, params.pollIntervalMs);
}
