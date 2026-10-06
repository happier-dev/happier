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
    timeout?: number; // timeout in milliseconds
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
    options: Readonly<{ cwd?: string; timeout: number }>,
): Promise<BashResponse> {
    const [file, ...args] = argv;
    try {
        const { stdout, stderr } = await execFileWithDeadline(file, args, {
            cwd: options.cwd,
            ...(options.timeout > 0 ? { timeout: options.timeout } : {}),
            windowsHide: true,
            shell: false,
            // The argv path previously accumulated all output; do not impose execFile's
            // default buffer ceiling when moving its deadline to the shared owner.
            maxBuffer: Infinity,
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
        const timedOut = execError.code === 'ETIMEDOUT' || execError.killed === true;
        const message = timedOut
            ? 'Command timed out'
            : (typeof execError.code === 'number' || execError.signal ? stderr || 'Command failed' : execError.message);
        return {
            success: false,
            stdout,
            stderr: timedOut ? stderr : stderr || message,
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
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>(RPC_METHODS.BASH, async (data) => {
        logger.debug('Shell command request:', data.command);

        // Validate cwd if provided
        // Special case: "/" means "use shell's default cwd" (used by CLI detection)
        // Security: Still validate all other paths to prevent directory traversal
        let cwd: string | undefined = workingDirectory;
        if (data.cwd) {
            if (data.cwd === '/') {
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
            // Build options with shell enabled by default
            // Note: ExecOptions doesn't support boolean for shell, but exec() uses the default shell when shell is undefined
            // If cwd is "/", use undefined to let shell use its default (respects user's PATH)
            const options: ExecFileWithDeadlineOptions = {
                cwd,
                timeout: data.timeout || 30000, // Default 30 seconds timeout
                windowsHide: true,
            };

            if (Array.isArray(data.argv) && data.argv.length > 0 && data.argv.every((value) => typeof value === 'string')) {
                logger.debug('Shell argv request executing...', { cwd: options.cwd, timeout: options.timeout, argc: data.argv.length });
                return await executeArgvRequest(data.argv, {
                    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
                    timeout: options.timeout ?? 30000,
                });
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
