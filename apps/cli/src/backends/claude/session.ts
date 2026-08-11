import { MessageQueue2 } from "@/agent/runtime/modeMessageQueue";
import type { EnhancedMode } from "./loop";
import { logger } from "@/ui/logger";
import type { JsRuntime } from "./runClaude";
import type { SessionHookData } from "./utils/startHookServer";
import type { ClaudeStatuslineRuntimeReconcileInput } from "./statusline/applyClaudeStatuslineUpdate";
import type { PermissionMode } from "@/api/types";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';
import { configuration } from '@/configuration';
import { ClaudePermissionRpcRouter } from './utils/permissionRpcRouter';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import type { Metadata } from '@/api/types';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { PushNotificationClient } from '@/api/pushNotifications';
import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import type { McpServerConfig } from '@/agent';
import {
    type AccountSettings,
    SessionConnectedServiceAuthCurrentGroupTruthV1Schema,
    type SessionConnectedServiceAuthApplyGenerationRequestV1,
    type SessionConnectedServiceAuthApplyGenerationResponseV1,
} from '@happier-dev/protocol';
import { resolveConfiguredClaudeConfigDir } from './utils/resolveConfiguredClaudeConfigDir';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { resolveSessionCriticalMetadataDrainTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { getProjectPath } from './utils/path';
import { readExplicitClaudeResumeSessionIdFromArgs } from './utils/claudeResumeArgs';
import {
    createClaudeProviderActivityLedger,
} from './providerActivity/createClaudeProviderActivityLedger';
import type { SessionRuntimeActivityContributionHandle } from '@/session/runtimeActivity/types';
import { createClaudeProviderRuntimeActivityAdapter } from './providerActivity/createClaudeProviderRuntimeActivityAdapter';
import {
    isSidechainSessionHook,
    isSidechainSessionHookRuntimeActivityEvent,
    readSessionHookEventName,
} from './utils/sessionHookAttribution';
import { ClaudeConnectedServiceAuthGroupRequestFence } from './connectedServices/claudeConnectedServiceAuthGroupRequestFence';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';

export type SessionFoundInfo = {
    sessionId: string;
    transcriptPath: string | null;
};

type SessionMetadataDaemonReporter = (input: Readonly<{
    sessionId: string;
    metadata: Metadata;
}>) => Promise<void> | void;

function resolveRelativePathInsideDirectory(params: Readonly<{
    parentDir: string;
    childPath: string;
}>): string | null {
    const relativePath = relative(params.parentDir, params.childPath);
    if (!relativePath || isAbsolute(relativePath)) return null;
    const [firstPart] = relativePath.split(/[\\/]/);
    if (firstPart === '..') return null;
    return relativePath;
}

function resolveClaudeProjectIdFromTranscriptPath(params: Readonly<{
    transcriptPath: string | null;
    configDir: string;
}>): string | null {
    if (!params.transcriptPath) return null;
    const projectsDir = join(params.configDir, 'projects');
    const relativePath = resolveRelativePathInsideDirectory({
        parentDir: projectsDir,
        childPath: params.transcriptPath,
    });
    if (!relativePath) return null;
    const [projectId] = relativePath.split(/[\\/]/);
    const trimmedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
    return trimmedProjectId || null;
}

function buildClaudeDirectSessionMetadata(params: Readonly<{
    metadata: Metadata;
    sessionId: string;
    transcriptPath: string | null;
}>): Metadata {
    if (process.env.HAPPIER_TRANSCRIPT_STORAGE !== 'direct') return params.metadata;

    const machineId = typeof params.metadata.machineId === 'string' ? params.metadata.machineId.trim() : '';
    if (!machineId) return params.metadata;

    const configDir = resolveConfiguredClaudeConfigDir({ env: process.env });
    const projectId = resolveClaudeProjectIdFromTranscriptPath({
        transcriptPath: params.transcriptPath,
        configDir,
    });

    return {
        ...params.metadata,
        directSessionV1: {
            v: 1,
            providerId: 'claude',
            machineId,
            remoteSessionId: params.sessionId,
            source: {
                kind: 'claudeConfig',
                configDir,
                ...(projectId ? { projectId } : {}),
            },
            linkedAtMs: Date.now(),
        },
    };
}

function clearClaudeLastAssistantUuid(metadata: Metadata): Metadata {
    if (!Object.prototype.hasOwnProperty.call(metadata, 'claudeLastAssistantUuid')) {
        return metadata;
    }
    const { claudeLastAssistantUuid: _claudeLastAssistantUuid, ...next } = metadata;
    return next;
}

function readPathBasename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function isClaudeNativeTranscriptPath(transcriptPath: string): boolean {
    const configDir = resolveConfiguredClaudeConfigDir({ env: process.env });
    const projectsDir = join(configDir, 'projects');
    const relativePath = resolveRelativePathInsideDirectory({
        parentDir: projectsDir,
        childPath: transcriptPath,
    });
    if (!relativePath) return false;
    const parts = relativePath.split(/[\\/]/).filter(Boolean);
    return parts.length === 2;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null;
}

const CLAUDE_TRANSCRIPT_PROOF_MAX_BYTES = 64 * 1024;

function readFirstFileChunk(path: string): Readonly<{ text: string; truncated: boolean }> | null {
    let fd: number | null = null;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(CLAUDE_TRANSCRIPT_PROOF_MAX_BYTES + 1);
        const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, 0);
        const truncated = bytesRead > CLAUDE_TRANSCRIPT_PROOF_MAX_BYTES;
        const readableBytes = truncated ? CLAUDE_TRANSCRIPT_PROOF_MAX_BYTES : bytesRead;
        return {
            text: buffer.toString('utf8', 0, readableBytes),
            truncated,
        };
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // Best-effort close after a proof read; a close failure should not promote metadata.
            }
        }
    }
}

