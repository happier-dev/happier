import { readFile, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { Socket } from 'node:net';

import {
    execFileWithDeadline,
    resolveProcessCustodySupportExecutable as resolveSharedProcessCustodySupportExecutable,
    resolveProcessCustodyTargetExecutable as resolveSharedProcessCustodyTargetExecutable,
} from '@happier-dev/cli-common/process';
export { PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME } from '@happier-dev/cli-common/process';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { parseProcessOwnerTag, PROCESS_OWNER_ENV_KEY, resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { configuration } from '@/configuration';

/**
 * The one native-custody owner behind SVC09's exact process-tree custody.
 *
 * This module is the single staged-path owner for the
 * `happier-process-custody` runtime support binary
 * (`tools/unpacked/happier-process-custody`, staged by the daemon-support
 * payload builder):
 * - Windows: named Job Objects. Finite/service launch creates a unique job;
 *   session/interactive-terminal join derives a name from the canonical owner
 *   tag and transfers its non-inheritable handle to the existing runner/host.
 *   Losing that owner does not kill members: own-principal tag+tree evidence
 *   remains the recovery authority after the name ceases to be reopenable.
 *   For finite/service launch the helper creates the job,
 *   starts the target suspended, assigns it before its first instruction, and
 *   resumes it; this module owns the tagged job identity, the post-assignment
 *   handshake, and terminate/query-by-job with full membership absence proofs.
 *   Finite PTY mode retains natural descendants and the observed root code
 *   until whole-job absence; explicit query/Stop recovers missed native empty
 *   notifications through the same job, without polling or a guessed PID.
 * - Darwin: the native subsecond start identity (`darwin-proc`), read through
 *   the helper's validated numeric sysctl witness.
 * - Peer identity (`peer-identity`): the one exact OS peer-identity boundary
 *   for locally inherited IPC connections (Linux SO_PEERCRED, Darwin
 *   LOCAL_PEERPID plus LOCAL_PEERCRED, Windows
 *   GetNamedPipeClientProcessId), consumed by the
 *   private workspace-sync broker's peer validation.
 * Linux never consumes this helper for custody — its custody stays on the
 * dedicated process-group owner — but Linux does consume the same helper for
 * the peer-identity question. Every unsupported question here still answers
 * "unavailable" without touching the filesystem.
 *
 * The native workspace-sync filesystem boundary reuses the same packaged
 * helper through `resolveProcessCustodySupportExecutable`; workspace policy,
 * authority, and result projection remain in the workspace-sync owner.
 */

/** Windows job-custody identity: `winjob:<jobName>`. */
const WINDOWS_JOB_IDENTITY_PREFIX = 'winjob:';
/** Darwin native subsecond identity: `darwin-proc:<pid>:<sec>:<usec>`. */
const DARWIN_NATIVE_IDENTITY_PREFIX = 'darwin-proc:';

/**
 * Resolve the staged native support helper for a purpose-specific command.
 * Command owners keep their own policy and parsing; this remains the single
 * packaged-path authority for the shared helper binary.
 */
export function resolveProcessCustodySupportExecutable(
    platform: NodeJS.Platform = process.platform,
): string | null {
    return resolveSharedProcessCustodySupportExecutable(platform, resolveCliRuntimeAssetPath);
}

/** Static Linux targets or the matching controller's published Darwin helper. */
export function resolveProcessCustodyTargetExecutable(arch: 'x64' | 'arm64', platform: 'linux' | 'darwin' = 'linux'): string | null {
    return resolveSharedProcessCustodyTargetExecutable(arch, platform, resolveCliRuntimeAssetPath);
}

export type ProcessCustodySpawnSpec = Readonly<{
    jobName: string;
    executablePath: string;
    /** Post-assignment marker the helper writes once the target is resumed. */
    handshakePath: string;
}>;

/**
 * The finite PTY carrier uses the same suspended/assigned Windows launch, but
 * retains the job after target-root exit until its complete membership is
 * positively empty. Ordinary SVC09 `run` keeps its root-exit cleanup policy.
 * A raw Windows argument tail is already rendered by its caller; the native
 * verbatim mode must append it unchanged rather than CRT-quote it as one arg.
 */
export function createFiniteProcessCustodyInvocation(input: Readonly<{
    custody: ProcessCustodySpawnSpec;
    command: string;
    args: readonly string[] | string;
    windowsVerbatimArguments?: boolean;
}>): Readonly<{ command: string; args: string[]; custody: ProcessCustodySpawnSpec }> {
    const verbatim = typeof input.args === 'string' || input.windowsVerbatimArguments === true;
    return {
        command: input.custody.executablePath,
        args: [
            'run',
            `--job=${input.custody.jobName}`,
            `--handshake=${input.custody.handshakePath}`,
            '--wait-for-job-empty',
            ...(verbatim ? ['--target-windows-verbatim'] : []),
            '--',
            input.command,
            ...(typeof input.args === 'string' ? [input.args] : input.args),
        ],
        custody: input.custody,
    };
}

export type ProcessCustodyJobOutcome =
    | 'absent'
    | 'live'
    | 'unavailable';

export type ProcessCustodyTerminationOutcome =
    | 'absent'
    | 'members-remaining'
    | 'unavailable';

export type ProcessCustodyNativeWitness = Readonly<{
    sec: number;
    usec: number;
}>;

export type ParsedProcessCustodyStartIdentity =
    | Readonly<{ kind: 'win32-job'; jobName: string }>
    | Readonly<{ kind: 'darwin-proc'; pid: number; sec: number; usec: number }>
    | null;

export type ProcessCustodyExecFile = typeof execFileWithDeadline;

export type ProcessCustodySamplingInput = Readonly<{
    command: 'vitals-sample' | 'process-census';
    sampledAt: number;
    args?: readonly string[];
    signal?: AbortSignal;
}>;
export type ProcessCustodySamplingResult =
    | { state: 'ready'; stdout: string }
    | { state: 'unavailable'; reason: 'helper_missing' | 'helper_failing' };
export type ProcessCustodySamplingExecFile = (command: string, args: readonly string[], options: Parameters<typeof execFileWithDeadline>[2]) => Promise<Readonly<{ stdout: string | Buffer; stdoutTruncated?: boolean }>>;

/** Native sampling shares invocation; only periodic vitals retain minute-boundary failure pacing. */
export function createProcessCustodySamplingInvoker(options: Readonly<{
    execFile?: ProcessCustodySamplingExecFile;
    resolveExecutable?: () => string | null;
}> = {}): (input: ProcessCustodySamplingInput) => Promise<ProcessCustodySamplingResult> {
    let nextVitalsAttempt = 0;
    const run = options.execFile ?? execFileWithDeadline;
    return async (input) => {
        if (input.command === 'vitals-sample' && input.sampledAt < nextVitalsAttempt) return { state: 'unavailable', reason: 'helper_failing' };
        const executable = (options.resolveExecutable ?? resolveProcessCustodySupportExecutable)();
        if (!executable) return { state: 'unavailable', reason: 'helper_missing' };
        try {
            const result = await run(executable, [input.command, ...(input.args ?? [])], {
                encoding: 'utf8', timeout: CUSTODY_RUNTIME_EXEC_TIMEOUT_MS, signal: input.signal,
                windowsHide: true,
                ...(input.command === 'process-census' ? { maxBuffer: Infinity } : {}),
            });
            if (result.stdoutTruncated) throw new Error('Native sampling output was truncated');
            if (input.command === 'vitals-sample') nextVitalsAttempt = 0;
            return { state: 'ready', stdout: String(result.stdout) };
        } catch (error) {
            if (input.command === 'vitals-sample') nextVitalsAttempt = (Math.floor(input.sampledAt / 60_000) + 1) * 60_000;
            const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
            // Keep native execution codes only, never exception text, paths, argv or stderr.
            const errorCode = (typeof code === 'number' && Number.isSafeInteger(code))
                || (typeof code === 'string' && Object.hasOwn(constants.errno, code)) ? code : undefined;
            const { logger } = await import('@/ui/logger');
            logger.infoFile('[process-custody] Native sampling failed', {
                command: input.command, ...(errorCode !== undefined ? { errorCode } : {}),
            });
            return { state: 'unavailable', reason: 'helper_failing' };
        }
    };
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const CUSTODY_RUNTIME_EXEC_TIMEOUT_MS = 10_000;
export const CUSTODY_TERMINATE_TIMEOUT_MS = 5_000;

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Canonical owner-tag names for existing-owner joins; incumbent finite/service
 * launch retains its generation-unique, path-safe invocation identity.
 */
export function createWindowsJobCustodyName(instanceId: string): string {
    if (parseProcessOwnerTag(instanceId)) {
        return `Local\\happier-owner-${Buffer.from(instanceId, 'utf8').toString('base64url')}`;
    }
    const normalized = instanceId.trim();
    if (!normalized || /[^\w-]/u.test(normalized)) {
        throw new TypeError('Windows job custody requires a path-safe instance identity');
    }
    return `Local\\happier-svc09-${normalized}`;
}

/** Only canonical owner-tag names participate in the new holder projection. */
export function parseWindowsJobCustodyOwnerTag(jobName: string): string | null {
    const prefix = 'Local\\happier-owner-';
    if (!jobName.startsWith(prefix)) return null;
    const encoded = jobName.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const tag = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!parseProcessOwnerTag(tag) || createWindowsJobCustodyName(tag) !== jobName) return null;
    return tag;
}

export type ProcessCustodyJoinedJob = Readonly<{
    state: 'joined'; jobName: string; pid: number; holderPid: number;
    holderStartTimeMs: number; holderHandle: string;
}>;
export type ProcessCustodyJobJoinOutcome = ProcessCustodyJoinedJob | Readonly<{ state: 'unavailable' }>;

/** The helper transfers the Job handle into this existing long-lived owner. */
export async function joinProcessCustodyJob(input: Readonly<{
    pid: number; holderPid: number; ownerTag: string;
    platform?: NodeJS.Platform; executablePath?: string | null; execFile?: ProcessCustodyExecFile;
}>): Promise<ProcessCustodyJobJoinOutcome> {
    if ((input.platform ?? process.platform) !== 'win32' || !parseProcessOwnerTag(input.ownerTag)
        || !isPositiveSafeInteger(input.pid) || input.pid <= 1 || !isPositiveSafeInteger(input.holderPid) || input.holderPid <= 1) return { state: 'unavailable' };
    const executable = input.executablePath === undefined ? resolveProcessCustodySupportExecutable('win32') : input.executablePath;
    if (!executable) return { state: 'unavailable' };
    const jobName = createWindowsJobCustodyName(input.ownerTag);
    try {
        const { stdout } = await (input.execFile ?? execFileWithDeadline)(executable, [
            'job-join', `--job=${jobName}`, `--pid=${input.pid}`, `--holder-pid=${input.holderPid}`,
        ], { encoding: 'utf8', timeout: CUSTODY_RUNTIME_EXEC_TIMEOUT_MS, windowsHide: true });
        const value: unknown = JSON.parse(String(stdout));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'unavailable' };
        const result = value as Record<string, unknown>;
        if (Object.keys(result).length !== 7 || result.v !== 1 || result.state !== 'joined' || result.job !== jobName
            || result.pid !== input.pid || result.holderPid !== input.holderPid || !isPositiveSafeInteger(result.holderStartTimeMs)
            || typeof result.holderHandle !== 'string' || !/^[1-9][0-9]*$/.test(result.holderHandle)
            || BigInt(result.holderHandle) >= 0xffffffffffffffffn) return { state: 'unavailable' };
        return { state: 'joined', jobName, pid: input.pid, holderPid: input.holderPid,
            holderStartTimeMs: result.holderStartTimeMs, holderHandle: result.holderHandle };
    } catch { return { state: 'unavailable' }; }
}

/** A terminal exit releases its host-held handle; the native owner checks PID generation. */
export async function releaseProcessCustodyJobHandle(input: Readonly<{
    custody: ProcessCustodyJoinedJob; executablePath?: string | null; execFile?: ProcessCustodyExecFile;
}>): Promise<boolean> {
    const executable = input.executablePath === undefined ? resolveProcessCustodySupportExecutable('win32') : input.executablePath;
    if (!executable) return false;
    try {
        const { stdout } = await (input.execFile ?? execFileWithDeadline)(executable, [
            'job-release', `--holder-pid=${input.custody.holderPid}`, `--holder-handle=${input.custody.holderHandle}`,
            `--holder-start-time-ms=${input.custody.holderStartTimeMs}`,
        ], { encoding: 'utf8', timeout: CUSTODY_RUNTIME_EXEC_TIMEOUT_MS, windowsHide: true });
        const result: unknown = JSON.parse(String(stdout));
        return !!result && typeof result === 'object' && !Array.isArray(result)
            && Object.keys(result).length === 2 && 'v' in result && result.v === 1 && 'state' in result && result.state === 'released';
    } catch { return false; }
}

// One physical runner lifetime owns one Job. Initial binding reuses earliest
// startup's pending/result custody; a Session swap must not create nested Jobs.
let currentWindowsSessionCustody: Promise<ProcessCustodyJobJoinOutcome> | null = null;

/** Earliest inherited-tag startup and manual first binding share this owner. */
export async function joinCurrentWindowsSessionProcessCustody(): Promise<ProcessCustodyJobJoinOutcome | null> {
    if (process.platform !== 'win32') return null;
    const ownerTag = process.env[PROCESS_OWNER_ENV_KEY];
    const owner = parseProcessOwnerTag(ownerTag);
    if (!owner || owner.kind !== 'session' || owner.daemonScopeKey !== resolveProcessOwnerScopeKey(configuration.happyHomeDir)) return null;
    return currentWindowsSessionCustody ??= joinProcessCustodyJob({ pid: process.pid, holderPid: process.pid, ownerTag: ownerTag! });
}

/** Private post-assignment handshake file path for one spawn. */
export function createProcessCustodyHandshakePath(): string {
    return join(tmpdir(), `.happier-svc09-custody-${randomUUID()}.json`);
}

/** One hosted Session child tree uses the existing unique Windows Job launch. */
export function prepareWindowsProcessLaunchCustody(): ProcessCustodySpawnSpec | null {
    const executablePath = resolveProcessCustodyRuntimeExecutable('win32');
    return executablePath ? {
        executablePath,
        jobName: createWindowsJobCustodyName(randomUUID()),
        handshakePath: createProcessCustodyHandshakePath(),
    } : null;
}

/** Best-effort removal of an unread handshake marker; never throws. */
export async function removeProcessCustodyHandshakeFile(handshakePath: string): Promise<void> {
    await rm(handshakePath, { force: true }).catch(() => undefined);
}

/**
 * Resolve the staged custody helper. Published payloads stage it beside the
 * other runtime support binaries; a source checkout may place a locally built
 * helper under `apps/cli/tools/unpacked` for live smoke validation. Absence is
 * a normal answered question (`null`), never a thrown error.
 */
export function resolveProcessCustodyRuntimeExecutable(
    platform: NodeJS.Platform = process.platform,
): string | null {
    if (platform !== 'win32' && platform !== 'darwin') return null;
    return resolveProcessCustodySupportExecutable(platform);
}

export function formatWindowsJobCustodyStartIdentity(jobName: string): string {
    if (!jobName.trim()) {
        throw new TypeError('Windows job custody identity requires the job name');
    }
    return `${WINDOWS_JOB_IDENTITY_PREFIX}${jobName}`;
}

export function formatDarwinNativeStartIdentity(
    pid: number,
    witness: ProcessCustodyNativeWitness,
): string {
    if (!isPositiveSafeInteger(pid) || !isPositiveSafeInteger(witness.sec) || witness.usec < 0 || witness.usec > 999_999) {
        throw new TypeError('Darwin native process identity requires a proven pid and timeval');
    }
    return `${DARWIN_NATIVE_IDENTITY_PREFIX}${pid}:${witness.sec}:${witness.usec}`;
}

/**
 * Parse the opaque persisted startIdentity into its tagged custody facts.
 * Legacy `${pid}:${ms}` records (and anything malformed) parse as `null` so
 * every consumer keeps its predecessor fail-closed behavior.
 */
export function parseProcessCustodyStartIdentity(value: string): ParsedProcessCustodyStartIdentity {
    if (typeof value !== 'string') return null;
    if (value.startsWith(WINDOWS_JOB_IDENTITY_PREFIX)) {
        const jobName = value.slice(WINDOWS_JOB_IDENTITY_PREFIX.length);
        if (!jobName.trim()) return null;
        return Object.freeze({ kind: 'win32-job', jobName });
    }
    if (value.startsWith(DARWIN_NATIVE_IDENTITY_PREFIX)) {
        const match = /^darwin-proc:(\d+):(\d+):(\d+)$/u.exec(value);
        if (!match) return null;
        const pid = Number(match[1]);
        const sec = Number(match[2]);
        const usec = Number(match[3]);
        if (!isPositiveSafeInteger(pid) || !isPositiveSafeInteger(sec) || usec > 999_999) return null;
        return Object.freeze({ kind: 'darwin-proc', pid, sec, usec });
    }
    return null;
}

/**
 * Parse one custody handshake line: `{"v":1,"pid":<target>,"job":"<name>"}`.
 * The helper writes it only after job assignment and resume, so a valid line
 * is the custody-established fact.
 */
export function parseProcessCustodyHandshakeLine(
    raw: string,
    expectedJobName: string,
): Readonly<{ pid: number; jobName: string }> | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.trim());
    } catch {
        return null;
    }
    if (
        !parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
    ) return null;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
        keys.length !== 3
        || keys[0] !== 'job'
        || keys[1] !== 'pid'
        || keys[2] !== 'v'
        || record.v !== 1
        || !isPositiveSafeInteger(record.pid)
        || typeof record.job !== 'string'
    ) return null;
    if (record.job !== expectedJobName) return null;
    return Object.freeze({ pid: record.pid, jobName: expectedJobName });
}

