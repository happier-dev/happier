import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk';

import type {
    CanCallToolCallback,
    GetOAuthTokenCallback,
    PermissionResult,
    QueryOptions,
    QueryPrompt,
    SDKMessage,
} from './types.js';
import { materializeClaudeMcpConfigArgsForSpawn } from '../mcp/materializeConfigArgs.js';

export type ClaudeSdkExecResult = Readonly<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}>;

export type ClaudeSdkJsonStreamWriteOutcome =
    | Readonly<{ kind: 'written' }>
    | Readonly<{ kind: 'rejected_before_write'; error: Error }>
    | Readonly<{ kind: 'write_may_have_occurred'; error: Error }>;

export type ClaudeSdkJsonStreamClient = Readonly<{
    readonly closed: Promise<void>;
    subscribe(listener: (record: unknown) => void | Promise<void>): () => void;
    writeRecord(
        record: unknown,
        options?: { signal?: AbortSignal },
    ): Promise<ClaudeSdkJsonStreamWriteOutcome>;
}>;

export type ClaudeSdkExecClientHandle = Readonly<{
    readonly client: ClaudeSdkJsonStreamClient;
    readonly process: Readonly<{
        exit: Promise<ClaudeSdkExecResult>;
        writeStdin(input: string | Uint8Array): Promise<void>;
        kill(): void;
        dispose(): Promise<void>;
    }>;
    readonly status: 'running' | 'exited' | 'disposed';
    onExit(listener: (result: ClaudeSdkExecResult) => void): () => void;
    dispose(reason?: Readonly<{ code?: string; message?: string }>): Promise<void>;
}>;

export type ClaudeSdkJsonStreamClientSpec = Readonly<{
    launch: Readonly<{
        kind: 'agent-cli';
        agentId: 'claude';
        args?: readonly string[];
        cwd?: string;
        env?: Readonly<Record<string, string>>;
    }>;
    transport: Readonly<{
        kind: 'stdio';
        framing: Readonly<{ kind: 'strict-lf-json' }>;
    }>;
    protocol: Readonly<{ kind: 'json-stream' }>;
}>;

export type ClaudeSdkQueryContext = Readonly<{
    spawnClient(
        spec: ClaudeSdkJsonStreamClientSpec,
        options?: { signal?: AbortSignal },
    ): Promise<ClaudeSdkExecClientHandle>;
}>;

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

type ControlResponseRecord = Readonly<{
    type: 'control_response';
    response: Readonly<{
        subtype: 'success' | 'error';
        request_id: string;
        response?: unknown;
        error?: string;
    }>;
}>;
type OutboundControlRequest = Readonly<{
    subtype: string;
    [key: string]: unknown;
}>;

export type ClaudeSdkContextUsageResponse = Readonly<{
    totalTokens: number;
    maxTokens: number;
    model: string;
    isAutoCompactEnabled: boolean;
    categories: readonly Readonly<{
        name: string;
        tokens: number;
        color: string;
        isDeferred?: boolean;
    }>[];
    [key: string]: unknown;
}>;

export type ClaudeSdkPromptTransportOutcome =
    | Readonly<{ kind: 'accepted' }>
    | Readonly<{ kind: 'rejected_before_effect'; error: Error }>
    | Readonly<{ kind: 'effect_may_have_occurred'; error: Error }>;

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

function isControlResponseRecord(value: unknown): value is ControlResponseRecord {
    if (!isRecord(value) || value.type !== 'control_response' || !isRecord(value.response)) return false;
    return (value.response.subtype === 'success' || value.response.subtype === 'error')
        && typeof value.response.request_id === 'string';
}

function isSdkMessage(value: unknown): value is SDKMessage {
    return isRecord(value) && typeof value.type === 'string';
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
    return isRecord(input) ? input : {};
}

