import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_STDERR_PREVIEW_BYTES = 4 * 1024;
const MAX_EVENTS_PER_TASK = 200;
const MAX_COMPLETED_TASKS = 64;

type SystemTaskEvent = Readonly<{
    protocolVersion: number;
    taskId: string;
    tsMs: number;
    type: string;
    stepId?: string;
    message?: string;
    data?: unknown;
}>;

type SystemTaskResult = Readonly<{
    protocolVersion: number;
    taskId: string;
    ok: boolean;
    data?: unknown;
    error?: Readonly<{ code: string; message: string }>;
}>;

type SafeSchema<T> = Readonly<{
    safeParse: (value: unknown) =>
        | Readonly<{ success: true; data: T }>
        | Readonly<{ success: false }>;
}>;

type TaskRecord = {
    child: ChildProcessWithoutNullStreams | null;
    cancelRequested: boolean;
    events: SystemTaskEvent[];
    result: SystemTaskResult | null;
    stderrPreview: Buffer;
    stdoutBuffer: Buffer;
};

export type ElectronSystemTasksDependencies = Readonly<{
    resolveHsetupPath: () => string;
    emitEvent: (eventName: string, payload: unknown) => void;
}>;

function failureResult(taskId: string, code: string, message: string): SystemTaskResult {
    return {
        protocolVersion: 1,
        taskId,
        ok: false,
        error: { code, message },
    };
}

function rewriteEventTaskId(event: SystemTaskEvent, taskId: string): SystemTaskEvent {
    return { ...event, taskId };
}

function rewriteResultTaskId(result: SystemTaskResult, taskId: string): SystemTaskResult {
    return { ...result, taskId };
}

function sanitizeStderrPreview(bytes: Buffer): string {
    return bytes
        .toString('utf8')
        .replace(/[^\t\n\r\x20-\x7e\u00a0-\uffff]/gu, '')
        .trim()
        .slice(-800)
        .trim();
}

/** Electron host adapter for the same bundled hsetup task owner used by Tauri. */
export class ElectronSystemTasks {
    private nextTaskId = 1;
    private readonly tasks = new Map<string, TaskRecord>();
    private readonly completedTaskIds: string[] = [];
    private protocolSchemas: Readonly<{
        spec: SafeSchema<unknown>;
        event: SafeSchema<SystemTaskEvent>;
        result: SafeSchema<SystemTaskResult>;
    }> | null = null;

    constructor(private readonly dependencies: ElectronSystemTasksDependencies) {}

