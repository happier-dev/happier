import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { Metadata, PermissionMode } from '@/api/types';
import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId, StartSessionResult } from '@/agent/core';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createOpenCodeServerRuntime } from '@/backends/opencode/server/runtime';

type DraftDeltaParams = Readonly<{
    localId: string;
    segmentKind: 'assistant' | 'thinking';
    sidechainId?: string | null;
    deltaText: string;
    createdAtMs?: number;
}>;

type ToolMessageBody = Readonly<{
    type: 'tool-call' | 'tool-result';
    callId?: string;
    name?: string;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
}>;

type ExecutionRunSessionAdapter = Pick<ApiSessionClient,
    'sessionId'
    | 'ensureMetadataSnapshot'
    | 'getMetadataSnapshot'
    | 'getLastObservedMessageSeq'
    | 'keepAlive'
    | 'updateMetadata'
    | 'sendAgentMessage'
    | 'sendAgentMessageCommitted'
    | 'sendTranscriptDraftDelta'
>;

function isOpenCodeProvider(provider: ACPProvider): boolean {
    return String(provider ?? '').trim().toLowerCase() === 'opencode';
}

function isToolMessageBody(body: unknown): body is ToolMessageBody {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const type = (body as { type?: unknown }).type;
    return type === 'tool-call' || type === 'tool-result';
}

