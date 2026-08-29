import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { execFileWithDeadline } from '@happier-dev/cli-common/process';

import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

/**
 * The one native-custody owner behind SVC09's exact process-tree custody.
 *
 * This module is the single consumer of the `happier-process-custody` runtime
 * support binary (`tools/unpacked/happier-process-custody`, staged by the
 * daemon-support payload builder):
 * - Windows: generation-unique named Job Objects. The helper creates the job,
 *   starts the target suspended, assigns it before its first instruction, and
 *   resumes it; this module owns the tagged job identity, the post-assignment
 *   handshake, and terminate/query-by-job with full membership absence proofs.
 * - Darwin: the native subsecond start identity (`darwin-proc`), read through
 *   the helper's validated numeric sysctl witness.
 * Linux never consumes this helper — its custody stays on the dedicated
 * process-group owner — so every Linux question here answers "unavailable"
 * without touching the filesystem.
 */

export const PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME = 'happier-process-custody';

/** Windows job-custody identity: `winjob:<jobName>`. The name is generation-unique. */
const WINDOWS_JOB_IDENTITY_PREFIX = 'winjob:';
/** Darwin native subsecond identity: `darwin-proc:<pid>:<sec>:<usec>`. */
const DARWIN_NATIVE_IDENTITY_PREFIX = 'darwin-proc:';

export type ProcessCustodySpawnSpec = Readonly<{
    jobName: string;
    executablePath: string;
    /** Post-assignment marker the helper writes once the target is resumed. */
    handshakePath: string;
}>;

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

const HANDSHAKE_TIMEOUT_MS = 15_000;
const CUSTODY_RUNTIME_EXEC_TIMEOUT_MS = 10_000;
const CUSTODY_TERMINATE_TIMEOUT_MS = 5_000;

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Generation-unique job name. The UUID comes from the spawning operation's own
 * instance identity, so two spawns can never negotiate custody over one job,
 * and the helper refuses an already-existing job name fail-closed.
 */
export function createWindowsJobCustodyName(instanceId: string): string {
    const normalized = instanceId.trim();
    if (!normalized || /[^\w-]/u.test(normalized)) {
        throw new TypeError('Windows job custody requires a path-safe instance identity');
    }
    return `Local\\happier-svc09-${normalized}`;
}

/** Private post-assignment handshake file path for one spawn. */
export function createProcessCustodyHandshakePath(): string {
    return join(tmpdir(), `.happier-svc09-custody-${randomUUID()}.json`);
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
    const executableName = platform === 'win32'
        ? `${PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME}.exe`
        : PROCESS_CUSTODY_RUNTIME_BINARY_BASE_NAME;
    const stagedPath = resolveCliRuntimeAssetPath('tools', 'unpacked', executableName);
    if (existsSync(stagedPath)) return stagedPath;
    const sourceCheckoutPath = resolveCliRuntimeAssetPath('apps', 'cli', 'tools', 'unpacked', executableName);
    if (existsSync(sourceCheckoutPath)) return sourceCheckoutPath;
    return null;
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
 * helper's validated numeric sysctl witness. Returns `null` when the helper is
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
    const run = input.execFile ?? execFileWithDeadline;
    try {
        const result = await run(input.executablePath, ['pid-startidentity', String(input.pid)], {
            timeout: CUSTODY_RUNTIME_EXEC_TIMEOUT_MS,
        });
        const outcome = readJsonLineOutcome(result.stdout);
        if (!outcome || outcome.v !== 1 || outcome.pid !== input.pid) return null;
        const sec = outcome.sec;
        const usec = outcome.usec;
        if (!isPositiveSafeInteger(sec) || typeof usec !== 'number' || !Number.isSafeInteger(usec) || usec < 0 || usec > 999_999) {
            return null;
        }
        return Object.freeze({ sec, usec });
    } catch {
        return null;
    }
}
