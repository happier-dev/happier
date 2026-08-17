import { execFile, spawn, type ChildProcess } from 'node:child_process';

export type BoundedChildProcessInput = Readonly<{
    label: string;
    command: string;
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
}>;

export type BoundedChildProcessResult = Readonly<{
    stdout: string;
    stderr: string;
}>;

function childOutput(stdout: string, stderr: string): string {
    const output = [
        stdout.length > 0 ? `stdout:\n${stdout}` : '',
        stderr.length > 0 ? `stderr:\n${stderr}` : '',
    ].filter(Boolean).join('\n');
    return output || '<no child output>';
}

function appendOutput(
    chunks: Buffer[],
    bytes: { value: number },
    chunk: Buffer | string,
    maxOutputBytes: number,
): boolean {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remainingBytes = maxOutputBytes - bytes.value;
    if (remainingBytes > 0) chunks.push(buffer.subarray(0, remainingBytes));
    bytes.value += buffer.byteLength;
    return bytes.value > maxOutputBytes;
}

function terminatePosixProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
        process.kill(-child.pid, signal);
    } catch {
        try {
            child.kill(signal);
        } catch {
            // The child may already have exited between the close check and kill.
        }
    }
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
    await new Promise<void>((resolve) => {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], {
            timeout: 1_000,
            windowsHide: true,
        }, () => resolve());
    });
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    if (process.platform === 'win32') {
        void terminateWindowsProcessTree(child.pid);
        return;
    }
    terminatePosixProcessTree(child, signal);
}

/**
 * Test-only process boundary for package-artifact probes. The child is its own
 * POSIX process group so a deadline or output overflow can terminate the
 * complete command tree, including TypeScript's compiler child.
 */
export async function runBoundedChildProcess(
    input: BoundedChildProcessInput,
): Promise<BoundedChildProcessResult> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
        throw new Error(`${input.label} requires a positive timeout`);
    }
    if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0) {
        throw new Error(`${input.label} requires a positive output limit`);
    }

    return await new Promise((resolve, reject) => {
        const child = spawn(input.command, input.args, {
            cwd: input.cwd,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        const outputBytes = { value: 0 };
        let terminationReason: 'timeout' | 'output-limit' | undefined;
        let settled = false;
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let forceTerminationTimer: ReturnType<typeof setTimeout> | undefined;

        const output = () => childOutput(
            Buffer.concat(stdoutChunks).toString('utf8'),
            Buffer.concat(stderrChunks).toString('utf8'),
        );
        const terminationError = () => {
            const reason = terminationReason === 'timeout'
                ? `timed out after ${input.timeoutMs}ms`
                : `exceeded ${input.maxOutputBytes} output bytes`;
            return new Error(`${input.label} ${reason}\n${output()}`);
        };
        const cleanup = () => {
            if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
            if (forceTerminationTimer !== undefined) clearTimeout(forceTerminationTimer);
        };
        const settle = (result: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            result();
        };
        const terminate = (reason: 'timeout' | 'output-limit') => {
            if (terminationReason !== undefined || settled) return;
            terminationReason = reason;
            terminateProcessTree(child, 'SIGTERM');
            forceTerminationTimer = setTimeout(() => {
                terminateProcessTree(child, 'SIGKILL');
                settle(() => reject(terminationError()));
            }, 1_000);
        };
        timeoutTimer = setTimeout(() => terminate('timeout'), input.timeoutMs);

        child.stdout?.on('data', (chunk: Buffer | string) => {
            if (appendOutput(stdoutChunks, outputBytes, chunk, input.maxOutputBytes)) {
                terminate('output-limit');
            }
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
            if (appendOutput(stderrChunks, outputBytes, chunk, input.maxOutputBytes)) {
                terminate('output-limit');
            }
        });
        child.once('error', (error) => {
            settle(() => reject(new Error(`${input.label} failed to start: ${error.message}\n${output()}`)));
        });
        child.once('close', (status, signal) => {
            if (terminationReason !== undefined) {
                settle(() => reject(terminationError()));
                return;
            }
            if (status === 0 && signal === null) {
                settle(() => resolve({
                    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                    stderr: Buffer.concat(stderrChunks).toString('utf8'),
                }));
                return;
            }
            settle(() => reject(new Error(
                `${input.label} exited with status ${status ?? 'unknown'} and signal ${signal ?? 'none'}\n`
                + output(),
            )));
        });
    });
}
