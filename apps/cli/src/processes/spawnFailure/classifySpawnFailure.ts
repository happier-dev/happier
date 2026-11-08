import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { SpawnFailureV1 } from '@happier-dev/protocol';
import { statSync } from 'node:fs';

/** Only called after spawn fails: ENOENT alone cannot distinguish cwd from executable absence. */
export function isSpawnWorkingDirectoryMissing(cwd: string | undefined): boolean {
    if (cwd === undefined) return false;
    try {
        return !statSync(cwd).isDirectory();
    } catch (error) {
        return error !== null && typeof error === 'object' && 'code' in error
            && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    }
}

export type SpawnFailure = Readonly<SpawnFailureV1>;
export type SpawnFailureLimitsReader = () => MachineVitalsSampleV1['limits'];
export type SpawnFailureContext = Readonly<{
    platform?: NodeJS.Platform;
    syscall?: 'spawn' | 'fork' | 'posix_spawn' | 'openpty' | 'forkpty';
    cwd?: string;
    limits?: MachineVitalsSampleV1['limits'];
}>;

export function classifySpawnFailure(error: unknown, context: SpawnFailureContext = {}): SpawnFailure {
    const record = error !== null && typeof error === 'object' ? error : {};
    const errno = 'code' in record && typeof record.code === 'string' && /^E[A-Z0-9_]+$/u.test(record.code) ? record.code : undefined;
    const nativeErrno = 'errno' in record && typeof record.errno === 'number' && Number.isSafeInteger(record.errno)
        ? record.errno : undefined;
    const observedSyscall = 'syscall' in record && typeof record.syscall === 'string' ? record.syscall.split(/[ (]/u)[0] : undefined;
    const syscall = observedSyscall ?? context.syscall;
    const reached = (limit: Readonly<{ used: number; max: number }> | undefined) => !!limit
        && Number.isFinite(limit.used) && Number.isFinite(limit.max) && limit.used >= 0 && limit.max >= 0 && limit.used >= limit.max;
    let reason: SpawnFailure['reason'] = 'other';
    if (errno === 'EMFILE' || errno === 'ENFILE') reason = 'too_many_open_files';
    else if (errno === 'ENOMEM') reason = 'out_of_memory';
    else if (errno === 'EBADF' && (context.platform ?? process.platform) === 'darwin'
        && (syscall === 'posix_spawn' || syscall === 'spawn') && reached(context.limits?.daemonFiles)) reason = 'too_many_open_files';
    else if ((errno === 'ENXIO' || errno === 'EAGAIN') && (syscall === 'openpty' || syscall === 'forkpty')) reason = 'no_ptys';
    else if (errno === 'EAGAIN' && (syscall === 'fork' || syscall === 'spawn' || syscall === 'posix_spawn') && reached(context.limits?.processes)) reason = 'process_limit';
    return { reason, ...(errno ? { errno } : {}), ...(nativeErrno === undefined ? {} : { nativeErrno }),
        ...(context.cwd?.trim() ? { cwd: context.cwd } : {}) };
}

export function spawnFailureMessage(failure: SpawnFailure, fallback: string): string {
    switch (failure.reason) {
        case 'too_many_open_files': return "This machine can't open more files. Close terminals or apps you are not using.";
        case 'no_ptys': return "This machine can't open more terminals. Close ones you are not using.";
        case 'process_limit': return "This machine can't start more processes. Stop sessions or apps you are not using.";
        case 'out_of_memory': return "This machine doesn't have enough memory to start this process. Stop sessions or apps you are not using.";
        case 'other': return failure.errno === 'ENOENT'
            ? 'The process could not start. Check that the command is installed and the working directory exists.'
            : fallback;
    }
}

/** Process adapters retain the original cause and OS code on startup failure. */
export class SpawnFailureError extends Error {
    readonly code?: string;
    readonly syscall?: string;
    readonly spawnFailure: SpawnFailure;

    constructor(error: unknown, context: SpawnFailureContext) {
        const spawnFailure = classifySpawnFailure(error, context);
        super(spawnFailureMessage(spawnFailure, error instanceof Error ? error.message : 'Process could not be started'), { cause: error });
        this.spawnFailure = spawnFailure;
        this.code = spawnFailure.errno;
        this.syscall = error !== null && typeof error === 'object' && 'syscall' in error && typeof error.syscall === 'string'
            ? error.syscall : context.syscall;
    }
}
