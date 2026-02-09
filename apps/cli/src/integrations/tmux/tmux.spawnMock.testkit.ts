import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';

export type TmuxSpawnCall = {
    command: string;
    args: string[];
    options: SpawnOptions;
};

type MinimalChild = EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
};

export function createTmuxMockChildProcess(): ChildProcessWithoutNullStreams {
    const child = new EventEmitter() as MinimalChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    queueMicrotask(() => {
        child.emit('close', 0);
    });

    return child as unknown as ChildProcessWithoutNullStreams;
}