function readClaudeTranscriptRecordSessionId(record: Record<string, unknown>): string | null {
    if (record.type === 'system' && record.subtype === 'init') {
        return readTrimmedString(record.session_id);
    }

    const sessionId = readTrimmedString(record.sessionId);
    if (!sessionId) return null;

    switch (record.type) {
        case 'last-prompt':
        case 'mode':
        case 'permission-mode':
        case 'system':
        case 'user':
        case 'assistant':
            return sessionId;
        default:
            return null;
    }
}

function readClaudeTranscriptProofSessionId(path: string): string | null {
    const chunk = readFirstFileChunk(path);
    if (!chunk?.text) return null;
    const lines = chunk.text.split(/\r?\n/u);
    if (chunk.truncated && !chunk.text.endsWith('\n') && !chunk.text.endsWith('\r')) {
        lines.pop();
    }
    let proofSessionId: string | null = null;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let record: Record<string, unknown> | null = null;
        try {
            record = readRecord(JSON.parse(line));
        } catch {
            return null;
        }
        if (!record) return null;
        const rowSessionId = readClaudeTranscriptRecordSessionId(record);
        if (!rowSessionId) continue;
        if (proofSessionId && proofSessionId !== rowSessionId) {
            return null;
        }
        proofSessionId = rowSessionId;
    }
    return proofSessionId;
}

function isProvenClaudeTranscriptPath(params: Readonly<{
    sessionId: string;
    transcriptPath: string | null;
}>): boolean {
    const transcriptPath = params.transcriptPath;
    if (!transcriptPath) return false;
    if (readPathBasename(transcriptPath) !== `${params.sessionId}.jsonl`) {
        return false;
    }
    return isClaudeNativeTranscriptPath(transcriptPath)
        && isReachableClaudeTranscriptPath(transcriptPath)
        && readClaudeTranscriptProofSessionId(transcriptPath) === params.sessionId;
}

function isClaudeNativeTranscriptPathCandidate(params: Readonly<{
    sessionId: string;
    transcriptPath: string | null;
}>): boolean {
    const transcriptPath = params.transcriptPath;
    if (!transcriptPath) return false;
    return readPathBasename(transcriptPath) === `${params.sessionId}.jsonl`
        && isClaudeNativeTranscriptPath(transcriptPath);
}

function resolveNativeClaudeTranscriptPathCandidate(params: Readonly<{
    sessionId: string;
    workingDirectory: string;
}>): string {
    return join(getProjectPath(params.workingDirectory), `${params.sessionId}.jsonl`);
}

function resolveProvenNativeClaudeTranscriptPath(params: Readonly<{
    sessionId: string;
    workingDirectory: string;
}>): string | null {
    const transcriptPath = resolveNativeClaudeTranscriptPathCandidate(params);
    return isProvenClaudeTranscriptPath({
        sessionId: params.sessionId,
        transcriptPath,
    })
        ? transcriptPath
        : null;
}

function isReachableClaudeTranscriptPath(transcriptPath: string | null): boolean {
    if (!transcriptPath) return false;
    try {
        return statSync(transcriptPath).isFile();
    } catch {
        return false;
    }
}

function isClaudeDirectSessionMetadata(value: unknown): boolean {
    const record = readRecord(value);
    return record?.providerId === 'claude';
}

function buildClaudeReportedSessionMetadata(params: Readonly<{
    metadata: Metadata;
    sessionId: string;
    transcriptPath: string | null;
    shouldClearAssistantResumeAnchor: boolean;
}>): Metadata {
    const clearedMetadata = params.shouldClearAssistantResumeAnchor
        ? clearClaudeLastAssistantUuid(params.metadata)
        : params.metadata;
    const nextMetadata: Metadata = {
        ...clearedMetadata,
        claudeSessionId: params.sessionId,
    };

    if (params.transcriptPath) {
        return buildClaudeDirectSessionMetadata({
            metadata: {
                ...nextMetadata,
                claudeTranscriptPath: params.transcriptPath,
            },
            sessionId: params.sessionId,
            transcriptPath: params.transcriptPath,
        });
    }

    delete nextMetadata.claudeTranscriptPath;
    if (isClaudeDirectSessionMetadata(nextMetadata.directSessionV1)) {
        delete nextMetadata.directSessionV1;
    }
    return nextMetadata;
}