/**
 * Wait a bounded time for the helper's post-assignment handshake file and read
 * exactly the expected job's fact out of it. The marker is consumed (removed)
 * after reading so it can never testify twice.
 */
export async function waitForProcessCustodyHandshake(
    input: Readonly<{
        handshakePath: string;
        jobName: string;
        readFile?: (path: string) => Promise<string>;
        removeFile?: (path: string) => Promise<void>;
        delay?: (ms: number) => Promise<void>;
        isAborted?: () => boolean;
        timeoutMs?: number;
    }>,
): Promise<Readonly<{ pid: number }> | null> {
    const readContents = input.readFile ?? (async (path: string) => await readFile(path, 'utf8'));
    const removeFile = input.removeFile ?? (async (path: string) => {
        await rm(path, { force: true });
    });
    const delay = input.delay ?? (async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
    const deadline = Date.now() + Math.max(1, input.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    while (Date.now() <= deadline) {
        if (input.isAborted?.()) {
            await removeFile(input.handshakePath).catch(() => undefined);
            return null;
        }
        let contents: string | null = null;
        try {
            contents = await readContents(input.handshakePath);
        } catch {
            contents = null;
        }
        if (contents !== null) {
            await removeFile(input.handshakePath).catch(() => undefined);
            const facts = parseProcessCustodyHandshakeLine(contents, input.jobName);
            return facts === null ? null : Object.freeze({ pid: facts.pid });
        }
        await delay(10);
    }
    return null;
}

function readJsonLineOutcome(stdout: string | Buffer): Record<string, unknown> | null {
    const text = (typeof stdout === 'string' ? stdout : Buffer.from(stdout).toString('utf8')).trim();
    if (!text) return null;
    const firstLine = text.split(/\r?\n/u, 1)[0] ?? '';
    try {
        const parsed: unknown = JSON.parse(firstLine);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function readExitCode(error: unknown): number | null {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'number' ? code : null;
}

/**
 * Ask the helper whether the named job object still exists and still holds
 * members. A missing job (or a memberless husk) is `absent`: with
 * KILL_ON_JOB_CLOSE the kernel destroys the job only after every member is
 * terminated, so absence is a proof. Any failure to consult the helper is
 * `unavailable` — fail-closed, never "absent by assumption".
 */
export async function queryProcessCustodyJob(
    input: Readonly<{
        executablePath: string;
        jobName: string;
        execFile?: ProcessCustodyExecFile;
    }>,
): Promise<ProcessCustodyJobOutcome> {
    const run = input.execFile ?? execFileWithDeadline;
    try {
        const result = await run(input.executablePath, ['query', `--job=${input.jobName}`], {
            timeout: CUSTODY_RUNTIME_EXEC_TIMEOUT_MS,
        });
        const outcome = readJsonLineOutcome(result.stdout);
        if (outcome?.state === 'absent') return 'absent';
        if (outcome?.state === 'live') return 'live';
        return 'unavailable';
    } catch {
        return 'unavailable';
    }
}

/**
 * Terminate the named job and prove full membership absence. `members-remaining`
 * means the deadline expired with live members: custody stays with the caller
 * and a retry is expected, mirroring the POSIX `termination_incomplete` path.
 */
export async function terminateProcessCustodyByJob(
    input: Readonly<{
        executablePath: string;
        jobName: string;
        timeoutMs?: number;
        execFile?: ProcessCustodyExecFile;
    }>,
): Promise<ProcessCustodyTerminationOutcome> {
    const run = input.execFile ?? execFileWithDeadline;
    const terminationBudgetMs = Math.max(1, input.timeoutMs ?? CUSTODY_TERMINATE_TIMEOUT_MS);
    try {
        const result = await run(
            input.executablePath,
            ['terminate', `--job=${input.jobName}`, `--timeout-ms=${terminationBudgetMs}`],
            { timeout: terminationBudgetMs + CUSTODY_RUNTIME_EXEC_TIMEOUT_MS },
        );
        const outcome = readJsonLineOutcome(result.stdout);
        if (outcome?.state === 'absent') return 'absent';
        if (outcome?.state === 'members-remaining') return 'members-remaining';
        return 'unavailable';
    } catch (error) {
        // Exit code 3 is the helper's honest "not proven inside the deadline".
        if (readExitCode(error) === 3) return 'members-remaining';
        return 'unavailable';
    }
}

/**
 * Read the native subsecond start identity for one Darwin pid through the
 * validated process-census snapshot. Returns `null` when the helper is
 * unavailable or refuses the parse, which callers must treat as "fall back to
 * the legacy whole-second witness", never as a birth fact.
 */
export async function observeNativeDarwinProcessStartIdentity(
    input: Readonly<{
        executablePath: string;
        pid: number;
        execFile?: ProcessCustodyExecFile;
    }>,
): Promise<ProcessCustodyNativeWitness | null> {
    if (!isPositiveSafeInteger(input.pid)) return null;
    try {
        // The census resolves its helper through this module; load the view lazily to avoid a cycle.
        const { createProcessCensusReader } = await import('@/processes/census/processCensus');
        const snapshot = await createProcessCensusReader({
            platform: 'darwin', helperExecutablePath: input.executablePath, execFile: input.execFile,
        })({ freshness: 'fresh', pids: [input.pid], scope: 'all' });
        if (snapshot.status !== 'ok') return null;
        const native = snapshot.rows.find(row => row.pid === input.pid)?.start.native;
        const identity = native ? parseProcessCustodyStartIdentity(native) : null;
        if (identity?.kind !== 'darwin-proc' || identity.pid !== input.pid) return null;
        return Object.freeze({ sec: identity.sec, usec: identity.usec });
    } catch {
        return null;
    }
}

/**
 * The OS-proven peer identity of one accepted local IPC connection, answered
 * by the helper's `peer-identity` command through the platform's real peer
 * primitive (SO_PEERCRED / LOCAL_PEERPID+LOCAL_PEERCRED /
 * GetNamedPipeClientProcessId). On Windows this primitive provides no user
 * fact, so `uid` is exactly `null` and the broker must separately enforce its
 * user-only pipe ACL.
 */
export type ProcessCustodyPeerIdentity = Readonly<{ pid: number; uid: number | null }>;

/** The platforms whose helper build can answer the peer-identity question. */
export const PROCESS_CUSTODY_PEER_IDENTITY_PLATFORMS = ['linux', 'darwin', 'win32'] as const;

/**
 * Resolve the staged helper for the peer-identity question. Unlike custody,
 * which Linux never consumes, Linux has an exact peer primitive and consumes
 * the same binary; absence stays a normal answered `null`.
 */
export function resolveProcessCustodyPeerIdentityExecutable(
    platform: NodeJS.Platform = process.platform,
): string | null {
    return resolveProcessCustodySupportExecutable(platform);
}

/**
 * Parse the helper's one strict peer-identity line:
 * `{"pid":<pid>,"t":"peer-identity","uid":<uid|null>,"v":1}`.
 * Anything padded, retyped, or out of range is `null`, never a guess.
 */
export function parseProcessCustodyPeerIdentityLine(raw: string): ProcessCustodyPeerIdentity | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || /[\r\n]/u.test(trimmed)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
        keys.length !== 4
        || keys[0] !== 'pid'
        || keys[1] !== 't'
        || keys[2] !== 'uid'
        || keys[3] !== 'v'
        || record.t !== 'peer-identity'
        || record.v !== 1
        || !isPositiveSafeInteger(record.pid)
    ) return null;
    const uid = record.uid;
    if (uid !== null && !(typeof uid === 'number' && Number.isSafeInteger(uid) && uid >= 0)) return null;
    return Object.freeze({ pid: record.pid, uid });
}

/** The narrow child surface the invocation boundary needs from `spawn`. */
export type ProcessCustodyPeerIdentityChild = {
    readonly stdout: NodeJS.ReadableStream | null;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    on(event: 'exit', listener: () => void): unknown;
    kill(signal?: NodeJS.Signals | number): boolean;
};

/**
 * Spawn seam. The helper receives the accepted connection ONLY as the fixed
 * extra descriptor (stdio index 3), never as an argv path, and the command
 * takes no secret: there is nothing here that could leak one.
 */
export type ProcessCustodyPeerIdentitySpawn = (input: Readonly<{
    executablePath: string;
    args: readonly string[];
    stdio: readonly ['ignore', 'pipe', 'pipe', Socket];
}>) => ProcessCustodyPeerIdentityChild;

const PEER_IDENTITY_STDOUT_LIMIT_BYTES = 4096;
const PEER_IDENTITY_TIMEOUT_MS = 2_000;

function spawnProcessCustodyPeerIdentityChild(input: Readonly<{
    executablePath: string;
    args: readonly string[];
    stdio: readonly ['ignore', 'pipe', 'pipe', Socket];
}>): ProcessCustodyPeerIdentityChild {
    // Passing the Socket object itself to child_process transfers its libuv
    // stream wrapper and strands subsequent reads in the parent. On POSIX the
    // child only needs dup(2) of the accepted descriptor, so isolate Node's
    // private handle lookup here and pass the numeric fd. Windows needs the
    // stream form so libuv materializes its inherited handle table.
    const socket = input.stdio[3] as Socket & { _handle?: { fd?: unknown } };
    const inherited = process.platform === 'win32' ? socket : socket._handle?.fd;
    if (typeof inherited !== 'object'
        && (typeof inherited !== 'number' || !Number.isSafeInteger(inherited) || inherited < 0)) {
        throw new Error('accepted IPC socket descriptor is unavailable');
    }
    const spawnOptions: SpawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe', inherited as Socket | number],
    };
    return nodeSpawn(input.executablePath, [...input.args], spawnOptions);
}

/**
 * Ask the staged helper, through one bounded invocation, for the OS-proven
 * peer identity of one accepted local IPC connection. The accepted socket is
 * passed as the fixed extra descriptor and is never read, written, or closed
 * here, so the parent's connection keeps working. Any failure — helper
 * absence, spawn error, timeout, signal exit, non-zero exit, oversized or
 * malformed output — is `null`, and `null` must always be treated as "peer
 * identity not proven" by the caller.
 */
export async function observeLocalIpcPeerIdentity(input: Readonly<{
    socket: Socket;
    executablePath: string;
    /** Windows clients verify the connected pipe server before writing. */
    peer?: 'server';
    timeoutMs?: number;
    spawn?: ProcessCustodyPeerIdentitySpawn;
}>): Promise<ProcessCustodyPeerIdentity | null> {
    const spawnChild = input.spawn ?? spawnProcessCustodyPeerIdentityChild;
    if (input.socket.destroyed) return null;
    const restoreFlowing = input.socket.readableFlowing === true;
    const args = input.peer === 'server' ? ['peer-identity', '--server'] as const : ['peer-identity'] as const;
    const stdio = ['ignore', 'pipe', 'pipe', input.socket] as const;
    let child: ProcessCustodyPeerIdentityChild;
    try {
        child = spawnChild({ executablePath: input.executablePath, args, stdio });
    } catch {
        return null;
    }
    return await new Promise<ProcessCustodyPeerIdentity | null>((resolve) => {
        let settled = false;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let killed = false;
        let exited = false;
        const finish = (result: ProcessCustodyPeerIdentity | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // Passing a live Socket as child stdio can pause the parent's
            // Readable while libuv lends the handle to the helper. Preserve
            // the caller's pre-check flow state so authenticated control/data
            // bytes cannot remain stranded after the helper exits.
            if (restoreFlowing && !input.socket.destroyed) input.socket.resume();
            resolve(result);
        };
        const timer = setTimeout(() => {
            // The deadline bounds the helper, not this process: when the event loop was blocked
            // past it (a long synchronous module load), this timer runs before the helper's
            // already-delivered exit. Read that pending I/O first; an exited helper settles on
            // its close (code and output still decide), a running one is killed.
            setImmediate(() => {
                if (settled || exited) return;
                killed = true;
                child.kill('SIGKILL');
                finish(null);
            });
        }, Math.max(1, input.timeoutMs ?? PEER_IDENTITY_TIMEOUT_MS));
        timer.unref();
        child.stdout?.on('data', (chunk: Buffer | string) => {
            totalBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
            if (totalBytes > PEER_IDENTITY_STDOUT_LIMIT_BYTES) {
                killed = true;
                child.kill('SIGKILL');
                finish(null);
                return;
            }
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
        });
        child.on('exit', () => { exited = true; });
        child.on('error', () => finish(null));
        child.on('close', (code, signal) => {
            if (killed) return;
            if (code !== 0 || signal !== null) {
                finish(null);
                return;
            }
            finish(parseProcessCustodyPeerIdentityLine(Buffer.concat(chunks).toString('utf8')));
        });
    });
}
