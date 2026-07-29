import { Buffer } from 'node:buffer';
import { execFile as nodeExecFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_SIMULATOR_TOOL_MAX_OUTPUT_BYTES = 64 * 1024;

const execFileAsync = promisify(nodeExecFile);

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

const defaultExecFile: SimulatorToolExecFile = async (command, args, options) => {
    const execOptions: ExecFileOptions = {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: options.windowsHide,
        shell: options.shell,
        ...(options.signal ? { signal: options.signal } : {}),
    };
    const result = await execFileAsync(command, [...args], execOptions);
    return {
        stdout: result.stdout,
        stderr: result.stderr,
    };
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
