import { Buffer } from 'node:buffer';
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { execFileWithDeadline, type ExecFileWithDeadlineOptions } from '@happier-dev/cli-common/process';

const DEFAULT_SIMULATOR_TOOL_MAX_OUTPUT_BYTES = 64 * 1024;

export type SimulatorToolRunResult = Readonly<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut?: true;
    aborted?: true;
    errorName?: string;
}>;

export type SimulatorToolRunner = (
    input: Readonly<{
        command: string;
        args: readonly string[];
        timeoutMs: number;
        signal?: AbortSignal;
    }>,
) => Promise<SimulatorToolRunResult>;

export type SimulatorToolExecFileOptions = Readonly<{
    timeout: number;
    maxBuffer: number;
    signal?: AbortSignal;
    windowsHide: true;
    shell: false;
}>;

export type SimulatorToolExecFile = (
    command: string,
    args: readonly string[],
    options: SimulatorToolExecFileOptions,
) => Promise<Readonly<{ stdout: string | Buffer; stderr: string | Buffer }>>;

export type SimulatorToolRunnerOptions = Readonly<{
    execFile?: SimulatorToolExecFile;
    maxOutputBytes?: number;
}>;

function coerceOutput(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return '';
}

function boundUtf8(value: string, maxOutputBytes: number): string {
    if (maxOutputBytes <= 0) return '';
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.byteLength <= maxOutputBytes) return value;
    return bytes.subarray(0, maxOutputBytes).toString('utf8');
}

function readErrorField(error: unknown, key: string): unknown {
    return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined;
}

function readExitCode(error: unknown): number | null {
    for (const key of ['exitCode', 'status', 'code']) {
        const value = readErrorField(error, key);
        if (typeof value === 'number') return value;
    }
    return null;
}

function readErrorName(error: unknown): string | undefined {
    if (error instanceof Error && error.name.trim().length > 0) return error.name;
    const name = readErrorField(error, 'name');
    return typeof name === 'string' && name.trim().length > 0 ? name : undefined;
}

function isTimeoutError(error: unknown): boolean {
    return readErrorField(error, 'code') === 'ETIMEDOUT'
        || readErrorField(error, 'killed') === true
        || readErrorField(error, 'signal') === 'SIGTERM';
}

function isAbortError(error: unknown): boolean {
    return readErrorName(error) === 'AbortError' || readErrorField(error, 'code') === 'ABORT_ERR';
}

/**
 * The budget is owned here, not by `child_process`. Its `timeout` destroys a finished child's
 * buffered output and still calls back with `code 0`, which this runner would report as
 * `{ exitCode: 0, stdout: '' }` — a device listing that succeeded and found no devices, with
 * `timedOut` never set. `execFileWithDeadline` rejects instead, so the `timedOut` branch below is
 * reachable for the case it names.
 */
const defaultExecFile: SimulatorToolExecFile = async (command, args, options) => {
    const execOptions: ExecFileWithDeadlineOptions = {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: options.windowsHide,
        shell: options.shell,
        ...(options.signal ? { signal: options.signal } : {}),
    };
    return await execFileWithDeadline(command, [...args], execOptions);
};

export function createDefaultSimulatorToolRunner(options: SimulatorToolRunnerOptions = {}): SimulatorToolRunner {
    const execFile = options.execFile ?? defaultExecFile;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_SIMULATOR_TOOL_MAX_OUTPUT_BYTES;

    return async (input) => {
        try {
            const result = await execFile(input.command, input.args, {
                timeout: input.timeoutMs,
                maxBuffer: maxOutputBytes,
                ...(input.signal ? { signal: input.signal } : {}),
                windowsHide: true,
                shell: false,
            });
            return {
                exitCode: 0,
                stdout: boundUtf8(coerceOutput(result.stdout), maxOutputBytes),
                stderr: boundUtf8(coerceOutput(result.stderr), maxOutputBytes),
            };
        } catch (error) {
            return {
                exitCode: readExitCode(error),
                stdout: boundUtf8(coerceOutput(readErrorField(error, 'stdout')), maxOutputBytes),
                stderr: boundUtf8(coerceOutput(readErrorField(error, 'stderr')), maxOutputBytes),
                ...(isTimeoutError(error) ? { timedOut: true as const } : {}),
                ...(isAbortError(error) || input.signal?.aborted === true ? { aborted: true as const } : {}),
                ...(readErrorName(error) ? { errorName: readErrorName(error) } : {}),
            };
        }
    };
}

export const defaultSimulatorToolRunner: SimulatorToolRunner = createDefaultSimulatorToolRunner();

export type SimulatorOperationProcessResult = Readonly<{
    exitCode: number | null;
    stdout: Buffer;
    stderr: string;
    signal?: NodeJS.Signals;
    aborted?: true;
    errorCode?: string;
    cause?: string;
}>;

export type SimulatorOperationRunner = (input: Readonly<{
    command: string;
    args: readonly string[];
    stdin?: string | Buffer;
    signal?: AbortSignal;
}>) => Promise<SimulatorOperationProcessResult>;

export type SimulatorOperationChild = Pick<ChildProcess, 'once' | 'removeListener' | 'kill'> & {
    stdout: Readable | null;
    stderr: Readable | null;
    stdin: Writable | null;
};
export type SimulatorOperationSpawn = (
    command: string, args: readonly string[], options: SpawnOptionsWithoutStdio,
) => SimulatorOperationChild;

/** Interactive device work inherits cancellation, rather than the discovery probe's deadline.
 * Raw stdout also carries screenshots, which cannot pass through the UTF-8 diagnostic runner.
 */
export function createSimulatorOperationRunner(options: Readonly<{
    spawn?: SimulatorOperationSpawn;
    env?: Readonly<Record<string, string | undefined>>;
}> = {}): SimulatorOperationRunner {
    const spawnProcess = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    return async (input) => {
        if (input.signal?.aborted) return { exitCode: null, stdout: Buffer.alloc(0), stderr: '', aborted: true };
        return await new Promise<SimulatorOperationProcessResult>((resolve) => {
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let child: SimulatorOperationChild;
            const complete = (result: Omit<SimulatorOperationProcessResult, 'stdout' | 'stderr'>) => {
                input.signal?.removeEventListener('abort', abort);
                resolve({ ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
            };
            const failed = (error: unknown) => {
                const code = readErrorField(error, 'code');
                complete({ exitCode: null, ...(typeof code === 'string' ? { errorCode: code } : {}),
                    ...(error instanceof Error ? { cause: error.message } : {}),
                    ...(input.signal?.aborted ? { aborted: true } : {}),
                });
            };
            const abort = () => { child.kill('SIGTERM'); };
            try {
                child = spawnProcess(input.command, input.args, { stdio: 'pipe', shell: false, windowsHide: true,
                    ...(options.env ? { env: options.env } : {}),
                });
            } catch (error) {
                failed(error);
                return;
            }
            child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            child.once('error', failed);
            child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => complete({ exitCode,
                ...(signal ? { signal } : {}), ...(input.signal?.aborted ? { aborted: true } : {}),
            }));
            // A tool can exit before consuming all stdin (for example a rejected push payload).
            // Its exit/stderr remain the authoritative failure rather than a parent EPIPE throw.
            child.stdin?.on('error', () => {});
            child.stdin?.end(input.stdin);
            input.signal?.addEventListener('abort', abort, { once: true });
            if (input.signal?.aborted) abort();
        });
    };
}

export const defaultSimulatorOperationRunner = createSimulatorOperationRunner();
