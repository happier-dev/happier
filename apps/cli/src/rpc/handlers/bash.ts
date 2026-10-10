import { logger } from '@/ui/logger';
import { execFileWithDeadline, type ExecFileWithDeadlineOptions } from '@happier-dev/cli-common/process';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from './fileSystem/accessPolicy/filesystemPathAuthorization';
import { mergeProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';

interface BashRequest {
    command?: string;
    argv?: string[];
    cwd?: string;
    /** Treat cwd literally, including the filesystem root instead of the legacy detection sentinel. */
    cwdMode?: 'explicit';
    env?: Record<string, string>;
    /** Milliseconds; zero delegates the lifetime to the caller's cancellation signal. */
    timeout?: number;
    /** Opt-in caller-owned UTF-8 suffix budget; legacy callers retain full capture. */
    outputTailMaxBytes?: number;
}

interface BashResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
}

function captureEvidence(output: { stdoutTruncated?: boolean; stderrTruncated?: boolean }) {
    return { ...(output.stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(output.stderrTruncated ? { stderrTruncated: true } : {}) };
}

async function executeBashProcess(
    file: string,
    args: readonly string[],
    options: ExecFileWithDeadlineOptions,
    executionBudgetRegistry?: ExecutionBudgetRegistry,
    attribution?: RequesterWorkAttributionV1,
    admissionDrain?: DaemonAdmissionDrain,
) {
    if (admissionDrain?.isQuiescing()) {
        const shuttingDown = admissionDrain.isFinalShutdown();
        throw Object.assign(new Error(shuttingDown ? 'Daemon is shutting down' : 'Daemon is draining'), {
            code: shuttingDown ? 'daemon_shutting_down' : 'daemon_draining',
        });
    }
    const task = execFileWithDeadline(file, args, options);
    const release = executionBudgetRegistry?.retainFiniteTask(task, attribution);
    try {
        // This boundary waits for the real command's close, including after
        // timeout/abort signalling; a public cancellation alone cannot release custody.
        return await task;
    } finally {
        release?.();
    }
}

async function executeArgvRequest(
    argv: readonly string[],
    options: ExecFileWithDeadlineOptions,
    executionBudgetRegistry?: ExecutionBudgetRegistry,
    attribution?: RequesterWorkAttributionV1,
    admissionDrain?: DaemonAdmissionDrain,
): Promise<BashResponse> {
    const [file, ...args] = argv;
    try {
        const output = await executeBashProcess(file, args, {
            ...options,
            shell: false,
        }, executionBudgetRegistry, attribution, admissionDrain);
        return { success: true, stdout: output.stdout.toString(), stderr: output.stderr.toString(), exitCode: 0, ...captureEvidence(output) };
    } catch (error) {
        // Spawn argument validation previously reached the outer request-error mapper.
        if (error instanceof TypeError) throw error;
        const execError = error as Error & {
            stdout?: string | Buffer;
            stderr?: string | Buffer;
            code?: number | string;
            killed?: boolean;
            signal?: string;
            stdoutTruncated?: boolean;
            stderrTruncated?: boolean;
        };
        const stdout = execError.stdout?.toString() ?? '';
        const stderr = execError.stderr?.toString() ?? '';
        const cancelled = execError.code === 'ABORT_ERR' || execError.name === 'AbortError';
        const timedOut = !cancelled && (execError.code === 'ETIMEDOUT' || execError.killed === true);
        const message = cancelled ? 'Command cancelled' : timedOut
            ? 'Command timed out'
            : (typeof execError.code === 'number' || execError.signal ? stderr || 'Command failed' : execError.message);
        return {
            success: false,
            stdout,
            stderr: timedOut || cancelled ? stderr : stderr || message,
            exitCode: typeof execError.code === 'number' ? execError.code : -1,
            error: message,
            ...captureEvidence(execError),
        };
    }
}

export function registerBashHandler(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    opts?: Readonly<{ accessPolicy?: FilesystemAccessPolicy; executionBudgetRegistry?: ExecutionBudgetRegistry; admissionDrain?: DaemonAdmissionDrain }>,
): void {
    const accessPolicy = opts?.accessPolicy ?? { kind: 'osUser' };
    // Shell command handler - executes commands in the default shell
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>(RPC_METHODS.BASH, async (data, context) => {
        logger.debug('Shell command request:', data.command);
        const attribution = context?.localActionContext?.requesterWorkAttributionV1;

        // Validate cwd if provided
        // Special case: "/" means "use shell's default cwd" (used by CLI detection)
        // Security: Still validate all other paths to prevent directory traversal
        let cwd: string | undefined = workingDirectory;
        if (data.cwd) {
            if (data.cwd === '/' && data.cwdMode !== 'explicit') {
                cwd = undefined;
            } else {
                const validation = authorizeFilesystemPath({
                    targetPath: data.cwd,
                    defaultDirectory: workingDirectory,
                    accessPolicy,
                });
                if (!validation.valid) {
                    return { success: false, error: validation.error };
                }
                cwd = validation.resolvedPath;
            }
        }

        try {
            // Legacy callers retain their default budget; Action callers explicitly select
            // zero and supply the containing operation's cancellation signal.
            const timeout = data.timeout ?? 30000;
            const options: ExecFileWithDeadlineOptions = {
                cwd,
                ...(timeout > 0 ? { timeout } : {}),
                ...(data.env ? { env: mergeProcessEnv({ baseEnv: process.env, explicitEnv: data.env }) } : {}),
                ...(context?.signal ? { signal: context.signal } : {}),
                windowsHide: true,
                // Both machine exec paths return output. The containing Action/Workflow
                // transport owns result admission, not Node's incidental execFile cap.
                maxBuffer: Infinity,
                ...(data.outputTailMaxBytes === undefined ? {} : { outputTailMaxBytes: data.outputTailMaxBytes }),
            };

            if (Array.isArray(data.argv) && data.argv.length > 0 && data.argv.every((value) => typeof value === 'string')) {
                logger.debug('Shell argv request executing...', { cwd: options.cwd, timeout: options.timeout, argc: data.argv.length });
                return await executeArgvRequest(data.argv, options, opts?.executionBudgetRegistry, attribution, opts?.admissionDrain);
            }

            if (typeof data.command !== 'string' || data.command.length === 0) {
                return {
                    success: false,
                    stdout: '',
                    stderr: 'Command failed',
                    exitCode: 1,
                    error: 'Command failed',
                };
            }

            logger.debug('Shell command executing...', { cwd: options.cwd, timeout: options.timeout });
            // `execFileWithDeadline` with `shell: true` is `exec` with the budget owned here
            // instead of by `child_process`. `exec` shares `execFile`'s timeout kill, which
            // destroys the command's buffered output from the timers phase and still calls back
            // with `code 0` — so on a stalled daemon loop a command that ran fine returned
            // `{ success: true, stdout: '', exitCode: 0 }` to the caller, and the `killed`
            // branch below (the one that reports "Command timed out") never ran. A command we
            // actually cut short now rejects and reaches that branch.
            const output = await executeBashProcess(data.command, [], {
                ...options,
                shell: true,
            }, opts?.executionBudgetRegistry, attribution, opts?.admissionDrain);
            const { stdout, stderr } = output;
            logger.debug('Shell command executed, processing result...');

            const result = {
                success: true,
                stdout: stdout ? stdout.toString() : '',
                stderr: stderr ? stderr.toString() : '',
                exitCode: 0,
                ...captureEvidence(output),
            };
            logger.debug('Shell command result:', {
                success: true,
                exitCode: 0,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        } catch (error) {
            const execError = error as NodeJS.ErrnoException & {
                stdout?: string;
                stderr?: string;
                code?: number | string;
                killed?: boolean;
                stdoutTruncated?: boolean;
                stderrTruncated?: boolean;
            };

            if (execError.code === 'ABORT_ERR' || execError.name === 'AbortError') {
                return {
                    success: false,
                    stdout: execError.stdout?.toString() ?? '',
                    stderr: execError.stderr?.toString() ?? '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: 'Command cancelled',
                    ...captureEvidence(execError),
                };
            }

            // Check if the error was due to timeout
            if (execError.code === 'ETIMEDOUT' || execError.killed) {
                const result = {
                    success: false,
                    stdout: execError.stdout || '',
                    stderr: execError.stderr || '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: 'Command timed out',
                    ...captureEvidence(execError),
                };
                logger.debug('Shell command timed out:', {
                    success: false,
                    exitCode: result.exitCode,
                    error: 'Command timed out'
                });
                return result;
            }

            // If exec fails, it includes stdout/stderr in the error
            const result = {
                success: false,
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
                exitCode: typeof execError.code === 'number' ? execError.code : 1,
                error: execError.message || 'Command failed',
                ...captureEvidence(execError),
            };
            logger.debug('Shell command failed:', {
                success: false,
                exitCode: result.exitCode,
                error: result.error,
                stdoutLen: result.stdout.length,
                stderrLen: result.stderr.length
            });
            return result;
        }
    });
}
