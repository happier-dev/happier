/**
 * Codex MCP Client - Simple wrapper for Codex tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod/v4';

import { logger } from '@/ui/logger';
import type { CodexSessionConfig, CodexToolResponse } from './types';

import { createCodexTransport, type CodexMcpClientSpawnMode } from './mcp/client';
import { registerCodexPermissionHandlers, type CodexMcpPermissionHandler } from './mcp/elicitationHandler';
import { getCodexElicitationToolCallId, getCodexEventToolCallId } from './mcp/elicitationTypes';

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days
const CodexEventNotificationSchema = z.object({
    method: z.literal('codex/event'),
    params: z.object({
        msg: z.any()
    })
}).passthrough() as any;

export { getCodexElicitationToolCallId, getCodexEventToolCallId };

export class CodexMcpClient {
    private client: Client;
    private transport: StdioClientTransport | null = null;
    private connected = false;
    private threadId: string | null = null;
    private conversationId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private permissionHandler: CodexMcpPermissionHandler | null = null;
    private codexCommand: string;
    private mode: CodexMcpClientSpawnMode;
    private mcpServerArgs: string[];
    private pendingAmendments = new Map<string, string[]>();

    constructor(options?: { command?: string; mode?: CodexMcpClientSpawnMode; args?: string[] }) {
        this.codexCommand = options?.command ?? 'codex';
        this.mode = options?.mode ?? 'codex-cli';
        this.mcpServerArgs = options?.args ?? [];
        this.client = this.createClient();
    }

    private createClient(): Client {
        const client = new Client(
            { name: 'happy-codex-client', version: '1.0.0' },
            { capabilities: { elicitation: {} } }
        );

        client.setNotificationHandler(CodexEventNotificationSchema, (data: any) => {
            const msg = data.params.msg as Record<string, unknown> | null;
            this.updateIdentifiersFromEvent(msg);
            this.handler?.(msg);

            if (msg && msg.type === 'exec_approval_request') {
                const callId = getCodexEventToolCallId(msg);
                const amendment = msg.proposed_execpolicy_amendment;
                if (typeof callId === 'string' && Array.isArray(amendment)) {
                    this.pendingAmendments.set(callId, amendment.filter((p): p is string => typeof p === 'string'));
                }
            }
        });

        return client;
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    setPermissionHandler(handler: CodexMcpPermissionHandler): void {
        this.permissionHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const { transport, versionInfo } = createCodexTransport({
            codexCommand: this.codexCommand,
            mode: this.mode,
            mcpServerArgs: this.mcpServerArgs,
        });
        this.transport = transport;

        registerCodexPermissionHandlers({
            client: this.client,
            versionInfo,
            getPermissionHandler: () => this.permissionHandler,
            pendingAmendments: this.pendingAmendments,
        });

        await this.client.connect(this.transport);
        this.connected = true;

        logger.debug('[CodexMCP] Connected to Codex');
    }

    private isClosedTransportError(error: unknown): boolean {
        const record = error as { code?: unknown; message?: unknown } | null;
        const code = typeof record?.code === 'number' ? record.code : null;
        if (code === -32000) {
            return true;
        }
        const message = typeof record?.message === 'string' ? record.message.toLowerCase() : '';
        if (code === -32001 && message.includes('aborterror')) {
            return true;
        }
        return message.includes('connection closed') || message.includes('not connected');
    }

    private async callToolWithReconnectRetry<T>(call: () => Promise<T>): Promise<T> {
        try {
            return await call();
        } catch (error) {
            if (!this.isClosedTransportError(error)) {
                throw error;
            }

            logger.debug('[CodexMCP] Transport closed during tool call; reconnecting and retrying once');
            try {
                await this.disconnect();
            } catch {
                // Best effort: continue to connect retry path.
            }
            await this.connect();
            return await call();
        }
    }

    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        logger.debug('[CodexMCP] Starting Codex session:', config);

        const response = await this.callToolWithReconnectRetry(() =>
            this.client.callTool({
                name: 'codex',
                arguments: config as any
            }, undefined, {
                signal: options?.signal,
                timeout: DEFAULT_TIMEOUT,
            }),
        );

        logger.debug('[CodexMCP] startSession response:', response);
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }

    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        if (!this.threadId) {
            throw new Error('No active session. Call startSession first.');
        }

        if (!this.conversationId) {
            this.conversationId = this.threadId;
            logger.debug('[CodexMCP] conversationId missing, defaulting to threadId:', this.conversationId);
        }

        const args: Record<string, unknown> = { threadId: this.threadId, prompt };
        if (this.conversationId) {
            args.conversationId = this.conversationId;
        }
        logger.debug('[CodexMCP] Continuing Codex session:', args);

        const response = await this.callToolWithReconnectRetry(() =>
            this.client.callTool({
                name: 'codex-reply',
                arguments: args
            }, undefined, {
                signal: options?.signal,
                timeout: DEFAULT_TIMEOUT
            }),
        );

        logger.debug('[CodexMCP] continueSession response:', response);
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }

    private updateIdentifiersFromEvent(event: any): void {
        if (!event || typeof event !== 'object') {
            return;
        }

        const candidates: any[] = [event];
        if (event.data && typeof event.data === 'object') {
            candidates.push(event.data);
        }

        for (const candidate of candidates) {
            const threadId =
                candidate.thread_id
                ?? candidate.threadId
                ?? candidate.session_id
                ?? candidate.sessionId;
            if (threadId) {
                this.threadId = threadId;
                logger.debug('[CodexMCP] Thread ID extracted from event:', this.threadId);
            }

            const conversationId = candidate.conversation_id ?? candidate.conversationId;
            if (conversationId) {
                this.conversationId = conversationId;
                logger.debug('[CodexMCP] Conversation ID extracted from event:', this.conversationId);
            }
        }
    }

    private extractIdentifiers(response: any): void {
        const meta = response?.meta || {};
        const structured =
            response?.structuredContent
            ?? response?.structured_content
            ?? response?.structured_output
            ?? undefined;

        const threadId =
            (structured && typeof structured === 'object' ? (structured as any).threadId ?? (structured as any).thread_id : undefined)
            ?? meta.threadId
            ?? meta.thread_id
            ?? meta.sessionId
            ?? meta.session_id
            ?? response?.threadId
            ?? response?.thread_id
            ?? response?.sessionId
            ?? response?.session_id;
        if (threadId) {
            this.threadId = threadId;
            logger.debug('[CodexMCP] Thread ID extracted:', this.threadId);
        }

        const conversationId =
            (structured && typeof structured === 'object' ? (structured as any).conversationId ?? (structured as any).conversation_id : undefined)
            ?? meta.conversationId
            ?? meta.conversation_id
            ?? response?.conversationId
            ?? response?.conversation_id;
        if (conversationId) {
            this.conversationId = conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        }

        const content = response?.content;
        if (Array.isArray(content)) {
            for (const item of content) {
                if (!this.threadId && item?.threadId) {
                    this.threadId = item.threadId;
                    logger.debug('[CodexMCP] Thread ID extracted from content:', this.threadId);
                }
                if (!this.threadId && item?.sessionId) {
                    this.threadId = item.sessionId;
                    logger.debug('[CodexMCP] Thread ID extracted from content (sessionId):', this.threadId);
                }
                if (!this.conversationId && item && typeof item === 'object' && 'conversationId' in item && item.conversationId) {
                    this.conversationId = item.conversationId;
                    logger.debug('[CodexMCP] Conversation ID extracted from content:', this.conversationId);
                }
            }
        }
    }

    getThreadId(): string | null {
        return this.threadId;
    }

    getSessionId(): string | null {
        return this.threadId;
    }

    setThreadIdForResume(threadId: string): void {
        this.threadId = threadId;
        this.conversationId = null;
        logger.debug('[CodexMCP] Session seeded for resume:', this.threadId);
    }

    setSessionIdForResume(sessionId: string): void {
        this.setThreadIdForResume(sessionId);
    }

    hasActiveSession(): boolean {
        return this.threadId !== null;
    }

    clearSession(): void {
        const previousSessionId = this.threadId;
        this.threadId = null;
        this.conversationId = null;
        logger.debug('[CodexMCP] Session cleared, previous sessionId:', previousSessionId);
    }

    storeSessionForResume(): string | null {
        logger.debug('[CodexMCP] Storing session for potential resume:', this.threadId);
        return this.threadId;
    }

    async forceCloseSession(): Promise<void> {
        logger.debug('[CodexMCP] Force closing session');
        try {
            await this.disconnect();
        } finally {
            this.clearSession();
        }
        logger.debug('[CodexMCP] Session force-closed');
    }

    async disconnect(): Promise<void> {
        if (!this.connected) return;

        const pid = this.transport?.pid ?? null;
        logger.debug(`[CodexMCP] Disconnecting; child pid=${pid ?? 'none'}`);

        try {
            logger.debug('[CodexMCP] client.close begin');
            await this.client.close();
            logger.debug('[CodexMCP] client.close done');
        } catch (e) {
            logger.debug('[CodexMCP] Error closing client, attempting transport close directly', e);
            try {
                logger.debug('[CodexMCP] transport.close begin');
                await this.transport?.close?.();
                logger.debug('[CodexMCP] transport.close done');
            } catch {}
        }

        if (pid) {
            try {
                process.kill(pid, 0);
                logger.debug('[CodexMCP] Child still alive, sending SIGKILL');
                try { process.kill(pid, 'SIGKILL'); } catch {}
            } catch {}
        }

        this.transport = null;
        this.connected = false;
        this.client = this.createClient();
        logger.debug(`[CodexMCP] Disconnected; session ${this.threadId ?? 'none'} preserved`);
    }
}
