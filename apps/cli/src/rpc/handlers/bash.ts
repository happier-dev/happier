import { logger } from '@/ui/logger';
import { execFileWithDeadline, type ExecFileWithDeadlineOptions } from '@happier-dev/cli-common/process';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from './fileSystem/accessPolicy/filesystemPathAuthorization';

interface BashRequest {
    command?: string;
    argv?: string[];
    cwd?: string;
    /** Treat cwd literally, including the filesystem root instead of the legacy detection sentinel. */
    cwdMode?: 'explicit';
    env?: Record<string, string>;
    /** Milliseconds; zero delegates the lifetime to the caller's cancellation signal. */
    timeout?: number;
}

interface BashResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
}

async function executeArgvRequest(
    argv: readonly string[],
    options: ExecFileWithDeadlineOptions,
): Promise<BashResponse> {
    const [file, ...args] = argv;
    try {
        const { stdout, stderr } = await execFileWithDeadline(file, args, {
            ...options,
            shell: false,
        });
        return { success: true, stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 };
    } catch (error) {
        // Spawn argument validation previously reached the outer request-error mapper.
        if (error instanceof TypeError) throw error;
        const execError = error as Error & {
            stdout?: string | Buffer;
            stderr?: string | Buffer;
            code?: number | string;
            killed?: boolean;
            signal?: string;
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
        };
    }
}

export function registerBashHandler(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    opts?: Readonly<{ accessPolicy?: FilesystemAccessPolicy }>,
): void {
    const accessPolicy = opts?.accessPolicy ?? { kind: 'osUser' };
    // Shell command handler - executes commands in the default shell
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>(RPC_METHODS.BASH, async (data, context) => {
        logger.debug('Shell command request:', data.command);

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
                ...(data.env ? { env: { ...process.env, ...data.env } } : {}),
                ...(context?.signal ? { signal: context.signal } : {}),
                windowsHide: true,
                // Both machine exec paths return output. The containing Action/Workflow
                // transport owns result admission, not Node's incidental execFile cap.
                maxBuffer: Infinity,
            };

            if (Array.isArray(data.argv) && data.argv.length > 0 && data.argv.every((value) => typeof value === 'string')) {
                logger.debug('Shell argv request executing...', { cwd: options.cwd, timeout: options.timeout, argc: data.argv.length });
                return await executeArgvRequest(data.argv, options);
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
            const { stdout, stderr } = await execFileWithDeadline(data.command, [], {
                ...options,
                shell: true,
            });
            logger.debug('Shell command executed, processing result...');

            const result = {
                success: true,
                stdout: stdout ? stdout.toString() : '',
                stderr: stderr ? stderr.toString() : '',
                exitCode: 0
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
            };

            if (execError.code === 'ABORT_ERR' || execError.name === 'AbortError') {
                return {
                    success: false,
                    stdout: execError.stdout?.toString() ?? '',
                    stderr: execError.stderr?.toString() ?? '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: 'Command cancelled',
                };
            }

            // Check if the error was due to timeout
            if (execError.code === 'ETIMEDOUT' || execError.killed) {
                const result = {
                    success: false,
                    stdout: execError.stdout || '',
                    stderr: execError.stderr || '',
                    exitCode: typeof execError.code === 'number' ? execError.code : -1,
                    error: 'Command timed out'
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
                error: execError.message || 'Command failed'
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
