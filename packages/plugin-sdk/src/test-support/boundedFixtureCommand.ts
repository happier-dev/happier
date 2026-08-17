import { spawn, type ChildProcess } from 'node:child_process';

export const fixtureCommandTimeoutMs = 60_000;
export const fixtureCommandMaxOutputBytes = 1_000_000;
const fixtureProcessTableTimeoutMs = 2_000;

export type BoundedFixtureCommandOptions = Readonly<{
    timeoutMs?: number;
}>;

type BoundedFixtureCommandTerminationReason = 'timeout' | 'outputLimit';

function commandOutput(stdout: string, stderr: string): string {
    const stdoutSection = stdout.length > 0
        ? `stdout:\n${stdout}`
        : '';
    const stderrSection = stderr.length > 0
        ? `stderr:\n${stderr}`
        : '';
    return [stdoutSection, stderrSection].filter(Boolean).join('\n') || '<no child output>';
}

async function listPosixDescendantProcessIds(rootPid: number): Promise<readonly number[]> {
    const processTable = await new Promise<string | undefined>((resolvePromise) => {
        const child = spawn('ps', ['-axo', 'pid=,ppid='], {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });
        let output = '';
        let finished = false;
        const complete = (result: string | undefined) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutHandle);
            resolvePromise(result);
        };
        const timeoutHandle = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                // The short-lived process-table read may have already exited.
            }
            complete(undefined);
        }, fixtureProcessTableTimeoutMs);
        child.stdout?.on('data', (chunk: Buffer) => {
            if (Buffer.byteLength(output, 'utf8') >= fixtureCommandMaxOutputBytes) return;
            const remainingBytes = fixtureCommandMaxOutputBytes - Buffer.byteLength(output, 'utf8');
            output += chunk.subarray(0, remainingBytes).toString('utf8');
        });
        child.once('error', () => {
            complete(undefined);
        });
        child.once('close', (status) => {
            complete(status === 0 ? output : undefined);
        });
    });
    if (processTable === undefined) return [];

    const childrenByParent = new Map<number, number[]>();
    for (const line of processTable.split('\n')) {
        const [pidText, parentPidText] = line.trim().split(/\s+/u);
        const pid = Number(pidText);
        const parentPid = Number(parentPidText);
        if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || pid <= 0 || parentPid <= 0) {
            continue;
        }
        const children = childrenByParent.get(parentPid) ?? [];
        children.push(pid);
        childrenByParent.set(parentPid, children);
    }

    const descendants: number[] = [];
    const pending = [rootPid];
    while (pending.length > 0) {
        const parentPid = pending.pop();
        if (parentPid === undefined) continue;
        const children = childrenByParent.get(parentPid) ?? [];
        descendants.push(...children);
        pending.push(...children);
    }
    return descendants.reverse();
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch {
        // The process may have exited between discovery and its signal.
    }
}

function signalPosixProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-processGroupId, signal);
    } catch {
        // The group may have exited before timeout cleanup reaches it.
    }
}

async function terminateFixtureChildProcess(
    child: ChildProcess,
    signal: NodeJS.Signals,
): Promise<void> {
    if (process.platform !== 'win32') {
        // Each command starts in its own process group. Signalling the group
        // immediately prevents a timed-out compiler child from continuing to
        // write after its parent has been stopped. It also remains effective
        // after a cooperative parent exits, where a later process-table walk
        // could otherwise lose an uncooperative descendant.
        if (child.pid === undefined) return;
        const processIdsPromise = listPosixDescendantProcessIds(child.pid).then(
            (descendants) => [...descendants, child.pid!] as const,
        );
        signalPosixProcessGroup(child.pid, signal);
        const processIds = await processIdsPromise;
        for (const pid of processIds) signalProcess(pid, signal);
        return;
    }

    if (child.pid === undefined) return;
    await new Promise<void>((resolvePromise) => {
        const terminator = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
        });
        const complete = () => {
            resolvePromise();
        };
        terminator.once('close', complete);
        terminator.once('error', () => {
            signalProcess(child.pid!, signal);
            complete();
        });
    });
}

function commandFailure(
    label: string,
    status: number | null,
    signal: NodeJS.Signals | null,
    terminationReason: BoundedFixtureCommandTerminationReason | undefined,
    error: Error | undefined,
    stdout: string,
    stderr: string,
): Error {
    const statusText = status === null ? 'none' : String(status);
    const signalText = signal ?? 'none';
    const errorText = error === undefined ? '' : ` error=${error.message}`;
    return new Error(
        `${label} failed (status=${statusText}, signal=${signalText}, timeout=${terminationReason === 'timeout'}, outputLimit=${terminationReason === 'outputLimit'})${errorText}\n${commandOutput(stdout, stderr)}`,
    );
}

/**
 * Runs the real Node-based fixture command with bounded diagnostics and a
 * complete timeout cleanup. POSIX commands get a dedicated process group plus
 * a concurrently captured PID tree, so a parent that terminates immediately
 * cannot strand an uncooperative descendant before cleanup completes.
 */
export function runBoundedFixtureCommand(
    label: string,
    cwd: string,
    args: readonly string[],
    options: BoundedFixtureCommandOptions = {},
): Promise<string> {
    const timeoutMs = options.timeoutMs ?? fixtureCommandTimeoutMs;
    return new Promise<string>((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, args, {
            cwd,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let capturedBytes = 0;
        let childError: Error | undefined;
        let terminationReason: BoundedFixtureCommandTerminationReason | undefined;
        let terminationPromise: Promise<void> | undefined;
        let timeoutHandle: NodeJS.Timeout | undefined;
        let finished = false;

        const clearTimers = () => {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        };
        const finishWithError = (error: Error) => {
            if (finished) return;
            finished = true;
            clearTimers();
            rejectPromise(error);
        };
        const finishWithOutput = () => {
            if (finished) return;
            finished = true;
            clearTimers();
            resolvePromise(stdout);
        };
        const requestTermination = (reason: BoundedFixtureCommandTerminationReason) => {
            if (finished || terminationReason !== undefined) return;
            terminationReason = reason;
            terminationPromise = terminateFixtureChildProcess(child, 'SIGKILL');
        };
        const captureOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
            const remainingBytes = fixtureCommandMaxOutputBytes - capturedBytes;
            if (remainingBytes > 0) {
                const capturedChunk = chunk.subarray(0, Math.min(chunk.byteLength, remainingBytes));
                if (stream === 'stdout') {
                    stdout += capturedChunk.toString('utf8');
                } else {
                    stderr += capturedChunk.toString('utf8');
                }
            }
            capturedBytes += chunk.byteLength;
            if (capturedBytes > fixtureCommandMaxOutputBytes) requestTermination('outputLimit');
        };

        child.stdout?.on('data', (chunk: Buffer) => {
            captureOutput('stdout', chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            captureOutput('stderr', chunk);
        });
        child.once('error', (error) => {
            childError = error;
            if (child.pid === undefined) {
                finishWithError(commandFailure(label, null, null, undefined, childError, stdout, stderr));
            }
        });
        child.once('close', (status, signal) => {
            void Promise.all([
                terminationPromise ?? Promise.resolve(),
            ]).then(() => {
                if (childError !== undefined || terminationReason !== undefined || status !== 0) {
                    finishWithError(commandFailure(
                        label,
                        status,
                        signal,
                        terminationReason,
                        childError,
                        stdout,
                        stderr,
                    ));
                    return;
                }
                finishWithOutput();
            });
        });
        timeoutHandle = setTimeout(() => {
            requestTermination('timeout');
        }, timeoutMs);
    });
}
