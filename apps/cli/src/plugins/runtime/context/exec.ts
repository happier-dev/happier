import { basename, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';

import type {
    ExecLaunchInputV1,
    ExecProcessHandleV1,
    ExecRunOptionsV1,
    ExecRunResultV1,
    ExecRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

type PluginExecDisposable = Readonly<{
    dispose: () => void | Promise<void>;
}>;

const DISALLOWED_PATH_ONLY_RUNTIME_NAMES = new Set([
    'node',
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'bunx',
]);

export type PluginExecErrorCode =
    | 'PLUGIN_EXEC_PERMISSION_DENIED'
    | 'PLUGIN_EXEC_UNRESOLVED_LAUNCH'
    | 'PLUGIN_EXEC_PATH_ONLY_RUNTIME_DENIED';

export class PluginExecError extends Error {
    readonly code: PluginExecErrorCode;

    constructor(code: PluginExecErrorCode, message: string) {
        super(message);
        this.name = 'PluginExecError';
        this.code = code;
    }
}

export type CreatePluginExecServiceParams = Readonly<{
    allowedExecutablePaths?: readonly string[];
    allowPathRuntimeNames?: readonly string[];
    baseEnv?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    addDisposable?: (disposable: PluginExecDisposable) => unknown;
}>;

function createAbortError(): Error {
    const error = new Error('Plugin exec operation was aborted');
    error.name = 'AbortError';
    return error;
}

function assertResolvedLaunch(input: ExecLaunchInputV1): void {
    if (input.kind !== 'resolvedExecutable' || input.executablePath.trim().length === 0) {
        throw new PluginExecError(
            'PLUGIN_EXEC_UNRESOLVED_LAUNCH',
            'ctx.exec requires a host-resolved executable launch input',
        );
    }
    if (!isAbsolute(input.executablePath)) {
        throw new PluginExecError(
            'PLUGIN_EXEC_UNRESOLVED_LAUNCH',
            `ctx.exec requires an absolute host-resolved executable path, received '${input.executablePath}'`,
        );
    }
}

function assertLaunchAllowed(input: ExecLaunchInputV1, params: CreatePluginExecServiceParams): void {
    assertResolvedLaunch(input);
    const executableName = basename(input.executablePath);
    if (DISALLOWED_PATH_ONLY_RUNTIME_NAMES.has(basename(input.executablePath))) {
        const explicitlyAllowed = params.allowPathRuntimeNames?.includes(executableName) === true;
        if (!explicitlyAllowed) {
            throw new PluginExecError(
                'PLUGIN_EXEC_PATH_ONLY_RUNTIME_DENIED',
                `ctx.exec cannot launch '${executableName}' without a managed runtime policy`,
            );
        }
    }
    if (!new Set(params.allowedExecutablePaths ?? []).has(input.executablePath)) {
        throw new PluginExecError(
            'PLUGIN_EXEC_PERMISSION_DENIED',
            `ctx.exec cannot launch undeclared executable '${input.executablePath}'`,
        );
    }
}

function clipBuffer(buffer: string, maxBytes: number | undefined): string {
    if (maxBytes === undefined || maxBytes < 0) {
        return buffer;
    }
    return Buffer.byteLength(buffer) <= maxBytes
        ? buffer
        : Buffer.from(buffer).subarray(0, maxBytes).toString('utf8');
}

export function createPluginExecService(params: CreatePluginExecServiceParams = {}): ExecRuntimeServiceV1 {
    const service: ExecRuntimeServiceV1 = Object.freeze({
        async run(input: ExecLaunchInputV1, options?: ExecRunOptionsV1): Promise<ExecRunResultV1> {
            const handle = await this.spawn(input, options);
            try {
                return await handle.exit;
            } finally {
                await handle.dispose();
            }
        },
        async spawn(input: ExecLaunchInputV1, options?: ExecRunOptionsV1): Promise<ExecProcessHandleV1> {
            assertLaunchAllowed(input, params);
            if (options?.signal?.aborted || params.signal?.aborted) {
                throw createAbortError();
            }
            const child = spawn(input.executablePath, [...(input.args ?? [])], {
                cwd: input.cwd,
                env: { ...(params.baseEnv ?? {}), ...(input.env ?? {}) },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            let disposed = false;
            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            child.stdout?.on('data', (chunk: string) => {
                stdout = clipBuffer(stdout + chunk, options?.maxStdoutBytes);
            });
            child.stderr?.on('data', (chunk: string) => {
                stderr = clipBuffer(stderr + chunk, options?.maxStderrBytes);
            });
            const timeout = options?.timeoutMs === undefined
                ? null
                : setTimeout(() => child.kill(), Math.max(0, options.timeoutMs));
            const abortProcess = () => child.kill();
            options?.signal?.addEventListener('abort', abortProcess, { once: true });
            params.signal?.addEventListener('abort', abortProcess, { once: true });
            if (input.stdin !== undefined) {
                child.stdin?.end(input.stdin);
            }
            const exit = new Promise<ExecRunResultV1>((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', (exitCode, signal) => {
                    if (timeout) {
                        clearTimeout(timeout);
                    }
                    resolve(Object.freeze({
                        exitCode,
                        signal,
                        stdout,
                        stderr,
                    }));
                });
            });
            const handle: ExecProcessHandleV1 = Object.freeze({
                pid: child.pid ?? null,
                exit,
                async writeStdin(inputChunk) {
                    child.stdin?.write(inputChunk);
                },
                kill(signal?: string) {
                    child.kill(signal as NodeJS.Signals | undefined);
                },
                async dispose() {
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    if (timeout) {
                        clearTimeout(timeout);
                    }
                    if (!child.killed) {
                        child.kill();
                    }
                    await exit.catch(() => undefined);
                },
            });
            params.addDisposable?.(handle);
            return handle;
        },
        async spawnClient(input: ExecLaunchInputV1, options?: ExecRunOptionsV1) {
            const processHandle = await this.spawn(input, options);
            return Object.freeze({
                process: processHandle,
                async dispose() {
                    await processHandle.dispose();
                },
            });
        },
    });
    return service;
}
