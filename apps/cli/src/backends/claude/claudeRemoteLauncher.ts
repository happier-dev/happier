import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/backends/claude/ui/RemoteModeDisplay";
import React from "react";
import { claudeRemoteDispatch } from "./remote/claudeRemoteDispatch";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { AbortError, type SDKAssistantMessage, type SDKMessage, type SDKUserMessage } from "./sdk/types";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import type { EnhancedMode, PermissionMode } from "./loop";
import { RawJSONLines } from "@/backends/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { syncClaudePermissionModeFromMetadata } from "./utils/syncPermissionModeFromMetadata";
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { waitForMessagesOrPending } from '@/agent/runtime/waitForMessagesOrPending';
import type { MessageBatch } from '@/agent/runtime/waitForMessagesOrPending';
import { resolveClaudeRemoteQueuedPromptWithReplaySeed } from '@/backends/claude/remote/resolveClaudeRemoteQueuedPromptWithReplaySeed';
import { cleanupStdinAfterInk } from '@/ui/ink/cleanupStdinAfterInk';
import { restoreStdinBestEffort } from '@/ui/ink/restoreStdinBestEffort';
import { resolveSwitchRequestTarget } from '@/agent/localControl/switchRequestTarget';
import { ensureSessionInfoBeforeSwitch } from '@/backends/claude/utils/ensureSessionInfoBeforeSwitch';
import { ClaudeRemoteTaskOutputCollector } from './remote/sidechains/claudeRemoteTaskOutputCollector';
import { ClaudeRemoteSubagentFileCollector } from './remote/sidechains/claudeRemoteSubagentFileCollector';
import { resolveClaudeSubagentJsonlPathForRemoteSession } from './remote/sidechains/resolveClaudeSubagentJsonlPathForRemoteSession';
import { createClaudeRemoteTeamInboxBridge } from './remote/teamInbox/claudeRemoteTeamInboxBridge';
import { resolveHasTTY } from '@/ui/tty/resolveHasTTY';
import { createNonBlockingStdout } from '@/ui/ink/nonBlockingStdout';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { sendReadyWithPushNotification } from '@/agent/runtime/sendReadyWithPushNotification';
import { getLatestAssistantMessagePreview, getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { shouldSendReadyPushNotification } from '@/settings/notifications/notificationsPolicy';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configuration } from '@/configuration';
import { getProjectPath } from './utils/path';
import { resolveClaudeConfigDirOverride } from './utils/resolveClaudeConfigDirOverride';
import { tryReadTextFileTail } from '@/agent/runtime/readTextFileTail';
import { readClaudeSessionJsonlMessages } from './utils/readClaudeSessionJsonlMessages';
import { normalizeClaudeToolUseNamesInRawJsonLines } from './utils/normalizeClaudeToolUseNames';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';
import type { AccountSettings } from '@happier-dev/protocol';
import { buildTurnChangeSetDiffInput } from '@/agent/tools/diff/buildTurnChangeSetDiffInput';
import { ClaudeTurnChangeTracker } from './utils/ClaudeTurnChangeTracker';
import { isClaudeExplicitDiffToolInput } from './utils/isClaudeExplicitDiffToolInput';
import { createStreamedTranscriptWriter, type StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: PermissionMode;
    allowedTools?: string[];
}

type LaunchErrorInfo = {
    asString: string;
    name?: string;
    message?: string;
    code?: string;
    stack?: string;
};

function getLaunchErrorInfo(e: unknown): LaunchErrorInfo {
    let asString = '[unprintable error]';
    try {
        asString = typeof e === 'string' ? e : String(e);
    } catch {
        // Ignore
    }

    if (!e || typeof e !== 'object') {
        return { asString };
    }

    const err = e as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown };

    const name = typeof err.name === 'string' ? err.name : undefined;
    const message = typeof err.message === 'string' ? err.message : undefined;
    const code = typeof err.code === 'string' || typeof err.code === 'number' ? String(err.code) : undefined;
    const stack = typeof err.stack === 'string' ? err.stack : undefined;

    return { asString, name, message, code, stack };
}

function isAbortError(e: unknown): boolean {
    if (e instanceof AbortError) return true;

    if (!e || typeof e !== 'object') {
        return false;
    }

    const err = e as { name?: unknown; code?: unknown };
    if (typeof err.name === 'string' && err.name === 'AbortError') return true;
    if (typeof err.code === 'string' && err.code === 'ABORT_ERR') return true;

    return false;
}