    async start(specJson: string): Promise<{ taskId: string }> {
        const schemas = await this.loadProtocolSchemas();
        let rawSpec: unknown;
        try {
            rawSpec = JSON.parse(specJson);
        } catch {
            throw new Error('Invalid system task specification JSON.');
        }
        const parsedSpec = schemas.spec.safeParse(rawSpec);
        if (!parsedSpec.success) {
            throw new Error('Invalid system task specification JSON.');
        }

        const taskId = `system_task_${this.nextTaskId}`;
        this.nextTaskId += 1;
        const child = spawn(this.dependencies.resolveHsetupPath(), ['system-tasks', 'run'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const record: TaskRecord = {
            child,
            cancelRequested: false,
            events: [],
            result: null,
            stderrPreview: Buffer.alloc(0),
            stdoutBuffer: Buffer.alloc(0),
        };
        this.tasks.set(taskId, record);

        child.stdout.on('data', (chunk: Buffer | string) => {
            this.consumeStdout(taskId, record, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stderr.on('data', (chunk: Buffer | string) => {
            const next = Buffer.concat([
                record.stderrPreview,
                Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
            ]);
            record.stderrPreview = next.subarray(Math.max(0, next.length - MAX_STDERR_PREVIEW_BYTES));
        });
        child.stdin.on('error', () => {
            // The child lifecycle produces the typed final failure; never let a broken pipe escape
            // as an unhandled stream error in the Electron main process.
        });
        child.once('error', (error) => {
            this.complete(taskId, record, failureResult(
                taskId,
                'executor_ended_without_result',
                `Failed to start hsetup: ${error.message}`,
            ));
        });
        child.once('close', () => {
            record.child = null;
            if (record.result !== null) return;
            if (record.cancelRequested) {
                this.complete(taskId, record, failureResult(taskId, 'cancelled', 'Task cancelled.'));
                return;
            }
            const stderrPreview = sanitizeStderrPreview(record.stderrPreview);
            this.complete(taskId, record, failureResult(
                taskId,
                'executor_ended_without_result',
                stderrPreview.length > 0
                    ? `System task executor exited without a final result.\n\nStderr (tail):\n${stderrPreview}`
                    : 'System task executor exited without a final result.',
            ));
        });

        child.stdin.write(`${specJson}\n`);
        return { taskId };
    }

    async cancel(taskId: string): Promise<void> {
        const record = this.tasks.get(taskId);
        if (!record) return;
        record.cancelRequested = true;
        record.child?.kill('SIGTERM');
    }

    snapshot(taskId: string): Readonly<{ events: readonly SystemTaskEvent[]; result: SystemTaskResult | null }> {
        const record = this.tasks.get(taskId);
        return record
            ? { events: [...record.events], result: record.result }
            : { events: [], result: null };
    }

    async respondToPrompt(taskId: string, answerJson: string): Promise<void> {
        const record = this.tasks.get(taskId);
        if (!record?.child || record.child.stdin.destroyed) return;
        record.child.stdin.write(`${answerJson}\n`);
    }

    private consumeStdout(taskId: string, record: TaskRecord, chunk: Buffer): void {
        if (record.result !== null) return;
        record.stdoutBuffer = Buffer.concat([record.stdoutBuffer, chunk]);
        while (true) {
            const newlineIndex = record.stdoutBuffer.indexOf(0x0a);
            if (newlineIndex < 0) {
                return;
            }
            const line = record.stdoutBuffer.subarray(0, newlineIndex);
            record.stdoutBuffer = record.stdoutBuffer.subarray(newlineIndex + 1);
            this.consumeOutputLine(taskId, record, line.toString('utf8').trim());
            if (record.result !== null) return;
        }
    }

    private consumeOutputLine(taskId: string, record: TaskRecord, line: string): void {
        if (line.length === 0) return;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            return;
        }

        const schemas = this.protocolSchemas;
        if (schemas === null) return;
        const result = schemas.result.safeParse(value);
        if (result.success) {
            this.complete(taskId, record, rewriteResultTaskId(result.data, taskId));
            return;
        }

        const event = schemas.event.safeParse(value);
        if (!event.success) return;
        const rewritten = rewriteEventTaskId(event.data, taskId);
        record.events.push(rewritten);
        if (record.events.length > MAX_EVENTS_PER_TASK) {
            record.events.splice(0, record.events.length - MAX_EVENTS_PER_TASK);
        }
        this.dependencies.emitEvent(`systemTasks://task/${taskId}/event`, rewritten);
    }

    private complete(taskId: string, record: TaskRecord, result: SystemTaskResult): void {
        if (record.result !== null) return;
        record.result = result;
        record.child = null;
        this.completedTaskIds.push(taskId);
        while (this.completedTaskIds.length > MAX_COMPLETED_TASKS) {
            const expiredTaskId = this.completedTaskIds.shift();
            if (expiredTaskId !== undefined) this.tasks.delete(expiredTaskId);
        }
        this.dependencies.emitEvent(`systemTasks://task/${taskId}/result`, result);
    }

    private async loadProtocolSchemas(): Promise<NonNullable<ElectronSystemTasks['protocolSchemas']>> {
        if (this.protocolSchemas !== null) return this.protocolSchemas;
        const protocol = await import('@happier-dev/protocol');
        this.protocolSchemas = {
            spec: protocol.SystemTaskSpecSchema as SafeSchema<unknown>,
            event: protocol.SystemTaskEventSchema as SafeSchema<SystemTaskEvent>,
            result: protocol.SystemTaskResultSchema as SafeSchema<SystemTaskResult>,
        };
        return this.protocolSchemas;
    }
}