function buildClaudeArgs(prompt: QueryPrompt, options: QueryOptions = {}): string[] {
    const args = ['--output-format', 'stream-json', '--verbose'];
    if (typeof options.systemPrompt === 'string') {
        args.push('--system-prompt', options.systemPrompt);
    } else if (options.customSystemPrompt) {
        args.push('--system-prompt', options.customSystemPrompt);
    }
    if (typeof options.systemPrompt === 'object' && options.systemPrompt.append) {
        args.push('--append-system-prompt', options.systemPrompt.append);
    }
    if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
    if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--effort', options.effort);
    if (options.canCallTool) {
        if (typeof prompt === 'string') {
            throw new Error('canCallTool callback requires stream-json input.');
        }
    }
    if (options.canCallTool || options.permissionPromptToolName) {
        args.push('--permission-prompt-tool', options.permissionPromptToolName ?? 'stdio');
    }
    if (options.continue) args.push('--continue');
    if (options.resume) args.push('--resume', options.resume);
    if (options.strictMcpConfig) args.push('--strict-mcp-config');
    if (options.permissionMode && options.permissionMode !== 'default') {
        args.push('--permission-mode', options.permissionMode);
    }
    // Claude Code keeps only the FIRST --settings overlay, so emit at most one:
    // an explicit settings file wins over the inline JSON overlay.
    const inlineSettings = (() => {
        if (!options.sandbox) return options.settingsJson;
        if (!options.settingsJson) return JSON.stringify({ sandbox: options.sandbox });
        try {
            const parsed = JSON.parse(options.settingsJson) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return options.settingsJson;
            return JSON.stringify({
                ...(parsed as Readonly<Record<string, unknown>>),
                sandbox: options.sandbox,
            });
        } catch {
            return options.settingsJson;
        }
    })();
    if (options.settingsPath) {
        args.push('--settings', options.settingsPath);
    } else if (inlineSettings) {
        args.push('--settings', inlineSettings);
    }
    if (options.fallbackModel) {
        if (options.model && options.fallbackModel === options.model) {
            throw new Error('Fallback model cannot be the same as the main model.');
        }
        args.push('--fallback-model', options.fallbackModel);
    }
    for (const plugin of options.plugins ?? []) {
        args.push('--plugin-dir', plugin.path);
    }
    if (options.betas && options.betas.length > 0) args.push('--betas', ...options.betas);
    if (options.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(options.maxBudgetUsd));
    if (options.additionalDirectories && options.additionalDirectories.length > 0) {
        args.push('--add-dir', ...options.additionalDirectories);
    }
    if (Array.isArray(options.tools)) args.push('--tools', options.tools.join(','));
    if (options.debug === true) args.push('--debug');
    if (options.debugFile) args.push('--debug-file', options.debugFile);
    args.push(...(options.extraArgs ?? []));
    if (typeof prompt === 'string') {
        args.push('--print', prompt.trim());
    } else {
        args.push('--input-format', 'stream-json');
    }
    return args;
}

const STDERR_PREVIEW_MAX_LENGTH = 800;
const AUTH_ENV_KEY_PATTERN = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_OAUTH_SCOPES',
    'CLAUDE_CODE_SETUP_TOKEN',
].join('|');
const AUTH_ENV_ASSIGNMENT_PATTERN = new RegExp(
    `(["']?\\b(?:${AUTH_ENV_KEY_PATTERN})\\b["']?\\s*[:=]\\s*)(["']?)([^\\s"',;}]+)\\2`,
    'giu',
);

const CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH_ENV_KEY = 'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH';

type OAuthTokenRefreshResult = Readonly<{
    accessToken: string | null;
}>;

function formatExitStatus(result: ClaudeSdkExecResult): string {
    if (result.signal) return `signal=${result.signal}`;
    if (result.exitCode !== null) return `exitCode=${result.exitCode}`;
    return 'exitCode=null';
}

function sanitizeStderrPreview(stderr: string): string {
    const trimmed = stderr.trim();
    if (trimmed.length === 0) return '';
    const redacted = redactBugReportSensitiveText(trimmed)
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
        .replace(AUTH_ENV_ASSIGNMENT_PATTERN, '$1$2[redacted]$2')
        .replace(/\bsk-ant-[A-Za-z0-9._~+/=-]+/giu, 'sk-ant-[redacted]');
    return redacted.length > STDERR_PREVIEW_MAX_LENGTH
        ? `${redacted.slice(0, STDERR_PREVIEW_MAX_LENGTH)}...`
        : redacted;
}

export function createClaudeSdkNoResultError(result: ClaudeSdkExecResult | null | undefined): Error {
    const status = result ? ` (${formatExitStatus(result)})` : '';
    const stderr = result ? sanitizeStderrPreview(result.stderr) : '';
    const detail = stderr.length > 0 ? `: ${stderr}` : '';
    return new Error(`Claude Agent SDK process exited before emitting a result${status}${detail}`);
}