export class Session {
    readonly connectedServiceAuthGroupRequestFence = new ClaudeConnectedServiceAuthGroupRequestFence();
    private unregisterConnectedServiceAuthGroupRuntimeControl: () => void = () => {};
    readonly path: string;
    readonly logPath: string;
    readonly client: SessionClientPort;
    private readonly providerTaskRuntimeActivityAdapter: ReturnType<typeof createClaudeProviderRuntimeActivityAdapter> | null;
    private readonly providerTaskActivityLedger: ReturnType<typeof createClaudeProviderActivityLedger> | null;
    pushSender: PushNotificationClient | null;
    accountSettings: AccountSettings | null;
    accountSettingsSecretsReadKeys: readonly Uint8Array[];
    readonly queue: MessageQueue2<EnhancedMode>;
    claudeArgs?: string[];  // Made mutable to allow filtering
    readonly _onModeChange: (mode: 'local' | 'remote') => void;
    /** Path to temporary settings file with non-hook config (required for session tracking) */
    readonly hookSettingsPath: string;
    /**
     * Optional plugin-dir path carrying the session's hooks. When present, spawned
     * Claude CLI gets `--plugin-dir <path>` so hooks register via the additive plugin
     * channel (resilient to other wrappers in PATH that inject their own `--settings`).
     */
    readonly hookPluginDir: string | null;
    /**
     * Hook-server coordinates (port + shared secret) for the statusline forwarder wrapper.
     * Consumed by the Unified terminal spawn to merge a forwarding `statusLine` command into
     * the per-spawn `--settings` overlay. Null when unavailable — statusline forwarding is
     * additive enrichment and nothing may block on its absence.
     */
    readonly claudeStatuslineForwarder: Readonly<{ port: number; secret: string }> | null;
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    readonly jsRuntime: JsRuntime;
    /** How this session was started (affects TTY/UI behavior). */
    readonly startedBy: 'daemon' | 'terminal';
    /** Terminal host metadata for this CLI process, when launched by tmux/daemon wrappers. */
    readonly terminalRuntime: TerminalRuntimeFlags | null;
    readonly defaultSystemPromptText: string | undefined;

    sessionId: string | null;
    transcriptPath: string | null = null;
    mode: 'local' | 'remote' = 'local';
    thinking: boolean = false;
    private currentTaskId: string | null = null;
    private permissionRpcRouter: ClaudePermissionRpcRouter | null = null;
    private happierMcpBridge:
        | {
              mcpServers: Record<string, McpServerConfig>;
              mcpConfigJson: string;
              stop: () => void;
          }
        | null = null;
    private happierMcpBridgePromise: Promise<NonNullable<Session['happierMcpBridge']>> | null = null;

    /**
     * Last known permission mode for this session, derived from message metadata / permission responses.
     * Used to carry permission settings across remote ↔ local mode switches.
     */
    lastPermissionMode: PermissionMode = 'default';
    lastPermissionModeUpdatedAt: number = 0;

    /**
     * Claude Code experimental feature toggles derived from provider settings.
     * Applied on the next Claude subprocess spawn (local + remote).
     */
    claudeCodeExperimentalAgentTeamsEnabled: boolean = false;

    /**
     * Timestamp of the most recent user-initiated abort request (UI abort, Ctrl-C exit,
     * or mode-switch abort).
     *
     * Used as a narrow safety valve to avoid treating known "abort" cancellation signals
     * as crashes when they surface as process-level unhandled rejections.
     */
    private lastUserAbortRequestedAtMs: number = 0;
    
    /** Callbacks to be notified when session ID is found/changed */
    private sessionFoundCallbacks: ((info: SessionFoundInfo) => void)[] = [];
    private claudeSessionHookCallbacks: ((data: SessionHookData) => void)[] = [];
    /**
     * Active runtime-control statusline reconciler (lane Y). Registered by the Claude Unified
     * terminal runner while its runtime-control bridge is live; the statusline applier feeds
     * effective model/effort through it into the controller's `lastVerified`. Effective-truth
     * only — the reconciler must never write desired-state surfaces.
     */
    private claudeStatuslineRuntimeReconciler: ((input: ClaudeStatuslineRuntimeReconcileInput) => void) | null = null;
    private readonly criticalMetadataWrites = new Set<Promise<void>>();
    private readonly providerInputConsumers = new Set<SessionProviderInputConsumer<EnhancedMode, string>>();
    private providerInputAdmissionClosed = false;
    private connectedServiceExactApplicationHandler: (() => Promise<void>) | null = null;
    private readonly reportSessionMetadataToDaemon: SessionMetadataDaemonReporter | null;
    
    /** Keep alive interval reference for cleanup */
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private readonly keepAliveIdleMs: number;
    private readonly keepAliveThinkingMs: number;

