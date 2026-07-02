import type {
    ExecClientHandleV1,
    JsonStreamClientV1,
    PluginContextV1,
} from '@happier-dev/plugin-sdk';

import type {
    CanCallToolCallback,
    PermissionResult,
    QueryOptions,
    QueryPrompt,
    SDKMessage,
} from './types.js';

type ControlRequestRecord = Readonly<{
    type: 'control_request';
    request_id: string;
    request: Readonly<{
        subtype: string;
        tool_name?: string;
        input?: unknown;
    }>;
}>;

type ControlCancelRecord = Readonly<{
    type: 'control_cancel_request';
    request_id: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isControlRequestRecord(value: unknown): value is ControlRequestRecord {
    return isRecord(value)
        && value.type === 'control_request'
        && typeof value.request_id === 'string'
        && isRecord(value.request);
}

function isControlCancelRecord(value: unknown): value is ControlCancelRecord {
    return isRecord(value)
        && value.type === 'control_cancel_request'
        && typeof value.request_id === 'string';
}

function isSdkMessage(value: unknown): value is SDKMessage {
    return isRecord(value) && typeof value.type === 'string';
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
    return isRecord(input) ? input : {};
}

function buildClaudeArgs(prompt: QueryPrompt, options: QueryOptions = {}): string[] {
    const args = ['--output-format', 'stream-json', '--verbose'];
    if (options.customSystemPrompt) args.push('--system-prompt', options.customSystemPrompt);
    if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
    if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--effort', options.effort);
    if (options.canCallTool) {
        if (typeof prompt === 'string') {
            throw new Error('canCallTool callback requires stream-json input.');
        }
        args.push('--permission-prompt-tool', 'stdio');
    }
    if (options.continue) args.push('--continue');
    if (options.resume) args.push('--resume', options.resume);
    if (options.strictMcpConfig) args.push('--strict-mcp-config');
    if (options.permissionMode && options.permissionMode !== 'default') {
        args.push('--permission-mode', options.permissionMode);
    }
    // Claude Code keeps only the FIRST --settings overlay, so emit at most one:
    // an explicit settings file wins over the inline JSON overlay.
    if (options.settingsPath) {
        args.push('--settings', options.settingsPath);
    } else if (options.settingsJson) {
        args.push('--settings', options.settingsJson);
    }
    if (options.fallbackModel) {
        if (options.model && options.fallbackModel === options.model) {
            throw new Error('Fallback model cannot be the same as the main model.');
        }
        args.push('--fallback-model', options.fallbackModel);
    }
    args.push(...(options.extraArgs ?? []));
    if (typeof prompt === 'string') {
        args.push('--print', prompt.trim());
    } else {
        args.push('--input-format', 'stream-json');
    }
    return args;
}

class AsyncMessageQueue implements AsyncIterableIterator<SDKMessage> {
    private readonly queue: SDKMessage[] = [];
    private done = false;
    private waiter: ((value: IteratorResult<SDKMessage>) => void) | null = null;
    private rejecter: ((error: Error) => void) | null = null;
    private errorValue: Error | null = null;

    [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
        return this;
    }

    next(): Promise<IteratorResult<SDKMessage>> {
        if (this.queue.length > 0) {
            return Promise.resolve({ done: false, value: this.queue.shift()! });
        }
        if (this.errorValue) {
            return Promise.reject(this.errorValue);
        }
        if (this.done) {
            return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
            this.waiter = resolve;
            this.rejecter = reject;
        });
    }

    enqueue(message: SDKMessage): void {
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            this.rejecter = null;
            waiter({ done: false, value: message });
            return;
        }
        this.queue.push(message);
    }

    finish(): void {
        this.done = true;
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            this.rejecter = null;
            waiter({ done: true, value: undefined });
        }
    }

    fail(error: Error): void {
        this.errorValue = error;
        if (this.rejecter) {
            const rejecter = this.rejecter;
            this.waiter = null;
            this.rejecter = null;
            rejecter(error);
        }
    }
}

export class ClaudeSdkQuery implements AsyncIterableIterator<SDKMessage> {
    private readonly messages = new AsyncMessageQueue();
    private readonly controlControllers = new Map<string, AbortController>();
    private handlePromise: Promise<ExecClientHandleV1<JsonStreamClientV1>>;
    private handle: ExecClientHandleV1<JsonStreamClientV1> | null = null;
    private unsubscribe: (() => void) | null = null;