type ClaudeCodeArtifacts = Readonly<{
    debugFilePath: string | null;
    stderrFilePath: string | null;
}>;

function resolveClaudeCodeExitCode(error: unknown): number | null {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/Claude Code process exited with code (\d+)/);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function resolveClaudeCodeArtifacts(error: unknown): ClaudeCodeArtifacts | null {
    if (!error || typeof error !== 'object') return null;
    const raw = (error as any).happierClaudeCodeArtifacts as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const debugFilePath = typeof (raw as any).debugFilePath === 'string' ? (raw as any).debugFilePath : null;
    const stderrFilePath = typeof (raw as any).stderrFilePath === 'string' ? (raw as any).stderrFilePath : null;
    if (!debugFilePath && !stderrFilePath) return null;
    return { debugFilePath, stderrFilePath };
}

async function formatClaudeCodeArtifactsTailForUi(artifacts: ClaudeCodeArtifacts): Promise<string> {
    const sections: string[] = [];

    const addTailSection = async (label: string, path: string | null) => {
        if (!path) return;
        const tail = await tryReadTextFileTail(path, { maxBytes: 32_000 });
        if (!tail) return;
        const header = `--- ${label} tail (${path}) ---`;
        const body = tail.tail.trimEnd();
        sections.push([header, body.length > 0 ? body : '[empty]', ''].join('\n'));
    };

    await addTailSection('claude-code-debug', artifacts.debugFilePath);
    await addTailSection('claude-code-stderr', artifacts.stderrFilePath);

    return sections.join('\n');
}

function resolveClaudeProjectDir(session: Session): string {
    if (session.transcriptPath) {
        return dirname(session.transcriptPath);
    }
    return getProjectPath(session.path, resolveClaudeConfigDirOverride(process.env));
}

type ClaudeRemoteReadySession = Readonly<{
    sessionId: string;
    sendSessionEvent: (event: { type: 'ready' }) => void;
    getMetadataSnapshot?: () => unknown;
}>;

type ClaudeRemotePushSender = Readonly<{
    sendToAllDevices: (title: string, body: string, opts: { sessionId: string }) => void;
}>;