export function createOpenCodeServerExecutionRunBackend(args: Readonly<{
    cwd: string;
    env?: NodeJS.ProcessEnv;
    permissionMode: PermissionMode;
    permissionHandler?: Readonly<{
        handleToolCall: (toolCallId: string, toolName: string, input: unknown) => Promise<{
            decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
            execPolicyAmendment?: Readonly<{ command: string[] }>;
            answers?: Record<string, string>;
        }>;
    }> | null;
}>): AgentBackend {
    const handlers = new Set<AgentMessageHandler>();
    const assistantTextByLocalId = new Map<string, string>();
    const toolNameByCallId = new Map<string, string>();
    let metadataSnapshot: Metadata = {
        path: args.cwd,
        host: 'localhost',
        homeDir: args.cwd,
        happyHomeDir: args.cwd,
        happyLibDir: args.cwd,
        happyToolsDir: args.cwd,
    };
    let sessionId: SessionId | null = null;
    let inFlightPrompt: Promise<void> | null = null;
    let lastObservedMessageSeq = 0;

    const emit = (message: AgentMessage): void => {
        for (const handler of handlers) {
            handler(message);
        }
    };

    const emitAssistantMessage = (localId: string | null | undefined, message: string): void => {
        if (!message) return;
        const assistantKey = String(localId ?? '').trim() || '__main__';
        const previousText = assistantTextByLocalId.get(assistantKey) ?? '';
        const nextFullText = message.startsWith(previousText) ? message : `${previousText}${message}`;
        if (nextFullText === previousText) return;
        assistantTextByLocalId.set(assistantKey, nextFullText);
        emit({ type: 'model-output', fullText: nextFullText });
        lastObservedMessageSeq += 1;
    };

    const emitToolMessage = (body: ToolMessageBody): void => {
        const callId = String(body.callId ?? '').trim();
        const toolName = typeof body.name === 'string' && body.name.trim() ? body.name : toolNameByCallId.get(callId) ?? 'OpenCodeTool';
        if (body.type === 'tool-call') {
            if (callId) {
                toolNameByCallId.set(callId, toolName);
            }
            emit({
                type: 'tool-call',
                toolName,
                args: body.input && typeof body.input === 'object' && !Array.isArray(body.input)
                    ? body.input as Record<string, unknown>
                    : {},
                callId,
            });
            lastObservedMessageSeq += 1;
            return;
        }

        emit({
            type: 'tool-result',
            toolName,
            result: body.output ?? null,
            callId,
            isError: body.isError === true,
        });
        lastObservedMessageSeq += 1;
    };

    const sessionAdapter: ExecutionRunSessionAdapter = {
        sessionId: 'opencode-server-execution-run',
        ensureMetadataSnapshot: async () => metadataSnapshot,
        getMetadataSnapshot: () => metadataSnapshot,
        getLastObservedMessageSeq: () => lastObservedMessageSeq,
        keepAlive: () => undefined,
        updateMetadata: async (updater: Parameters<ApiSessionClient['updateMetadata']>[0]) => {
            const next = await updater(metadataSnapshot);
            metadataSnapshot = next ?? metadataSnapshot;
        },
        sendAgentMessage: (_provider: Parameters<ApiSessionClient['sendAgentMessage']>[0], body: Parameters<ApiSessionClient['sendAgentMessage']>[1]) => {
            if (body.type === 'message') {
                emitAssistantMessage(null, String(body.message ?? ''));
                return;
            }
            if (isToolMessageBody(body)) {
                emitToolMessage(body);
            }
        },
        sendAgentMessageCommitted: async (
            _provider: Parameters<ApiSessionClient['sendAgentMessageCommitted']>[0],
            body: Parameters<ApiSessionClient['sendAgentMessageCommitted']>[1],
            opts: Parameters<ApiSessionClient['sendAgentMessageCommitted']>[2],
        ) => {
            if (body.type === 'message') {
                emitAssistantMessage(opts.localId, String(body.message ?? ''));
                return;
            }
            if (isToolMessageBody(body)) {
                emitToolMessage(body);
            }
        },
        sendTranscriptDraftDelta: (provider: ACPProvider, params: Parameters<ApiSessionClient['sendTranscriptDraftDelta']>[1]) => {
            if (!isOpenCodeProvider(provider) || params.segmentKind !== 'assistant' || !params.deltaText) return;
            const assistantKey = params.localId || '__main__';
            const previousText = assistantTextByLocalId.get(assistantKey) ?? '';
            assistantTextByLocalId.set(assistantKey, `${previousText}${params.deltaText}`);
            emit({ type: 'model-output', textDelta: params.deltaText });
        },
    };

    const runtime = createOpenCodeServerRuntime({
        directory: args.cwd,
        env: args.env,
        session: sessionAdapter as unknown as ApiSessionClient,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: (args.permissionHandler ?? null) as any,
        onThinkingChange: (thinking) => {
            emit({ type: 'status', status: thinking ? 'running' : 'idle' });
        },
        getPermissionMode: () => args.permissionMode,
    });

    const ensureStarted = async (resumeId?: SessionId): Promise<SessionId> => {
        if (sessionId && (!resumeId || resumeId === sessionId)) {
            return sessionId;
        }
        await runtime.startOrLoad(resumeId ? { resumeId } : {});
        const startedSessionId = runtime.getSessionId();
        if (!startedSessionId) {
            throw new Error('OpenCode server execution run did not return a session id');
        }
        sessionId = startedSessionId as SessionId;
        return sessionId;
    };

    return {
        async startSession(initialPrompt?: string): Promise<StartSessionResult> {
            assistantTextByLocalId.clear();
            const startedSessionId = await ensureStarted();
            if (typeof initialPrompt === 'string' && initialPrompt.trim()) {
                await this.sendPrompt(startedSessionId, initialPrompt);
            }
            return { sessionId: startedSessionId };
        },
        async loadSession(existingSessionId: SessionId): Promise<StartSessionResult> {
            assistantTextByLocalId.clear();
            const startedSessionId = await ensureStarted(existingSessionId);
            return { sessionId: startedSessionId };
        },
        async sendPrompt(requestedSessionId: SessionId, prompt: string): Promise<void> {
            const activeSessionId = await ensureStarted(requestedSessionId);
            if (activeSessionId !== requestedSessionId) {
                sessionId = activeSessionId;
            }
            assistantTextByLocalId.clear();
            toolNameByCallId.clear();
            runtime.beginTurn();
            const promptWork = runtime.sendPrompt(prompt);
            inFlightPrompt = promptWork;
            try {
                await promptWork;
            } finally {
                runtime.flushTurn();
                if (inFlightPrompt === promptWork) {
                    inFlightPrompt = null;
                }
            }
        },
        async cancel(_sessionId: SessionId): Promise<void> {
            await runtime.cancel();
        },
        onMessage(handler: AgentMessageHandler): void {
            handlers.add(handler);
        },
        offMessage(handler: AgentMessageHandler): void {
            handlers.delete(handler);
        },
        async waitForResponseComplete(): Promise<void> {
            await inFlightPrompt;
        },
        async dispose(): Promise<void> {
            await runtime.reset();
            assistantTextByLocalId.clear();
            toolNameByCallId.clear();
            metadataSnapshot = {
                path: args.cwd,
                host: 'localhost',
                homeDir: args.cwd,
                happyHomeDir: args.cwd,
                happyLibDir: args.cwd,
                happyToolsDir: args.cwd,
            };
            inFlightPrompt = null;
            sessionId = null;
        },
    };
}