    constructor(
        private readonly ctx: PluginContextV1,
        private readonly config: Readonly<{
            prompt: QueryPrompt;
            options?: QueryOptions;
            onMessageReceived?: (message: SDKMessage) => void;
        }>,
    ) {
        this.handlePromise = this.start();
        this.handlePromise.catch((error: unknown) => {
            this.messages.fail(error instanceof Error ? error : new Error(String(error)));
        });
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
        return this;
    }

    next(): Promise<IteratorResult<SDKMessage>> {
        return this.messages.next();
    }

    async return(): Promise<IteratorResult<SDKMessage>> {
        await this.dispose();
        return { done: true, value: undefined };
    }

    async throw(error: Error): Promise<IteratorResult<SDKMessage>> {
        this.messages.fail(error);
        await this.dispose();
        throw error;
    }

    async interrupt(): Promise<void> {
        const handle = await this.handlePromise;
        await handle.client.writeRecord({
            type: 'control_request',
            request: { subtype: 'interrupt' },
        });
    }

    async dispose(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const controller of this.controlControllers.values()) {
            controller.abort();
        }
        this.controlControllers.clear();
        const handle = await this.handlePromise.catch(() => null);
        await handle?.dispose({ code: 'CLAUDE_SDK_QUERY_DISPOSED' });
        this.messages.finish();
    }

    private async start(): Promise<ExecClientHandleV1<JsonStreamClientV1>> {
        const options = this.config.options ?? {};
        const handle = await this.ctx.exec.spawnClient({
            launch: {
                kind: 'agent-cli',
                agentId: 'claude',
                args: buildClaudeArgs(this.config.prompt, options),
                cwd: options.cwd,
                env: options.env,
            },
            transport: {
                kind: 'stdio',
                framing: { kind: 'strict-lf-json' },
            },
            protocol: { kind: 'json-stream' },
        }, { signal: options.abort });
        this.handle = handle;
        this.unsubscribe = handle.client.subscribe((record) => {
            void this.handleRecord(record);
        });
        void this.pumpPrompt(handle.client, this.config.prompt, options.abort);
        handle.process.exit.then(
            () => this.messages.finish(),
            (error) => this.messages.fail(error instanceof Error ? error : new Error(String(error))),
        );
        return handle;
    }

    private async pumpPrompt(
        client: JsonStreamClientV1,
        prompt: QueryPrompt,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        if (typeof prompt === 'string') return;
        try {
            for await (const message of prompt) {
                if (signal?.aborted) break;
                await client.writeRecord(message, { signal });
            }
        } catch (error) {
            this.messages.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }

    private async handleRecord(record: unknown): Promise<void> {
        if (isControlRequestRecord(record)) {
            await this.handleControlRequest(record);
            return;
        }
        if (isControlCancelRecord(record)) {
            const controller = this.controlControllers.get(record.request_id);
            controller?.abort();
            this.controlControllers.delete(record.request_id);
            return;
        }
        if (!isSdkMessage(record)) return;
        this.config.onMessageReceived?.(record);
        this.messages.enqueue(record);
    }

    private async handleControlRequest(record: ControlRequestRecord): Promise<void> {
        const handle = this.handle;
        if (!handle) return;
        const controller = new AbortController();
        this.controlControllers.set(record.request_id, controller);
        try {
            const response = await this.processControlRequest(record, controller.signal);
            await handle.client.writeRecord({
                type: 'control_response',
                response: {
                    subtype: 'success',
                    request_id: record.request_id,
                    response,
                },
            });
        } catch (error) {
            await handle.client.writeRecord({
                type: 'control_response',
                response: {
                    subtype: 'error',
                    request_id: record.request_id,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        } finally {
            this.controlControllers.delete(record.request_id);
        }
    }

    private async processControlRequest(
        record: ControlRequestRecord,
        signal: AbortSignal,
    ): Promise<PermissionResult> {
        if (record.request.subtype !== 'can_use_tool') {
            throw new Error(`Unsupported control request subtype: ${record.request.subtype}`);
        }
        const canCallTool: CanCallToolCallback | undefined = this.config.options?.canCallTool;
        if (!canCallTool) {
            throw new Error('canCallTool callback is not provided.');
        }
        const toolName = typeof record.request.tool_name === 'string' ? record.request.tool_name : '';
        return canCallTool(toolName, normalizeToolInput(record.request.input), {
            requestId: record.request_id,
            signal,
        });
    }
}

export function query(
    ctx: PluginContextV1,
    config: Readonly<{
        prompt: QueryPrompt;
        options?: QueryOptions;
        onMessageReceived?: (message: SDKMessage) => void;
    }>,
): ClaudeSdkQuery {
    return new ClaudeSdkQuery(ctx, config);
}