export function createClaudeRemoteReadyHandler(params: Readonly<{
    session: ClaudeRemoteReadySession;
    pushSender: ClaudeRemotePushSender | null;
    waitingForCommandLabel: string;
    logPrefix: string;
    messageBuffer?: Pick<MessageBuffer, 'getMessages'>;
    getPending: () => unknown;
    getQueueSize: () => number;
    includeAssistantPreviewText?: boolean;
    shouldSendPush?: () => boolean;
    accountSettings?: AccountSettings | null;
    settingsSecretsReadKeys?: readonly Uint8Array[];
}>): () => void {
    return () => {
        if (params.getPending()) return;
        if (params.getQueueSize() !== 0) return;
        if (!params.pushSender) {
            params.session.sendSessionEvent({ type: 'ready' });
            return;
        }
        sendReadyWithPushNotification({
            session: params.session,
            pushSender: params.pushSender,
            waitingForCommandLabel: params.waitingForCommandLabel,
            logPrefix: params.logPrefix,
            sessionTitle: getSessionNotificationTitle(
                typeof params.session.getMetadataSnapshot === 'function'
                    ? () => params.session.getMetadataSnapshot?.()
                    : null,
            ),
            assistantPreviewText: params.messageBuffer ? getLatestAssistantMessagePreview(params.messageBuffer) : null,
            accountSettings: params.accountSettings ?? null,
            settingsSecretsReadKeys: params.settingsSecretsReadKeys,
            includeAssistantPreviewText: params.includeAssistantPreviewText,
            shouldSendPush: params.shouldSendPush,
        });
    };
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Check if we have a TTY for UI rendering
    const hasTTY = resolveHasTTY({
        stdoutIsTTY: process.stdout.isTTY,
        stdinIsTTY: process.stdin.isTTY,
        startedBy: session.startedBy,
    });
    const shouldRenderInkUi = hasTTY && session.startedBy !== 'daemon';
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (shouldRenderInkUi) {
        console.clear();
        const inkStdout = createNonBlockingStdout(process.stdout as any);
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
	            onExit: async () => {
	                // Exit the entire client
	                logger.debug('[remote]: Exiting client via Ctrl-C');
                    session.noteUserAbortRequested();
	                if (!exitReason) {
	                    exitReason = 'exit';
	                }
                    await interruptThenTeardown('exit');
	            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false,
            stdout: inkStdout,
        });
    }

    if (hasTTY) {
        // Ensure we can capture keypresses for the remote-mode UI.
        // Avoid forcing stdin encoding here; Ink (and Node) should handle key decoding safely.
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
    }

	    // Handle abort
	    let exitReason: 'switch' | 'exit' | null = null;
	    let abortController: AbortController | null = null;
	    let abortFuture: Future<void> | null = null;
	    let turnInterrupt: (() => Promise<void>) | null = null;
        let didUserAbortThisLaunch = false;
	    let didSendChangeTitleInstructionForSession = false;
	    const turnChangeTracker = new ClaudeTurnChangeTracker();
	    const suppressedExplicitDiffCallIds = new Set<string>();

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

	    async function doAbort() {
	        logger.debug('[remote]: doAbort');
            session.noteUserAbortRequested();
            didUserAbortThisLaunch = true;
	        if (turnInterrupt) {
	            try {
	                await turnInterrupt();
	            } catch (error) {
                logger.debug('[remote]: turn interrupt failed; falling back to process abort', { error });
                session.noteUserAbortRequested();
                session.client.sendAgentMessage('claude', { type: 'turn_aborted', id: randomUUID() });
                await abort();
                return;
            }
            session.client.sendAgentMessage('claude', { type: 'turn_aborted', id: randomUUID() });
            session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
            return;
        }
	        session.noteUserAbortRequested();
	        session.client.sendAgentMessage('claude', { type: 'turn_aborted', id: randomUUID() });
	        await abort();
	    }

        async function interruptThenTeardown(label: string): Promise<void> {
            if (turnInterrupt) {
                try {
                    await turnInterrupt();
                } catch (error) {
                    logger.debug(`[remote]: turn interrupt failed during ${label}; falling back to process abort`, { error });
                }
            }

            if (!abortFuture) {
                await abort();
                return;
            }

            const graceMs = configuration.claudeRemoteInterruptThenTeardownGraceMs;
            if (!Number.isFinite(graceMs) || graceMs <= 0) {
                await abort();
                return;
            }

            const settled = await Promise.race([
                abortFuture.promise.then(() => true),
                new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => resolve(false), graceMs);
                    timer.unref?.();
                }),
            ]);

            if (!settled) {
                await abort();
            }
        }

	    async function doSwitch() {
	        logger.debug('[remote]: doSwitch');
            session.noteUserAbortRequested();
	        if (!exitReason) {
	            exitReason = 'switch';
	        }
	        await ensureSessionInfoBeforeSwitch({ session });
            await interruptThenTeardown('switch');
	    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', async (params: any) => {
        // Newer clients send a target mode. Older clients send no params.
        // Remote launcher is already in remote mode, so {to:'remote'} is a no-op.
        const to = resolveSwitchRequestTarget(params);
        if (to === 'remote') return true;
        await doSwitch();
        return true;
    }); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage, meta) => session.client.sendClaudeSessionMessage(logMessage, meta)
    );

    const streamedTranscriptWriter: StreamedTranscriptWriter = (() => {
        const client: any = session.client as any;
        const sendAgentMessageCommitted =
            typeof client?.sendAgentMessageCommitted === 'function'
                ? (provider: any, body: any, opts: any) => client.sendAgentMessageCommitted(provider, body, opts)
                : async () => {
                      throw new Error('sendAgentMessageCommitted is unavailable');
                  };

        return createStreamedTranscriptWriter({
            provider: 'claude' as any,
            session: {
                sendAgentMessage: (provider, body, opts) => session.client.sendAgentMessage(provider, body, opts),
                sendAgentMessageCommitted,
            },
        });
    })();

    const taskOutputCollector = new ClaudeRemoteTaskOutputCollector();
    const subagentFileCollector = new ClaudeRemoteSubagentFileCollector({
        emitImported: (body, meta) => {
            messageQueue.enqueue(body, { meta });
        },
        resolveJsonlPathForAgentId: ({ agentId, claudeSessionId }) => {
            const sanitized = String(agentId ?? '').trim();
            if (!sanitized) return null;
            return resolveClaudeSubagentJsonlPathForRemoteSession({
                transcriptPath: session.transcriptPath ?? null,
                projectDir: resolveClaudeProjectDir(session),
                claudeSessionId: claudeSessionId ?? session.sessionId,
                agentId: sanitized,
            });
        },
    });

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        void messageQueue.releaseToolCall(toolCallId);
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());

    const teamInboxBridge = createClaudeRemoteTeamInboxBridge({
        claudeConfigDir: resolveClaudeConfigDirOverride(process.env),
        enqueue: (message) => {
            messageQueue.enqueue(message, { meta: { importedFrom: 'claude-team-inbox' } });
        },
    });
    const teamInboxIntervalId = setInterval(() => {
        void teamInboxBridge.syncAll();
    }, 3000);

    const seededTeamInboxSessionIds = new Set<string>();
    const seedTeamInboxFromTranscriptPath = async (sessionId: string | null, transcriptPath: string | null): Promise<void> => {
        const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!sid) return;
        if (seededTeamInboxSessionIds.has(sid)) return;

        const resolvedTranscriptPath = (() => {
            const direct = typeof transcriptPath === 'string' ? transcriptPath.trim() : '';
            if (direct.length > 0) return direct;
            // Best-effort fallback: try the heuristic project dir path (matches session scanner behavior).
            try {
                const projectDir = resolveClaudeProjectDir(session);
                return join(projectDir, `${sid}.jsonl`);
            } catch {
                return '';
            }
        })();
        if (!resolvedTranscriptPath) return;

        seededTeamInboxSessionIds.add(sid);
        try {
            const messages = await readClaudeSessionJsonlMessages({
                sessionFilePath: resolvedTranscriptPath,
                logLabel: 'CLAUDE_TEAM_INBOX_SEED',
            });
            for (const m of messages) {
                try {
                    teamInboxBridge.observe(normalizeClaudeToolUseNamesInRawJsonLines(m));
                } catch {
                    // ignore malformed history lines
                }
            }
            await teamInboxBridge.syncAll();
        } catch (error) {
            logger.debug('[remote]: failed seeding team inbox from transcript path (non-fatal)', { error });
        }
    };

    let lastAssistantUuidSeen: string | null = null;

    function onMessage(message: SDKMessage) {
        let releaseIds: string[] = [];

        if (message.type === 'assistant') {
            const content = Array.isArray((message as SDKAssistantMessage).message?.content)
                ? (message as SDKAssistantMessage).message.content
                : [];
            for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                if (block.type !== 'tool_use') continue;
                const callId = typeof block.id === 'string' ? block.id : '';
                const toolName = typeof block.name === 'string' ? block.name : '';
                const rawInput = block.input;
                const args = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
                    ? rawInput as Record<string, unknown>
                    : {};
                if (!callId || !toolName) continue;
                turnChangeTracker.observeToolCall({
                    callId,
                    toolName,
                    args,
                    parentToolUseId: (message as SDKAssistantMessage).parent_tool_use_id,
                });
                if (isClaudeExplicitDiffToolInput(toolName, args)) {
                    suppressedExplicitDiffCallIds.add(callId);
                }
            }
        }

        if (message.type === 'user') {
            const content = Array.isArray((message as SDKUserMessage).message?.content)
                ? (message as SDKUserMessage).message.content
                : [];
            for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                if (block.type !== 'tool_result') continue;
                const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
                if (!callId) continue;
                turnChangeTracker.observeToolResult({
                    callId,
                    isError: block.is_error === true,
                });
                if (block.is_error === true) {
                    suppressedExplicitDiffCallIds.delete(callId);
                }
            }
        }

        if (message.type === 'result') {
            if (message.subtype === 'success') {
                const turnChangeSet = turnChangeTracker.completeTurn({
                    sessionId: session.sessionId ?? session.client.sessionId ?? 'unknown',
                    status: 'completed',
                });
                if (turnChangeSet) {
                    const diffCallId = `claude-diff-${turnChangeSet.turnId}`;
                    const syntheticMessages: SDKMessage[] = [
                        {
                            type: 'assistant',
                            parent_tool_use_id: null,
                            message: {
                                role: 'assistant',
                                content: [
                                    {
                                        type: 'tool_use',
                                        id: diffCallId,
                                        name: 'Diff',
                                        input: buildTurnChangeSetDiffInput({
                                            turnChangeSet,
                                            protocol: 'claude',
                                            rawToolName: 'ClaudeTurnDiff',
                                        }),
                                    },
                                ],
                            },
                        },
                        {
                            type: 'user',
                            parent_tool_use_id: null,
                            message: {
                                role: 'user',
                                content: [
                                    {
                                        type: 'tool_result',
                                        tool_use_id: diffCallId,
                                        content: { status: 'completed' },
                                    },
                                ],
                            },
                        },
                    ];

                    for (const syntheticMessage of syntheticMessages) {
                        const converted = sdkToLogConverter.convert(syntheticMessage);
                        if (converted) {
                            messageQueue.enqueue(converted);
                        }
                    }
                }
                suppressedExplicitDiffCallIds.clear();
            } else {
                turnChangeTracker.resetTurn();
                suppressedExplicitDiffCallIds.clear();
            }
        }

        if (message && message.type === 'assistant') {
            const parentToolUseId =
                typeof (message as any).parent_tool_use_id === 'string' ? (message as any).parent_tool_use_id.trim() : '';
            const maybeUuid = typeof (message as any).uuid === 'string' ? (message as any).uuid.trim() : '';
            // Only persist mainline assistant UUIDs. Sidechain/sub-agent assistant messages can also have UUIDs,
            // but resuming at those anchors can produce surprising results.
            if (!parentToolUseId && maybeUuid.length > 0 && maybeUuid !== lastAssistantUuidSeen) {
                lastAssistantUuidSeen = maybeUuid;
                updateMetadataBestEffort(
                    session.client,
                    (metadata) => ({
                        ...metadata,
                        claudeLastAssistantUuid: maybeUuid,
                    }),
                    '[remote]',
                    'last_assistant_uuid',
                );
            }
        }

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // Write to permission handler for tool id resolving
        permissionHandler.onMessage(message);

        const taskOutputIngest = taskOutputCollector.observe(message);
        subagentFileCollector.observe(message);

        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        // When tool result received, release any delayed messages for this tool call
                        releaseIds.push(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        let msg = message;

        if (message.type === 'assistant') {
            const assistantContent = Array.isArray((message as SDKAssistantMessage).message?.content)
                ? (message as SDKAssistantMessage).message.content
                : [];
            const filteredContent = assistantContent.filter((block) => {
                if (!block || typeof block !== 'object') return false;
                if (block.type !== 'tool_use') return true;
                const callId = typeof block.id === 'string' ? block.id : '';
                return !callId || !suppressedExplicitDiffCallIds.has(callId);
            });
            if (filteredContent.length !== assistantContent.length) {
                msg = {
                    ...(message as SDKAssistantMessage),
                    message: {
                        ...(message as SDKAssistantMessage).message,
                        content: filteredContent,
                    },
                };
            }

        }

        if (message.type === 'user') {
            const rawUserContent = (message as SDKUserMessage).message?.content;
            const userContent = Array.isArray(rawUserContent) ? rawUserContent : [];
            const filteredContent = userContent.filter((block) => {
                if (!block || typeof block !== 'object') return false;
                if (block.type !== 'tool_result') return true;
                const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
                return !callId || !suppressedExplicitDiffCallIds.has(callId);
            });
            if (filteredContent.length !== userContent.length) {
                msg = {
                    ...(message as SDKUserMessage),
                    message: {
                        ...(message as SDKUserMessage).message,
                        content: filteredContent,
                    },
                };
            }
        }

        const logMessage = sdkToLogConverter.convert(msg);
        if (logMessage) {
            try {
                teamInboxBridge.observe(logMessage);
            } catch {
                // ignore
            }

            const taskOutputToolUseIds = new Set<string>();
            for (const info of taskOutputIngest.taskOutputToolResults) {
                taskOutputToolUseIds.add(info.toolUseId);
            }

            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            const allowedTools = response.allowedTools ?? response.allowTools;
                            if (allowedTools && allowedTools.length > 0) {
                                permissions.allowedTools = allowedTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }

                        if (taskOutputToolUseIds.has(c.tool_use_id)) {
                            // TaskOutput tool_result payloads can be huge (JSONL transcript). Keep the main transcript compact.
                            content[i] = {
                                ...content[i],
                                content: '',
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain =
                        typeof assistantMsg.parent_tool_use_id === 'string' && assistantMsg.parent_tool_use_id.trim().length > 0;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds,
                            releaseToolCallIds: releaseIds.length > 0 ? releaseIds : undefined,
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage, releaseIds.length > 0 ? { releaseToolCallIds: releaseIds } : undefined);
        }

        for (const imported of taskOutputIngest.imported) {
            messageQueue.enqueue(imported.body, { meta: imported.meta });
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (
                        c.type === 'tool_use' &&
                        typeof c.name === 'string' &&
                        typeof c.id === 'string' &&
                        isGenericSubAgentToolName(c.name) &&
                        c.input &&
                        typeof (c.input as any).prompt === 'string'
                    ) {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    try {
        let pending: MessageBatch<EnhancedMode, string> | null = null;

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null | undefined = undefined;
        let forceNewSession = false;
        let waitForMessageBeforeNextLaunch = false;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = forceNewSession || session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                await permissionHandler.resetAndFlush(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                subagentFileCollector.cleanup(); // Stop any watchers from prior sessions (subagent JSONL lives under session id).
                turnChangeTracker.resetTurn();
                suppressedExplicitDiffCallIds.clear();
                didSendChangeTitleInstructionForSession = false;
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
                forceNewSession = false;
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

	            previousSessionId = session.sessionId;
	            const sessionIdAtLaunchStart = session.sessionId;
	            const controller = new AbortController();
	            abortController = controller;
	            abortFuture = new Future<void>();
                didUserAbortThisLaunch = false;
	            let modeHash: string | null = null;
	            let mode: EnhancedMode | null = null;
	            let didReplaySeedBootstrap = false;
	            try {
                const waitForNextBatch = async (): Promise<MessageBatch<EnhancedMode, string> | null> => {
                    return await waitForMessagesOrPending({
                        messageQueue: session.queue,
                        abortSignal: controller.signal,
                        popPendingMessage: async () => {
                            // Only materialize pending items when there are no committed transcript messages
                            // queued locally; committed messages must be processed first.
                            if (session.queue.size() > 0) return false;
                            return await session.client.popPendingMessage();
                        },
                        waitForMetadataUpdate: (signal) => session.client.waitForMetadataUpdate(signal),
                        onMetadataUpdate: () => {
                            const updated = syncClaudePermissionModeFromMetadata({ session, permissionHandler });
                            if (updated) {
                                logger.debug(`[remote]: Permission mode updated from metadata to: ${updated}`);
                            }
                        },
                    });
                };

                if (waitForMessageBeforeNextLaunch) {
                    waitForMessageBeforeNextLaunch = false;
                    messageBuffer.addMessage('Claude Code exited unexpectedly. Waiting for the next message to retry...', 'status');
                    const msg = await waitForNextBatch();
                    if (!msg) {
                        if (exitReason) {
                            continue;
                        }
                        if (session.queue.isClosed()) {
                            exitReason = 'exit';
                            continue;
                        }
                        // If we were aborted without an explicit exit/switch request (e.g. detached client),
                        // stay parked to avoid a tight retry loop.
                        waitForMessageBeforeNextLaunch = true;
                        continue;
                    }
                    pending = msg;
                }

                const readyHandler = createClaudeRemoteReadyHandler({
                    session: session.client,
                    pushSender: session.pushSender,
                    waitingForCommandLabel: 'Claude',
                    logPrefix: '[remote]',
                    messageBuffer,
                    getPending: () => pending,
                    getQueueSize: () => session.queue.size(),
                    accountSettings: session.accountSettings ?? null,
                    settingsSecretsReadKeys: session.accountSettingsSecretsReadKeys,
                    includeAssistantPreviewText:
                        session.accountSettings?.notificationsSettingsV1?.readyIncludeMessageText !== false,
                    shouldSendPush: () => shouldSendReadyPushNotification(session.accountSettings ?? null),
                });

                    const { mcpServers: baseMcpServers, mcpConfigJson: baseMcpConfigJson } = await session.getOrCreateHappierMcpBridge();
                    const resumeSessionAt = (() => {
                        const snapshot = session.client.getMetadataSnapshot?.() as any;
                        const value = typeof snapshot?.claudeLastAssistantUuid === 'string' ? snapshot.claudeLastAssistantUuid.trim() : '';
                        return value.length > 0 ? value : null;
                    })();

                    // If this is a restarted daemon process resuming an existing agent-team session,
                    // we may not replay transcript history through `onMessage`. Seed team inbox mapping
                    // from the transcript file so unread teammate messages still import correctly.
                    await seedTeamInboxFromTranscriptPath(session.sessionId, session.transcriptPath ?? null);

                    const remoteResult = await claudeRemoteDispatch({
                        sessionId: session.sessionId,
                        transcriptPath: session.transcriptPath,
                        path: session.path,
                        hookSettingsPath: session.hookSettingsPath,
                        jsRuntime: session.jsRuntime,
                        resumeSessionAt,
                        happierMcpServers: baseMcpServers,
                        happierMcpConfigJson: baseMcpConfigJson,
                        streamedTranscriptWriter,
                    setTurnInterrupt: (handler: (() => Promise<void>) | null) => {
                        turnInterrupt = handler;
                    },
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                        nextMessage: async () => {
                            if (pending) {
                                const p = pending;
                                pending = null;
                                modeHash = p.hash;
                                mode = p.mode;
                                permissionHandler.handleModeChange(p.mode.permissionMode);
                                return { message: p.message, mode: p.mode };
                            }

                                const msg = await waitForNextBatch();
                                if (!msg) {
                                    return null;
                                }

                            // Check if mode has changed
                            if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                logger.debug('[remote]: mode has changed, pending message');
                                pending = msg;
                                return null;
                            }
                            modeHash = msg.hash;
                            const nextMode = msg.mode;
                            mode = nextMode;
                            permissionHandler.handleModeChange(nextMode.permissionMode);
                            const replaySeedResolution = await resolveClaudeRemoteQueuedPromptWithReplaySeed({
                                sessionClient: session.client,
                                batch: { message: msg.message, mode: msg.mode },
                                didBootstrap: didReplaySeedBootstrap,
                            });
                            didReplaySeedBootstrap = replaySeedResolution.didBootstrap;

                            const effectiveMessage = (() => {
                                const raw = typeof replaySeedResolution.message === 'string' ? replaySeedResolution.message : '';
                                if (!raw.trim()) return raw;
                                if (didSendChangeTitleInstructionForSession) return raw;

                                const lower = raw.toLowerCase();
                                const appendLower =
                                    typeof msg.mode.appendSystemPrompt === 'string' ? msg.mode.appendSystemPrompt.toLowerCase() : '';
                                const customLower =
                                    typeof msg.mode.customSystemPrompt === 'string' ? msg.mode.customSystemPrompt.toLowerCase() : '';

                                const alreadyMentionsChangeTitle =
                                    CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => lower.includes(alias)) ||
                                    CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => appendLower.includes(alias)) ||
                                    CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => customLower.includes(alias));

                                didSendChangeTitleInstructionForSession = true;
                                if (alreadyMentionsChangeTitle) return raw;
                                return `${raw}\n\n${CHANGE_TITLE_INSTRUCTION}`;
                            })();

                            return {
                                message: effectiveMessage,
                                mode: msg.mode,
                            }
                    },
                    onSessionFound: (sessionId: string, data: unknown) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId, data as any);
                        const transcriptPath = typeof (data as any)?.transcript_path === 'string' ? String((data as any).transcript_path) : null;
                        void seedTeamInboxFromTranscriptPath(sessionId, transcriptPath);
                    },
                    onCheckpointCaptured: (checkpointId: string) => {
                        updateMetadataBestEffort(
                            session.client,
                            (metadata) => ({
                                ...metadata,
                                claudeLastCheckpointId: checkpointId,
                            }),
                            '[remote]',
                            'checkpoint_captured',
                        );
                    },
                    onCapabilities: (caps: any) => {
                        if (!caps || typeof caps !== 'object') return;
                        updateMetadataBestEffort(
                            session.client,
                            (metadata) => ({
                                ...metadata,
                                ...(Array.isArray(caps.slashCommands) ? { slashCommands: caps.slashCommands } : {}),
                                ...(Array.isArray(caps.slashCommandDetails) ? { slashCommandDetails: caps.slashCommandDetails } : {}),
                            }),
                            '[remote]',
                            'capabilities_update',
                        );
                        },
                        onThinkingChange: session.onThinkingChange,
                            claudeArgs: session.claudeArgs,
                            onMessage,
                        onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        forceNewSession = true;
                        session.clearSessionId();
                    },
                    onReady: async () => {
                        await messageQueue.flush();
                        readyHandler();
                    },
                    signal: abortController.signal,
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                const abortError = isAbortError(e);
                logger.debug('[remote]: launch error', {
                    ...getLaunchErrorInfo(e),
                    abortError,
                });

                if (exitReason) {
                    // Exit already requested (switch/exit).
                } else if (abortError) {
                    if (controller.signal.aborted) {
                        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    }
                    // Claude Code sometimes exits in a non-resumable state after a force-abort. If this abort was
                    // explicitly user-initiated (not a mode switch), clear the stored session ID so the next launch
                    // doesn't get stuck trying to resume a dead session.
	                    if (
	                        controller.signal.aborted
	                        && didUserAbortThisLaunch
	                        && !exitReason
	                    ) {
	                        forceNewSession = true;
	                        session.clearSessionId();
	                    }
                    continue;
                } else {
                    const exitCode = resolveClaudeCodeExitCode(e);
                    if (exitCode === 1) {
                        const artifacts = resolveClaudeCodeArtifacts(e);
                        const tailText = artifacts ? await formatClaudeCodeArtifactsTailForUi(artifacts) : '';
                        const base = formatErrorForUi(e, { maxChars: 12_000 });
                        const message = tailText
                            ? `${base}\n\n${tailText}`
                            : base;
                        session.client.sendSessionEvent({ type: 'message', message });
	                        if (
	                            controller.signal.aborted
	                            && didUserAbortThisLaunch
	                            && !exitReason
	                        ) {
	                            forceNewSession = true;
	                            session.clearSessionId();
                        } else if (
                            // If we attempted to resume an existing Claude Code session and it immediately exited with
                            // code 1 (common for non-resumable sessions after interrupts/crashes), avoid getting stuck
                            // in a permanent loop where we keep passing `--resume <dead-session-id>` forever.
                            //
                            // In that case, clear the stored session ID so the next launch creates a fresh Claude Code
                            // session. This is a best-effort recovery path: if the underlying session is resumable, a
                            // non-aborted run will keep the session id stable and this will not trigger.
                            !controller.signal.aborted
                            && typeof sessionIdAtLaunchStart === 'string'
                            && sessionIdAtLaunchStart.trim().length > 0
                            && session.sessionId === sessionIdAtLaunchStart
                            && !exitReason
                        ) {
                            forceNewSession = true;
                            session.clearSessionId();
                        }
                        waitForMessageBeforeNextLaunch = true;
                        continue;
                    } else {
                        session.client.sendSessionEvent({ type: 'message', message: `Claude process error: ${formatErrorForUi(e)}` });
                        continue;
                    }
                }
            } finally {

                logger.debug('[remote]: launch finally');

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                turnInterrupt = null;
                logger.debug('[remote]: launch done');
                await permissionHandler.resetAndFlush();
                turnChangeTracker.resetTurn();
                suppressedExplicitDiffCallIds.clear();
                modeHash = null;
                mode = null;
                // Session IDs can change during a remote run (system init / resume / fork / compact).
                // Keep previousSessionId in sync so we don't treat the same session as "new" again
                // on the next outer loop iteration.
                previousSessionId = session.sessionId;
            }
        }
    } finally {

        // Clean up permission handler
        await permissionHandler.resetAndFlush();
        permissionHandler.dispose();
        subagentFileCollector.cleanup();
        clearInterval(teamInboxIntervalId);
        teamInboxBridge.cleanup();

        if (inkInstance) {
            inkInstance.unmount();
        }

        // Give Ink a brief moment to release stdin/tty state, then drain any buffered input
        // (e.g. “double space” spam) so it doesn't leak into the next interactive process.
        await cleanupStdinAfterInk({ stdin: process.stdin as any, drainMs: 75 });
        restoreStdinBestEffort({ stdin: process.stdin as any });

        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';
