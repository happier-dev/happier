import { configuration } from '@/configuration';
import type {
    RuntimeTurnConfigUpdate,
    RuntimeTurnStartOrLoadOptions,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import { logger } from '@/ui/logger';

import { CodexMcpClient } from '../../mcp/sessionClient';
import { resolveCodexMcpServerSpawn } from '../../mcp/resolveCodexMcpServerSpawn';
import { buildCodexMcpStartConfigForMessage } from '../../utils/buildCodexMcpStartConfigForMessage';
import { resolveCodexMcpPolicyForPermissionMode } from '../../utils/permissionModePolicy';
import { publishCodexSessionIdMetadata } from '@/backends/codex/identity/codexSessionIdMetadata';
import { DiffProcessor } from '../../utils/diffProcessor';
import { createCodexMcpMessageHandler } from '../mcpMessageHandler';
import { extractCodexToolErrorText } from '../sessionTurnLifecycle';
import { createCodexRequestUserInputBridge } from '../codexRequestUserInputBridge';
import type {
    CodexNativeRuntime,
    CodexRuntimeFactoryParams,
} from '../session/types';

type CodexMcpRuntime = CodexNativeRuntime & Readonly<{
    shouldResumeAfterPermissionModeChange: () => boolean;
}>;

export async function createCodexMcpRuntime(
    params: CodexRuntimeFactoryParams,
): Promise<CodexMcpRuntime> {
    const codexMcpServer = await resolveCodexMcpServerSpawn();
    const client = new CodexMcpClient({
        mode: codexMcpServer.mode,
        command: codexMcpServer.command,
    });
    const diffProcessor = new DiffProcessor((message) => {
        params.session.sendCodexMessage(message);
    });
    const lastCodexThreadIdPublished: { value: string | null } = { value: null };
    let first = true;
    let turnInFlight = false;
    let currentModelId: string | null = null;

    const publishCodexThreadIdToMetadata = (): void => {
        publishCodexSessionIdMetadata({
            session: params.session,
            getCodexThreadId: () => client.getSessionId(),
            backendMode: 'mcp',
            transcriptStorage: process.env.HAPPIER_TRANSCRIPT_STORAGE === 'direct' ? 'direct' : 'persisted',
            codexHome: process.env.CODEX_HOME ?? null,
            activeServerDir: configuration.activeServerDir,
            lastPublished: lastCodexThreadIdPublished,
        });
    };

    const handleMcpMessage = createCodexMcpMessageHandler({
        logger,
        session: params.session,
        messageBuffer: params.messageBuffer,
        sendReady: () => undefined,
        publishCodexThreadIdToMetadata,
        diffProcessor,
        getCurrentTaskId: () => null,
        setCurrentTaskId: () => undefined,
        getThinking: () => turnInFlight,
        setThinking: (next) => {
            turnInFlight = next;
            params.setThinking(next);
        },
    });
    const requestUserInputBridge = createCodexRequestUserInputBridge({
        permissionHandler: params.permissionHandler,
        continueSession: async (prompt) => {
            await client.continueSession(prompt);
        },
        logger,
    });
    client.setPermissionHandler(params.permissionHandler);
    client.setHandler((message) => {
        handleMcpMessage(message);
        void requestUserInputBridge.onCodexEvent(message);
    });

    const beginTurn = (): void => {
        turnInFlight = true;
        params.setThinking(true);
    };

    const startOrLoad = async (options: Readonly<{
        resumeId?: string;
        importHistory?: boolean;
    }>) => {
        void options.importHistory;
        const resumeId = typeof options.resumeId === 'string' ? options.resumeId.trim() : '';
        if (resumeId) {
            throw new Error('Codex MCP sessions cannot resume vendor sessions; use Codex app-server or ACP.');
        }
        await client.connect();
    };

    const sendPrompt = async (prompt: string): Promise<void> => {
        const permissionMode = params.getPermissionMode?.() ?? 'default';
        // For Happier's 'default' mode, omit sandbox/approvalPolicy so the Codex MCP subprocess
        // falls back to ~/.codex/config.toml (top-level approval_policy/sandbox_mode or a
        // `profile = "..."` selection). Non-default modes still override.
        const mcpPolicy =
            permissionMode === 'default'
                ? { approvalPolicy: null as null, sandbox: null as null }
                : resolveCodexMcpPolicyForPermissionMode(permissionMode);
        if (!client.hasActiveSession()) {
            const response = await client.startSession(
                buildCodexMcpStartConfigForMessage({
                    message: prompt,
                    first,
                    sandbox: mcpPolicy.sandbox,
                    approvalPolicy: mcpPolicy.approvalPolicy,
                    mcpServers: params.mcpServers,
                    mode: { model: currentModelId },
                    cwd: params.directory,
                }),
            );
            const startError = extractCodexToolErrorText(response);
            if (startError) {
                client.clearSession();
                throw new Error(startError);
            }
            publishCodexThreadIdToMetadata();
            first = false;
            return;
        }

        const response = await client.continueSession(prompt);
        const continueError = extractCodexToolErrorText(response);
        if (continueError) {
            client.clearSession();
            throw new Error(continueError);
        }
        publishCodexThreadIdToMetadata();
    };

    const flushTurn = (): void => {
        diffProcessor.flushTurn();
        turnInFlight = false;
        params.setThinking(false);
    };

    const reset = async (): Promise<void> => {
        client.clearSession();
        diffProcessor.reset();
        first = true;
        turnInFlight = false;
        params.setThinking(false);
    };

    const cancel = async (): Promise<void> => {
        await client.forceCloseSession();
        turnInFlight = false;
        params.setThinking(false);
    };

    const setSessionModel = async (modelId: string): Promise<void> => {
        currentModelId = modelId.trim() || null;
    };

    return {
        beginTurnLifecycle() {
            beginTurn();
        },
        async startOrLoadSession(options?: RuntimeTurnStartOrLoadOptions) {
            await startOrLoad({
                ...(typeof options?.resumeId === 'string' ? { resumeId: options.resumeId } : {}),
                ...(typeof options?.importHistory === 'boolean'
                    ? { importHistory: options.importHistory }
                    : {}),
            });
        },
        async sendTurnPrompt(prompt: string) {
            await sendPrompt(prompt);
        },
        async steerInFlightTurn(_message: string) {
            throw new Error('Codex MCP sessions do not support in-flight steering');
        },
        async waitForTurnCompletion() {
            flushTurn();
        },
        subscribeRuntimeMessages() {
            return () => undefined;
        },
        async respondToPermission() {},
        async cancelTurn() {
            await cancel();
        },
        readSessionIdentity() {
            return { sessionId: client.getSessionId() };
        },
        async updateSessionRuntimeConfig(update: RuntimeTurnConfigUpdate) {
            if (typeof update.modeId === 'string') {
                await Promise.resolve();
            }
            if (typeof update.modelId === 'string') {
                await setSessionModel(update.modelId);
            }
            if (update.configOption) {
                await Promise.resolve();
            }
        },
        async resetOrDisposeRuntime() {
            await reset();
        },
        shouldResumeAfterPermissionModeChange: () => false,
    };
}