    constructor(opts: {
        client: SessionClientPort,
        pushSender?: PushNotificationClient | null,
        accountSettings?: AccountSettings | null,
        accountSettingsSecretsReadKeys?: readonly Uint8Array[],
        path: string,
        logPath: string,
        sessionId: string | null,
        claudeArgs?: string[],
        messageQueue: MessageQueue2<EnhancedMode>,
        onModeChange: (mode: 'local' | 'remote') => void,
        /** Path to temporary settings file with non-hook config (required for session tracking) */
        hookSettingsPath: string,
        /** Optional plugin dir carrying hooks; see field docstring above. */
        hookPluginDir?: string | null,
        /** Hook-server coordinates for the statusline forwarder wrapper; see field docstring above. */
        claudeStatuslineForwarder?: Readonly<{ port: number; secret: string }> | null,
        /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
        jsRuntime?: JsRuntime,
        startedBy?: 'daemon' | 'terminal',
        terminalRuntime?: TerminalRuntimeFlags | null,
        defaultSystemPromptText?: string,
        precomputedMcpBridge?: { mcpServers: Record<string, McpServerConfig>; stop: () => void } | null,
        reportSessionMetadataToDaemon?: SessionMetadataDaemonReporter | null,
        runtimeActivityContributions?: Readonly<{
            providerTasks?: SessionRuntimeActivityContributionHandle | null;
            isCurrentRuntime?: () => boolean;
        }>,
    }) {
        this.path = opts.path;
        this.client = opts.client;
        this.unregisterConnectedServiceAuthGroupRuntimeControl = this.client.registerSessionRuntimeControls?.({
            applyConnectedServiceAuthGeneration: this.applyConnectedServiceAuthGeneration,
        }) ?? (() => {});
        const providerTaskContributionHandle = opts.runtimeActivityContributions?.providerTasks ?? null;
        this.providerTaskActivityLedger = providerTaskContributionHandle
            ? createClaudeProviderActivityLedger()
            : null;
        this.providerTaskRuntimeActivityAdapter = providerTaskContributionHandle && this.providerTaskActivityLedger
            ? createClaudeProviderRuntimeActivityAdapter({
                contributionHandle: providerTaskContributionHandle,
                providerActivityLedger: this.providerTaskActivityLedger,
                isCurrentRuntime: opts.runtimeActivityContributions?.isCurrentRuntime,
            })
            : null;
        this.pushSender = opts.pushSender ?? null;
        this.accountSettings = opts.accountSettings ?? null;
        this.accountSettingsSecretsReadKeys = opts.accountSettingsSecretsReadKeys ?? [];
        this.logPath = opts.logPath;
        this.sessionId = opts.sessionId;
        this.queue = opts.messageQueue;
        this.claudeArgs = opts.claudeArgs;
        this.adoptExplicitResumeSessionIdFromArgs();
        this._onModeChange = opts.onModeChange;
        this.hookSettingsPath = opts.hookSettingsPath;
        this.hookPluginDir = opts.hookPluginDir ?? null;
        this.claudeStatuslineForwarder = opts.claudeStatuslineForwarder ?? null;
        this.jsRuntime = opts.jsRuntime ?? 'node';
        this.startedBy = opts.startedBy ?? 'terminal';
        this.terminalRuntime = opts.terminalRuntime ?? null;
        this.defaultSystemPromptText =
            typeof opts.defaultSystemPromptText === 'string' && opts.defaultSystemPromptText.trim().length > 0
                ? opts.defaultSystemPromptText.trim()
                : undefined;
        this.reportSessionMetadataToDaemon = opts.reportSessionMetadataToDaemon ?? null;

        this.keepAliveIdleMs = configuration.sessionKeepAliveIdleMs;
        this.keepAliveThinkingMs = configuration.sessionKeepAliveThinkingMs;

        // Start keep alive
        this.client.keepAlive(this.thinking, this.mode);
        this.scheduleNextKeepAlive();

        if (opts.precomputedMcpBridge) {
            const mcpConfigJson = JSON.stringify({ mcpServers: opts.precomputedMcpBridge.mcpServers });
            const stored = {
                mcpServers: opts.precomputedMcpBridge.mcpServers,
                mcpConfigJson,
                stop: opts.precomputedMcpBridge.stop,
            };
            this.happierMcpBridge = stored;
            this.happierMcpBridgePromise = Promise.resolve(stored);
        }
    }

    noteUserAbortRequested(): void {
        this.lastUserAbortRequestedAtMs = Date.now();
    }

    wasUserAbortRequestedRecently(withinMs: number): boolean {
        const windowMs = Number.isFinite(withinMs) ? Math.max(0, Math.trunc(withinMs)) : 0;
        if (windowMs === 0) return false;
        const last = this.lastUserAbortRequestedAtMs;
        if (last <= 0) return false;
        return Date.now() - last <= windowMs;
    }

    adoptExplicitResumeSessionIdFromArgs = (): void => {
        if (this.sessionId) return;

        const resumeSessionId = readExplicitClaudeResumeSessionIdFromArgs(this.claudeArgs);
        if (!resumeSessionId) return;

        this.sessionId = resumeSessionId;
        logger.debug(`[Session] Adopted provisional Claude resume session ID from args: ${resumeSessionId}`);
    }

    setPushSender(pushSender: PushNotificationClient | null): void {
        this.pushSender = pushSender;
    }

    setAccountSettings(settings: AccountSettings | null): void {
        this.accountSettings = settings;
    }

    registerProviderInputConsumer(consumer: SessionProviderInputConsumer<EnhancedMode, string>): void {
        this.providerInputConsumers.add(consumer);
        if (this.providerInputAdmissionClosed) {
            void consumer.closeProviderInputAdmissionAndWaitForDispatches();
        }
    }

    unregisterProviderInputConsumer(consumer: SessionProviderInputConsumer<EnhancedMode, string>): void {
        this.providerInputConsumers.delete(consumer);
    }

    registerConnectedServiceExactApplicationHandler(handler: () => Promise<void>): () => void {
        this.connectedServiceExactApplicationHandler = handler;
        return () => {
            if (this.connectedServiceExactApplicationHandler === handler) {
                this.connectedServiceExactApplicationHandler = null;
            }
        };
    }