function formatProcessExitFailure(result: ClaudeSdkExecResult): Error | null {
    if (result.exitCode === 0 && !result.signal) {
        return null;
    }
    return createClaudeSdkNoResultError(result);
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
    private readonly pendingControlResponses = new Map<string, Readonly<{
        resolve(value: unknown): void;
        reject(error: Error): void;
    }>>();
    private controlRequestSequence = 0;
    private handlePromise: Promise<ClaudeSdkExecClientHandle>;
    private handle: ClaudeSdkExecClientHandle | null = null;
    private exitResult: ClaudeSdkExecResult | null = null;
    private unsubscribe: (() => void) | null = null;
    private promptTransportAttempted = false;
    private promptTransportSettled = false;
    private removePromptTransportAbortListener: (() => void) | null = null;
    private cleanupSpawnArtifacts: (() => Promise<void>) | null = null;
    private resolvePromptTransportOutcome!: (outcome: ClaudeSdkPromptTransportOutcome) => void;
    readonly promptTransportOutcome: Promise<ClaudeSdkPromptTransportOutcome>;

    constructor(
        private readonly ctx: ClaudeSdkQueryContext,
        private readonly config: Readonly<{
            prompt: QueryPrompt;
            options?: QueryOptions;
            onMessageReceived?: (message: SDKMessage) => void;
        }>,
    ) {
        this.promptTransportOutcome = new Promise((resolve) => {
            this.resolvePromptTransportOutcome = resolve;
        });
        this.observePromptTransportAbort(this.config.options?.abort);
        this.handlePromise = this.start();
        this.handlePromise.catch((error: unknown) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.settlePromptTransport({
                kind: this.promptTransportAttempted
                    ? 'effect_may_have_occurred'
                    : 'rejected_before_effect',
                error: failure,
            });
            this.messages.fail(failure);
        });
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
        return this;
    }

    next(): Promise<IteratorResult<SDKMessage>> {
        return this.messages.next();
    }

    readExitResult(): ClaudeSdkExecResult | null {
        return this.exitResult;
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
        await this.writeRecordOrThrow(handle.client, {
            type: 'control_request',
            request: { subtype: 'interrupt' },
        });
    }

    async sendUserMessage(text: string): Promise<ClaudeSdkPromptTransportOutcome> {
        let handle: ClaudeSdkExecClientHandle;
        try {
            handle = await this.handlePromise;
        } catch (error) {
            return {
                kind: 'rejected_before_effect',
                error: error instanceof Error ? error : new Error(String(error)),
            };
        }
        try {
            const outcome = await handle.client.writeRecord({
                type: 'user',
                message: {
                    role: 'user',
                    content: text,
                },
            }, { signal: this.config.options?.abort });
            if (outcome.kind === 'written') return { kind: 'accepted' };
            return {
                kind: outcome.kind === 'rejected_before_write'
                    ? 'rejected_before_effect'
                    : 'effect_may_have_occurred',
                error: outcome.error,
            };
        } catch (error) {
            return {
                kind: 'effect_may_have_occurred',
                error: error instanceof Error ? error : new Error(String(error)),
            };
        }
    }

    async getContextUsage(): Promise<ClaudeSdkContextUsageResponse> {
        const response = await this.requestControl({ subtype: 'get_context_usage' });
        if (!isRecord(response)) {
            throw new Error('Claude SDK get_context_usage returned an invalid response.');
        }
        return response as ClaudeSdkContextUsageResponse;
    }

    async stopTask(taskId: string): Promise<void> {
        await this.requestControl({ subtype: 'stop_task', task_id: taskId });
    }

    async dispose(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const controller of this.controlControllers.values()) {
            controller.abort();
        }
        this.controlControllers.clear();
        this.rejectPendingControlResponses(new Error('Claude SDK query disposed before control response.'));
        const handle = await this.handlePromise.catch(() => null);
        try {
            await handle?.dispose({ code: 'CLAUDE_SDK_QUERY_DISPOSED' });
        } finally {
            await this.cleanupSpawnArtifacts?.();
        }
        this.settlePromptTransport({
            kind: this.promptTransportAttempted
                ? 'effect_may_have_occurred'
                : 'rejected_before_effect',
            error: new Error('Claude SDK query disposed before prompt transport completed.'),
        });
        this.messages.finish();
    }

    private async start(): Promise<ClaudeSdkExecClientHandle> {
        const options = this.config.options ?? {};
        const env = options.getOAuthToken
            ? {
                ...(options.env ?? {}),
                [CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH_ENV_KEY]: '1',
            }
            : options.env;
        const materializedMcpConfig = materializeClaudeMcpConfigArgsForSpawn(
            buildClaudeArgs(this.config.prompt, options),
        );
        this.cleanupSpawnArtifacts = materializedMcpConfig.cleanup;
        let handle: ClaudeSdkExecClientHandle;
        try {
            handle = await this.ctx.spawnClient({
                launch: {
                    kind: 'agent-cli',
                    agentId: 'claude',
                    args: materializedMcpConfig.args,
                    cwd: options.cwd,
                    env,
                },
                transport: {
                    kind: 'stdio',
                    framing: { kind: 'strict-lf-json' },
                },
                protocol: { kind: 'json-stream' },
            }, { signal: options.abort });
        } catch (error) {
            await materializedMcpConfig.cleanup();
            throw error;
        }
        this.handle = handle;
        this.unsubscribe = handle.client.subscribe((record) => {
            void this.handleRecord(record);
        });
        void this.pumpPrompt(handle.client, this.config.prompt, options.abort);
        handle.process.exit.then(
            async (result) => {
                await materializedMcpConfig.cleanup();
                this.exitResult = result;
                this.rejectPendingControlResponses(
                    new Error('Claude SDK process exited before control response.'),
                );
                const failure = formatProcessExitFailure(result);
                if (failure) {
                    if (!this.promptTransportAttempted) {
                        this.settlePromptTransport({
                            kind: 'rejected_before_effect',
                            error: failure,
                        });
                    }
                    this.messages.fail(failure);
                    return;
                }
                if (!this.promptTransportAttempted) {
                    this.settlePromptTransport({
                        kind: 'rejected_before_effect',
                        error: createClaudeSdkNoResultError(result),
                    });
                }
                this.messages.finish();
            },
            async (error) => {
                await materializedMcpConfig.cleanup();
                this.messages.fail(error instanceof Error ? error : new Error(String(error)));
            },
        );
        return handle;
    }

    private async pumpPrompt(
        client: ClaudeSdkJsonStreamClient,
        prompt: QueryPrompt,
        signal: AbortSignal | undefined,
    ): Promise<void> {
        if (typeof prompt === 'string') {
            this.settlePromptTransport({
                kind: 'rejected_before_effect',
                error: new Error('Claude SDK exact prompt transport is unavailable for string input.'),
            });
            return;
        }
        let attemptedMessage: SDKMessage | null = null;
        try {
            for await (const message of prompt) {
                if (signal?.aborted) {
                    this.settlePromptTransport({
                        kind: 'rejected_before_effect',
                        error: signal.reason instanceof Error
                            ? signal.reason
                            : new Error('Claude SDK prompt transport was aborted before write.'),
                    });
                    return;
                }
                attemptedMessage = message;
                this.promptTransportAttempted = true;
                const writeOutcome = await client.writeRecord(message, { signal });
                if (writeOutcome.kind === 'written') {
                    this.settlePromptTransport({ kind: 'accepted' });
                } else {
                    this.settlePromptTransport({
                        kind: writeOutcome.kind === 'rejected_before_write'
                            ? 'rejected_before_effect'
                            : 'effect_may_have_occurred',
                        error: writeOutcome.error,
                    });
                    this.messages.fail(writeOutcome.error);
                    return;
                }
                attemptedMessage = null;
            }
            if (!this.promptTransportAttempted) {
                this.settlePromptTransport({
                    kind: 'rejected_before_effect',
                    error: new Error('Claude SDK prompt stream completed before yielding a prompt record.'),
                });
            }
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            if (attemptedMessage) {
                this.settlePromptTransport({
                    kind: 'effect_may_have_occurred',
                    error: failure,
                });
            } else {
                this.settlePromptTransport({
                    kind: 'rejected_before_effect',
                    error: failure,
                });
            }
            this.messages.fail(failure);
        }
    }

    private settlePromptTransport(outcome: ClaudeSdkPromptTransportOutcome): void {
        if (this.promptTransportSettled) return;
        this.promptTransportSettled = true;
        this.removePromptTransportAbortListener?.();
        this.removePromptTransportAbortListener = null;
        this.resolvePromptTransportOutcome(outcome);
    }

    private observePromptTransportAbort(signal: AbortSignal | undefined): void {
        if (!signal) return;
        const settleAbortedTransport = (): void => {
            const error = signal.reason instanceof Error
                ? signal.reason
                : new Error('Claude SDK prompt transport was aborted.');
            this.settlePromptTransport({
                kind: this.promptTransportAttempted
                    ? 'effect_may_have_occurred'
                    : 'rejected_before_effect',
                error,
            });
        };
        if (signal.aborted) {
            settleAbortedTransport();
            return;
        }
        signal.addEventListener('abort', settleAbortedTransport, { once: true });
        this.removePromptTransportAbortListener = () => {
            signal.removeEventListener('abort', settleAbortedTransport);
        };
    }

    private async handleRecord(record: unknown): Promise<void> {
        if (isControlResponseRecord(record)) {
            const pending = this.pendingControlResponses.get(record.response.request_id);
            if (!pending) return;
            this.pendingControlResponses.delete(record.response.request_id);
            if (record.response.subtype === 'error') {
                pending.reject(new Error(record.response.error ?? 'Claude SDK control request failed.'));
            } else {
                pending.resolve(record.response.response);
            }
            return;
        }
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

    private async requestControl(request: OutboundControlRequest): Promise<unknown> {
        const handle = await this.handlePromise;
        this.controlRequestSequence += 1;
        const requestId = `claude-sdk-control-${this.controlRequestSequence}`;
        const response = new Promise<unknown>((resolve, reject) => {
            this.pendingControlResponses.set(requestId, { resolve, reject });
        });
        try {
            await this.writeRecordOrThrow(handle.client, {
                type: 'control_request',
                request_id: requestId,
                request,
            });
        } catch (error) {
            this.pendingControlResponses.delete(requestId);
            throw error;
        }
        return await response;
    }

    private rejectPendingControlResponses(error: Error): void {
        for (const pending of this.pendingControlResponses.values()) {
            pending.reject(error);
        }
        this.pendingControlResponses.clear();
    }

    private async writeRecordOrThrow(
        client: ClaudeSdkJsonStreamClient,
        record: unknown,
        options?: { signal?: AbortSignal },
    ): Promise<void> {
        const outcome = await client.writeRecord(record, options);
        if (outcome.kind !== 'written') {
            throw outcome.error;
        }
    }

    private async handleControlRequest(record: ControlRequestRecord): Promise<void> {
        const handle = this.handle;
        if (!handle) return;
        const controller = new AbortController();
        this.controlControllers.set(record.request_id, controller);
        try {
            const response = await this.processControlRequest(record, controller.signal);
            await this.writeRecordOrThrow(handle.client, {
                type: 'control_response',
                response: {
                    subtype: 'success',
                    request_id: record.request_id,
                    response,
                },
            });
        } catch (error) {
            await this.writeRecordOrThrow(handle.client, {
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
    ): Promise<PermissionResult | OAuthTokenRefreshResult> {
        if (record.request.subtype === 'oauth_token_refresh') {
            const getOAuthToken: GetOAuthTokenCallback | undefined = this.config.options?.getOAuthToken;
            if (!getOAuthToken) {
                throw new Error('getOAuthToken callback is not provided.');
            }
            return { accessToken: await getOAuthToken({ signal }) };
        }
        if (record.request.subtype === 'can_use_tool') {
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
        throw new Error(`Unsupported control request subtype: ${record.request.subtype}`);
    }
}

export function query(
    ctx: Readonly<{ agentRuntime: Readonly<{ exec: ClaudeSdkQueryContext }> }>,
    config: Readonly<{
        prompt: QueryPrompt;
        options?: QueryOptions;
        onMessageReceived?: (message: SDKMessage) => void;
    }>,
): ClaudeSdkQuery {
    return queryWithContext(ctx.agentRuntime.exec, config);
}

export function queryWithContext(
    ctx: ClaudeSdkQueryContext,
    config: Parameters<typeof query>[1],
): ClaudeSdkQuery {
    return new ClaudeSdkQuery(ctx, config);
}