    async closeProviderInputAdmissionAndWaitForDispatches(): Promise<void> {
        this.providerInputAdmissionClosed = true;
        await Promise.all(
            [...this.providerInputConsumers].map((consumer) =>
                consumer.closeProviderInputAdmissionAndWaitForDispatches()),
        );
    }

    private scheduleNextKeepAlive(): void {
        if (this.keepAliveTimer) {
            clearTimeout(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }

        const delay = this.thinking ? this.keepAliveThinkingMs : this.keepAliveIdleMs;
        this.keepAliveTimer = setTimeout(() => {
            this.client.keepAlive(this.thinking, this.mode);
            this.scheduleNextKeepAlive();
        }, delay);
        this.keepAliveTimer.unref?.();
    }
    
    /**
     * Cleanup resources (call when session is no longer needed)
     */
    cleanup = (): void => {
        this.unregisterConnectedServiceAuthGroupRuntimeControl();
        this.unregisterConnectedServiceAuthGroupRuntimeControl = () => {};
        this.connectedServiceExactApplicationHandler = null;
        if (this.keepAliveTimer) {
            clearTimeout(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
        if (this.happierMcpBridge) {
            try {
                this.happierMcpBridge.stop();
            } catch {
                // ignore
            }
            this.happierMcpBridge = null;
            this.happierMcpBridgePromise = null;
        }
        this.sessionFoundCallbacks = [];
        this.permissionRpcRouter = null;
        logger.debug('[Session] Cleaned up resources');
    }

    applyConnectedServiceAuthGeneration = async (
        request: SessionConnectedServiceAuthApplyGenerationRequestV1,
    ): Promise<SessionConnectedServiceAuthApplyGenerationResponseV1> => {
        const truth = SessionConnectedServiceAuthCurrentGroupTruthV1Schema.safeParse(request.authGeneration);
        if (!truth.success) {
            return { ok: false, errorCode: 'invalid_request', error: 'invalid_request' };
        }
        this.connectedServiceAuthGroupRequestFence.applyCurrentTruth(truth.data);
        if (
            request.applicationSettled === true
            && truth.data.kind === 'current_auth_group_available'
            && this.connectedServiceExactApplicationHandler
        ) {
            await this.connectedServiceExactApplicationHandler().catch((error) => {
                logger.debug('[Session] Failed to release Claude provider UI after exact connected-service application (non-fatal)', error);
            });
        }
        return { ok: true, appliedVia: 'current_truth_fence' };
    };

    private trackCriticalMetadataWrite(write: () => Promise<void> | void, reason: string): void {
        let result: Promise<void> | void;
        try {
            result = write();
        } catch (error) {
            logger.debug(`[Session] Failed to update session metadata (${reason}) (non-fatal)`, error);
            return;
        }
        const tracked = Promise.resolve(result).catch((error) => {
            logger.debug(`[Session] Failed to update session metadata (${reason}) (non-fatal)`, error);
        }).finally(() => {
            this.criticalMetadataWrites.delete(tracked);
        });
        this.criticalMetadataWrites.add(tracked);
    }

    async drainCriticalMetadataWrites(opts: Readonly<{ timeoutMs?: number }> = {}): Promise<void> {
        const pending = [...this.criticalMetadataWrites];
        if (pending.length === 0) return;

        const timeoutMs = opts.timeoutMs ?? resolveSessionCriticalMetadataDrainTimeoutMs();
        let timer: NodeJS.Timeout | null = null;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`critical metadata drain timed out after ${timeoutMs}ms`)), timeoutMs);
            timer.unref?.();
        });
        try {
            await Promise.race([
                Promise.allSettled(pending).then(() => undefined),
                timeout,
            ]);
        } catch (error) {
            logger.debug('[Session] Failed to drain critical metadata writes before close (non-fatal)', error);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    publishUnifiedTerminalHostMetadata = async (
        terminal: NonNullable<Metadata['terminal']>,
    ): Promise<void> => {
        let updatedMetadata: Metadata | null = null;
        try {
            await this.client.updateMetadata((metadata) => {
                updatedMetadata = {
                    ...metadata,
                    terminal,
                };
                return updatedMetadata;
            });
            if (updatedMetadata) {
                await this.reportSessionMetadataToDaemon?.({
                    sessionId: this.client.sessionId,
                    metadata: updatedMetadata,
                });
            }
        } catch (error) {
            logger.debug(
                '[Session] Failed to publish Claude Unified terminal host metadata (non-fatal)',
                error,
            );
        }
    };

    async getOrCreateHappierMcpBridge(): Promise<{ mcpServers: Record<string, McpServerConfig>; mcpConfigJson: string }> {
        if (this.happierMcpBridge) {
            return { mcpServers: this.happierMcpBridge.mcpServers, mcpConfigJson: this.happierMcpBridge.mcpConfigJson };
        }

        if (!this.happierMcpBridgePromise) {
            this.happierMcpBridgePromise = (async () => {
                const mcpSession = applyRunnerMcpSessionContext(this.client, {
                    getPermissionMode: () => this.lastPermissionMode,
                    getBackendTarget: () => ({ kind: 'builtInAgent', agentId: 'claude' }),
                    getCurrentSessionLocation: () => {
                        const metadata = this.client.getMetadataSnapshot?.() as Record<string, unknown> | null | undefined;
                        const host = typeof metadata?.host === 'string' && metadata.host.trim()
                            ? metadata.host.trim()
                            : null;
                        const machineId = typeof metadata?.machineId === 'string' && metadata.machineId.trim()
                            ? metadata.machineId.trim()
                            : null;
                        return {
                            path: this.path,
                            host,
                            machineId,
                        };
                    },
                });
                const bridge = await createHappierMcpBridge(mcpSession, {
                    accountSettings: this.accountSettings,
                });
                const mcpConfigJson = JSON.stringify({ mcpServers: bridge.mcpServers });
                const stored = {
                    mcpServers: bridge.mcpServers,
                    mcpConfigJson,
                    stop: bridge.happierMcpServer.stop,
                };
                this.happierMcpBridge = stored;
                return stored;
            })();
        }

        const stored = await this.happierMcpBridgePromise;
        return { mcpServers: stored.mcpServers, mcpConfigJson: stored.mcpConfigJson };
    }

    getOrCreatePermissionRpcRouter(): ClaudePermissionRpcRouter {
        if (!this.permissionRpcRouter) {
            this.permissionRpcRouter = new ClaudePermissionRpcRouter(this.client.rpcHandlerManager);
        }
        return this.permissionRpcRouter;
    }

    setLastPermissionMode = (mode: PermissionMode, updatedAt: number = Date.now()): void => {
        const canonical = normalizePermissionModeToIntent(mode) ?? 'default';
        if (canonical === this.lastPermissionMode) {
            return;
        }
        this.lastPermissionMode = canonical;
        this.lastPermissionModeUpdatedAt = updatedAt;
        updateMetadataBestEffort(
            this.client,
            (metadata) => ({
                ...metadata,
                permissionMode: canonical,
                permissionModeUpdatedAt: updatedAt
            }),
            '[Session]',
            'set_last_permission_mode',
        );
    }

    adoptLastPermissionModeFromMetadata = (mode: PermissionMode, updatedAt: number): boolean => {
        if (!(typeof updatedAt === 'number' && Number.isFinite(updatedAt))) {
            return false;
        }
        if (updatedAt <= this.lastPermissionModeUpdatedAt) {
            return false;
        }

        const canonical = normalizePermissionModeToIntent(mode) ?? 'default';
        if (canonical === this.lastPermissionMode) {
            this.lastPermissionModeUpdatedAt = updatedAt;
            return false;
        }

        this.lastPermissionMode = canonical;
        this.lastPermissionModeUpdatedAt = updatedAt;
        return true;
    }

    private applyThinkingState = (thinking: boolean): boolean => {
        const wasThinking = this.thinking;
        this.thinking = thinking;
        this.client.keepAlive(thinking, this.mode);
        this.scheduleNextKeepAlive();
        return wasThinking !== thinking;
    }

    setThinkingWithoutTaskLifecycle = (thinking: boolean) => {
        this.applyThinkingState(thinking);
    }

    onThinkingChange = (thinking: boolean) => {
        this.applyThinkingState(thinking);

        // The task lifecycle is keyed on `currentTaskId` — NOT on the `thinking` display flag's
        // transition. An optimistic `setThinkingWithoutTaskLifecycle(true)` latch (fired on remote
        // prompt injection) sets `thinking` before the canonical hook-driven onThinkingChange(true),
        // so gating on a thinking-flag change let the latch swallow the task open and the completed
        // turn never emitted `task_complete` (no completed status → no ready/push → no attention).
        // Keying on the task itself collapses that two-writer split-brain to one writer.
        if (thinking) {
            if (this.currentTaskId) {
                return;
            }
            const id = randomUUID();
            this.currentTaskId = id;
            this.client.sendAgentMessage('claude', { type: 'task_started', id });
            return;
        }

        if (!this.currentTaskId) {
            return;
        }

        const id = this.currentTaskId;
        this.currentTaskId = null;
        this.client.sendAgentMessage('claude', { type: 'task_complete', id });
    }

    abortCurrentTaskTurn = () => {
        const id = this.currentTaskId ?? randomUUID();
        this.currentTaskId = null;
        this.thinking = false;
        this.client.keepAlive(false, this.mode);
        this.client.sendAgentMessage('claude', { type: 'turn_aborted', id });
    }

    onModeChange = (mode: 'local' | 'remote') => {
        this.mode = mode;
        this.client.keepAlive(this.thinking, mode);
        this._onModeChange(mode);
    }

    /**
     * Called when Claude session ID is discovered or changed.
     * 
     * This is triggered by the SessionStart hook when:
     * - Claude starts a new session (fresh start)
     * - Claude resumes a session (--continue, --resume flags)
     * - Claude forks a session (/compact, double-escape fork)
     * 
     * Updates internal state, syncs to API metadata, and notifies
     * all registered callbacks (e.g., SessionScanner) about the change.
     */
    onSessionFound = (sessionId: string, hookData?: SessionHookData) => {
        // PLAN 4.9.1 step 2: arm the provider-task identity gate HERE, at the one place this runtime
        // learns its Claude session identity, so the unified terminal, the local launcher and the
        // remote launcher inherit it instead of each remembering to arm the ledger they were handed.
        // A lineage, not a swap - every id this session has passed through stays owned, so a task
        // started before a compact boundary is not foreign to its own ledger afterwards. Placed
        // before the change/early-return checks below so a re-reported id is still declared.
        this.providerTaskActivityLedger?.noteOwnedSessionId(sessionId);

        const nextTranscriptPathRaw = hookData?.transcript_path ?? hookData?.transcriptPath;
        const nextTranscriptPath = typeof nextTranscriptPathRaw === 'string' ? nextTranscriptPathRaw : null;
        const hookTranscriptPathIsNativeCandidate = isClaudeNativeTranscriptPathCandidate({
            sessionId,
            transcriptPath: nextTranscriptPath,
        });
        const nativeTranscriptPathCandidate = hookTranscriptPathIsNativeCandidate
            ? nextTranscriptPath
            : nextTranscriptPath
                ? null
                : resolveNativeClaudeTranscriptPathCandidate({
                    sessionId,
                    workingDirectory: this.path,
                });
        const hookTranscriptPathIsProven = isProvenClaudeTranscriptPath({
            sessionId,
            transcriptPath: nextTranscriptPath,
        });
        const resumableTranscriptPath = hookTranscriptPathIsProven
            ? nextTranscriptPath
            : resolveProvenNativeClaudeTranscriptPath({
                sessionId,
                workingDirectory: this.path,
            });
        const metadataTranscriptPath = resumableTranscriptPath;
        const observedTranscriptPath = resumableTranscriptPath ?? nextTranscriptPath ?? nativeTranscriptPathCandidate;

        const prevSessionId = this.sessionId;
        const prevTranscriptPath = this.transcriptPath;
        const didSessionIdChange = prevSessionId !== sessionId;

        this.sessionId = sessionId;
        if (didSessionIdChange) {
            // Avoid carrying a transcript path across different Claude sessions.
            // If the hook didn't provide a transcript path for this session, force fallback to heuristics.
            this.transcriptPath = observedTranscriptPath;
        } else if (observedTranscriptPath) {
            // Same sessionId, but we learned/updated the exact transcript path.
            this.transcriptPath = observedTranscriptPath;
        }
        const didKnownTranscriptPathChange =
            !didSessionIdChange
            && typeof prevTranscriptPath === 'string'
            && typeof metadataTranscriptPath === 'string'
            && prevTranscriptPath !== metadataTranscriptPath;

        // Update metadata with the Claude-reported session ID immediately. Transcript
        // proof only decides whether the path/direct-session source is resumable yet.
        if (didSessionIdChange) {
            this.trackCriticalMetadataWrite(
                async () => {
                    let updatedMetadata: Metadata | null = null;
                    await this.client.updateMetadata((metadata) => {
                        updatedMetadata = buildClaudeReportedSessionMetadata({
                            metadata,
                            sessionId,
                            transcriptPath: metadataTranscriptPath,
                            shouldClearAssistantResumeAnchor: true,
                        });
                        return updatedMetadata;
                    });
                    if (updatedMetadata) {
                        await this.reportSessionMetadataToDaemon?.({
                            sessionId: this.client.sessionId,
                            metadata: updatedMetadata,
                        });
                    }
                },
                'claude_session_found',
            );
            logger.debug(`[Session] Claude Code session ID ${sessionId} added to metadata`);

        } else if (resumableTranscriptPath || didKnownTranscriptPathChange) {
            // Same session, but we learned a more precise transcript path from hooks.
            this.trackCriticalMetadataWrite(
                async () => {
                    let updatedMetadata: Metadata | null = null;
                    await this.client.updateMetadata((metadata) => {
                        updatedMetadata = buildClaudeReportedSessionMetadata({
                            metadata,
                            sessionId,
                            transcriptPath: metadataTranscriptPath,
                            shouldClearAssistantResumeAnchor: didKnownTranscriptPathChange,
                        });
                        return updatedMetadata;
                    });
                    if (updatedMetadata) {
                        await this.reportSessionMetadataToDaemon?.({
                            sessionId: this.client.sessionId,
                            metadata: updatedMetadata,
                        });
                    }
                },
                'claude_transcript_path_found',
            );
        } else if (observedTranscriptPath) {
            logger.debug(`[Session] Claude Code transcript path for session ID ${sessionId} observed but not promoted to metadata because it is not proven resumable`);
        }

        // Notify callbacks when either the sessionId changes or we learned a better transcript path.
        const didTranscriptPathChange = Boolean(observedTranscriptPath) && observedTranscriptPath !== prevTranscriptPath;
        if (prevSessionId === sessionId && !didTranscriptPathChange) {
            return;
        }

        const info: SessionFoundInfo = {
            sessionId,
            transcriptPath: this.transcriptPath
        };
        
        // Notify all registered callbacks
        for (const callback of this.sessionFoundCallbacks) {
            callback(info);
        }
    }

    onClaudeSessionHook = (data: SessionHookData): void => {
        for (const callback of this.claudeSessionHookCallbacks) {
            callback(data);
        }
    }

    getProviderTaskRuntimeActivityAdapter(): ReturnType<typeof createClaudeProviderRuntimeActivityAdapter> | null {
        return this.providerTaskRuntimeActivityAdapter;
    }

    getProviderTaskActivityLedger(): ReturnType<typeof createClaudeProviderActivityLedger> | null {
        return this.providerTaskActivityLedger;
    }

    /**
     * Register a callback to be notified when session ID is found/changed
     */
    addSessionFoundCallback = (callback: (info: SessionFoundInfo) => void): void => {
        this.sessionFoundCallbacks.push(callback);
    }
    
    /**
     * Remove a session found callback
     */
    removeSessionFoundCallback = (callback: (info: SessionFoundInfo) => void): void => {
        const index = this.sessionFoundCallbacks.indexOf(callback);
        if (index !== -1) {
            this.sessionFoundCallbacks.splice(index, 1);
        }
    }

    addClaudeSessionHookCallback = (callback: (data: SessionHookData) => void): void => {
        this.claudeSessionHookCallbacks.push(callback);
    }

    removeClaudeSessionHookCallback = (callback: (data: SessionHookData) => void): void => {
        const index = this.claudeSessionHookCallbacks.indexOf(callback);
        if (index !== -1) {
            this.claudeSessionHookCallbacks.splice(index, 1);
        }
    }

    /**
     * Register the live statusline → runtime-control reconciler. Returns an unregister function
     * that only clears its own registration (a stale unregister never clobbers a newer one).
     */
    setClaudeStatuslineRuntimeReconciler = (
        reconcile: (input: ClaudeStatuslineRuntimeReconcileInput) => void,
    ): (() => void) => {
        this.claudeStatuslineRuntimeReconciler = reconcile;
        return () => {
            if (this.claudeStatuslineRuntimeReconciler === reconcile) {
                this.claudeStatuslineRuntimeReconciler = null;
            }
        };
    }

    /** Forward statusline-reported effective model/effort to the registered reconciler, if any. */
    reconcileClaudeRuntimeFromStatusline = (input: ClaudeStatuslineRuntimeReconcileInput): void => {
        this.claudeStatuslineRuntimeReconciler?.(input);
    }

    /**
     * Wait until we have a sessionId (and optionally a transcriptPath) from Claude hooks.
     * Used to avoid switching modes before the session is actually initialized on disk.
     */
    waitForSessionFound = async (opts: { timeoutMs?: number; requireTranscriptPath?: boolean } = {}): Promise<SessionFoundInfo | null> => {
        const timeoutMs = opts.timeoutMs ?? 2000;
        const requireTranscriptPath = opts.requireTranscriptPath ?? false;

        const isReady = (): boolean => {
            if (!this.sessionId) return false;
            if (requireTranscriptPath && !this.transcriptPath) return false;
            return true;
        };

        if (isReady()) {
            return { sessionId: this.sessionId!, transcriptPath: this.transcriptPath };
        }

        return new Promise((resolve) => {
            const onUpdate = () => {
                if (!isReady()) return;
                cleanup();
                resolve({ sessionId: this.sessionId!, transcriptPath: this.transcriptPath });
            };

            const cleanup = () => {
                clearTimeout(timeoutId);
                this.removeSessionFoundCallback(onUpdate);
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                if (this.sessionId) {
                    resolve({ sessionId: this.sessionId, transcriptPath: this.transcriptPath });
                } else {
                    resolve(null);
                }
            }, timeoutMs);

            this.addSessionFoundCallback(onUpdate);
        });
    }

    /**
     * Clear the current session ID (used by /clear command)
     */
    clearSessionId = (): void => {
        this.sessionId = null;
        this.transcriptPath = null;
        updateMetadataBestEffort(
            this.client,
            clearClaudeLastAssistantUuid,
            '[Session]',
            'claude_session_cleared',
        );
        logger.debug('[Session] Session ID cleared');
    }

    /**
     * Consume one-time Claude flags from claudeArgs after Claude spawn
     * Handles: --resume (with or without session ID), --continue
     */
    consumeOneTimeFlags = (): void => {
        if (!this.claudeArgs) return;
        
        const filteredArgs: string[] = [];
        for (let i = 0; i < this.claudeArgs.length; i++) {
            const arg = this.claudeArgs[i];
            
            if (arg === '--continue' || arg === '-c') {
                logger.debug('[Session] Consumed --continue flag');
                continue;
            }

            if (arg === '--session-id') {
                if (i + 1 < this.claudeArgs.length) {
                    const nextArg = this.claudeArgs[i + 1];
                    if (!nextArg.startsWith('-')) {
                        i++; // Skip the value
                        logger.debug(`[Session] Consumed --session-id flag with value: ${nextArg}`);
                    } else {
                        logger.debug('[Session] Consumed --session-id flag (missing value)');
                    }
                } else {
                    logger.debug('[Session] Consumed --session-id flag (missing value)');
                }
                continue;
            }
            
            if (arg === '--resume' || arg === '-r') {
                const nextArg = i + 1 < this.claudeArgs.length ? this.claudeArgs[i + 1] : undefined;
                if (nextArg && !nextArg.startsWith('-')) {
                    i++; // Skip the value
                    logger.debug(`[Session] Consumed ${arg} flag with session ID: ${nextArg}`);
                } else {
                    logger.debug(`[Session] Consumed ${arg} flag (no session ID)`);
                }
                continue;
            }
            
            filteredArgs.push(arg);
        }
        
        this.claudeArgs = filteredArgs.length > 0 ? filteredArgs : undefined;
        logger.debug(`[Session] Consumed one-time flags, remaining args:`, this.claudeArgs);
    }
}
