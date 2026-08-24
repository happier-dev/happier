import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines } from "../types";
import { parseClaudeTaskNotificationXml } from '../taskNotifications/claudeTaskNotificationXml';
import { dirname, join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { getProjectPath } from "./path";
import { ClaudeRemoteSubagentFileCollector } from '../remote/sidechains/claudeRemoteSubagentFileCollector';
import { resolveClaudeSubagentJsonlPath } from '../remote/sidechains/resolveClaudeSubagentJsonlPath';
import { normalizeClaudeToolUseNamesInRawJsonLines } from './normalizeClaudeToolUseNames';
import { createClaudeTeamInboxCollector } from './teamInbox/claudeTeamInboxCollector';
import { readClaudeSessionJsonlMessages } from './readClaudeSessionJsonlMessages';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import { buildClaudeJsonlMessageKey } from './claudeJsonlMessageKey';
import { createJsonlFollowController, type JsonlFollowController } from '@/agent/localControl/jsonlFollowController';
import type { JsonlFollowerMetricEvent } from '@/agent/localControl/jsonlFollowMetrics';
import { INTERNAL_CLAUDE_EVENT_TYPES } from './internalClaudeEventTypes';
import { parseRawJsonLinesObject } from './parseRawJsonLines';
import { isClaudeInternalTranscriptMessage } from './isClaudeInternalTranscriptMessage';
import {
    createClaudeJsonlResetReplaySuppressor,
    isClaudeJsonlReplaySuppressedValue,
    type ClaudeJsonlResetReplaySuppressor,
} from './claudeJsonlReplaySuppression';

export type SessionScannerSessionInfo = {
    sessionId: string;
    transcriptPath?: string | null;
};

type SessionScannerUnhookedSessionDisposition = 'ignore' | 'diagnostic' | 'main';

const DISCOVERY_WATCH_FALLBACK_INTERVAL_MS = 30_000;
const ACTIVE_SESSION_FALLBACK_INTERVAL_MS = 3_000;

export async function createSessionScanner(opts: {
    sessionId: string | null,
    /**
     * Optional absolute transcript file path for the initial sessionId (from Claude's SessionStart hook).
     * When provided, it is used instead of the `getProjectPath()` heuristic.
     */
    transcriptPath?: string | null,
    /**
     * Optional Claude config dir override (e.g., when the child process runs with CLAUDE_CONFIG_DIR set).
     * Used only for the heuristic project-dir fallback when transcriptPath is not available.
     */
    claudeConfigDir?: string | null,
    workingDirectory: string
    onMessage: (
        message: RawJSONLines,
        observation?: Readonly<{ historicalReplay: boolean }>,
    ) => unknown
    onRawJsonlValue?: ((
        value: unknown,
        observation: Readonly<{ historicalReplay: boolean }>,
    ) => void) | undefined
    onLiveJsonlValue?: ((input: Readonly<{ sessionId: string; value: unknown }>) => void) | undefined
    onLiveJsonlObservationLost?: ((input: Readonly<{ sessionId: string; reason: string }>) => void) | undefined
    onTranscriptMissing?: (info: { sessionId: string; filePath: string }) => void
    /** How long to wait (ms) before warning that the transcript file is missing. Set <= 0 to disable. */
    transcriptMissingWarningMs?: number
    /**
     * Claude JSONL message keys already present in Happier's transcript. Used when
     * replaying resume history to backfill only rows that were missed while the runner was down.
     */
    initialProcessedMessageKeys?: Iterable<string>
    /** Replay initial transcript rows instead of treating the whole file as already processed. */
    replayInitialMessages?: boolean
    /**
     * Replay-coverage cutoff (Lane N4): one-time session SNAPSHOT rows older than this timestamp
     * (or without a parseable timestamp) are marked processed without being emitted — they
     * predate the committed-keys baseline coverage and cannot be proven uncommitted. Live
     * follower rows are never filtered. `Infinity` suppresses the snapshot replay entirely
     * (fail-closed when no baseline could be loaded).
     */
    replaySuppressRowsBeforeMs?: number | null
    /**
     * Discover fresh Claude JSONL sessions in the project directory before hooks
     * announce a SessionStart. This covers early Claude failures that write JSONL
     * but never invoke lifecycle hooks.
     */
    discoverNewSessions?: boolean
    /**
     * Bind this scanner to the first main Claude session it observes and ignore
     * later unrelated JSONL sessions in the same project directory. Terminal-hosted
     * unified sessions use this because each Happier session owns exactly one
     * Claude TUI/native transcript; local resume keeps the legacy multi-session path.
     */
    bindToFirstSession?: boolean
    /**
     * Whether sessions discovered before an explicit onNewSession call should
     * become the bound main session. Unified hook-driven startup keeps early
     * API-error discovery diagnostic until the trusted SessionStart hook arrives.
     */
    bindDiscoveredSessions?: boolean
    classifyDiscoveredSession?: ((params: {
        sessionId: string;
        filePath: string;
        messages: readonly RawJSONLines[];
    }) => SessionScannerUnhookedSessionDisposition | null | undefined) | undefined
    onDiscoveredMainSession?: ((params: {
        sessionId: string;
        filePath: string;
    }) => void) | undefined
}) {
    const shapeLogger = createEventShapeLoggerForLog({ logger, scope: 'claude-jsonl' });

    // Best-effort project directory resolution (fallback).
    // When available, we prefer the Claude hook's transcriptPath-derived directory instead.
    const initialProjectDir = getProjectPath(opts.workingDirectory, opts.claudeConfigDir ?? null);
    let projectDirOverride: string | null = null;
    const sessionFileOverrides = new Map<string, string>();

    const transcriptMissingWarningMs = opts.transcriptMissingWarningMs ?? 5000;
    const warnedMissingTranscripts = new Set<string>();
    const missingTranscriptTimers = new Map<string, NodeJS.Timeout>();

    function effectiveProjectDir(): string {
        return projectDirOverride ?? initialProjectDir;
    }

    function getSessionFilePath(sessionId: string): string {
        const override = sessionFileOverrides.get(sessionId);
        return override ?? join(effectiveProjectDir(), `${sessionId}.jsonl`);
    }

    function scheduleTranscriptMissingWarning(sessionId: string): void {
        if (!opts.onTranscriptMissing) return;
        if (!Number.isFinite(transcriptMissingWarningMs) || transcriptMissingWarningMs <= 0) return;
        if (warnedMissingTranscripts.has(sessionId)) return;
        if (missingTranscriptTimers.has(sessionId)) return;

        const timeoutId = setTimeout(async () => {
            missingTranscriptTimers.delete(sessionId);
            if (warnedMissingTranscripts.has(sessionId)) return;

            const filePath = getSessionFilePath(sessionId);
            try {
                await readFile(filePath, 'utf-8');
                return;
            } catch {
                // still missing (or unreadable)
            }

            warnedMissingTranscripts.add(sessionId);
            try {
                opts.onTranscriptMissing?.({ sessionId, filePath });
            } catch (err) {
                logger.debug('[SESSION_SCANNER] onTranscriptMissing callback threw:', err);
            }
        }, transcriptMissingWarningMs);

        missingTranscriptTimers.set(sessionId, timeoutId);
    }

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let sessionFollowers = new Map<string, { filePath: string; controller: JsonlFollowController }>();
    let projectDirWatcher: FSWatcher | null = null;
    let watchedProjectDir: string | null = null;
    let processedMessageKeys = new Set<string>(opts.initialProcessedMessageKeys ?? []);
    const taskToolUseIdByAgentId = new Map<string, string>();
    let invalidate: (() => void) | null = null;
    const discoveredSessions = new Set<string>();
    const resetReplaySuppressorBySession = new Map<string, ClaudeJsonlResetReplaySuppressor>();
    /** Session JSONLs that already existed at scanner start — never discoverable (see pid-14419 guard). */
    const sessionDiscoveryBaselines = new Set<string>();
    let boundSessionId: string | null = opts.bindToFirstSession && opts.sessionId ? opts.sessionId : null;
    const trustedRawTranscriptSessionIds = new Set<string>();
    if (opts.sessionId) trustedRawTranscriptSessionIds.add(opts.sessionId);
    let closed = false;

    function observeRawJsonlValue(
        value: unknown,
        observation: Readonly<{ historicalReplay: boolean }>,
    ): void {
        if (!opts.onRawJsonlValue) return;
        try {
            opts.onRawJsonlValue(value, observation);
        } catch (err) {
            logger.debug('[SESSION_SCANNER] onRawJsonlValue callback threw:', err);
        }
    }

    function observeLiveJsonlValue(sessionId: string, value: unknown): void {
        if (!opts.onLiveJsonlValue) return;
        try {
            opts.onLiveJsonlValue({ sessionId, value });
        } catch (err) {
            logger.debug('[SESSION_SCANNER] onLiveJsonlValue callback threw:', err);
        }
    }

    function observeLiveJsonlObservationLost(sessionId: string, reason: string): void {
        if (!opts.onLiveJsonlObservationLost) return;
        try {
            opts.onLiveJsonlObservationLost({ sessionId, reason });
        } catch (err) {
            logger.debug('[SESSION_SCANNER] onLiveJsonlObservationLost callback threw:', err);
        }
    }

    function trustRawTranscriptSession(sessionId: string): void {
        trustedRawTranscriptSessionIds.add(sessionId);
    }

    function observeRawJsonlValueForTrustedSession(
        sessionId: string,
        value: unknown,
        observation: Readonly<{ historicalReplay: boolean }>,
    ): void {
        if (!trustedRawTranscriptSessionIds.has(sessionId)) return;
        observeRawJsonlValue(value, observation);
    }

    function shouldSuppressReplaySideEffects(
        value: unknown,
        replayOpts?: Readonly<{ suppressBeforeMs?: number | null; suppressSideEffects?: boolean | undefined }>,
    ): boolean {
        return replayOpts?.suppressSideEffects === true
            && isClaudeJsonlReplaySuppressedValue(value, replayOpts.suppressBeforeMs);
    }

    function observeReplayableRawJsonlValueForTrustedSession(
        sessionId: string,
        value: unknown,
        replayOpts?: Readonly<{ suppressBeforeMs?: number | null; suppressSideEffects?: boolean | undefined }>,
    ): void {
        if (shouldSuppressReplaySideEffects(value, replayOpts)) return;
        observeRawJsonlValueForTrustedSession(sessionId, value, { historicalReplay: true });
    }

    function isMainSessionAllowed(sessionId: string): boolean {
        return !boundSessionId || boundSessionId === sessionId;
    }

    function bindMainSession(sessionId: string): void {
        if (!opts.bindToFirstSession || boundSessionId) return;
        boundSessionId = sessionId;
    }

    function rebindMainSession(sessionId: string): void {
        if (!opts.bindToFirstSession) return;
        boundSessionId = sessionId;
    }

    function cleanupUnallowedSessionFollowers(): void {
        if (!boundSessionId) return;
        for (const [sessionId, follower] of sessionFollowers) {
            if (isMainSessionAllowed(sessionId)) continue;
            void follower.controller.stop();
            sessionFollowers.delete(sessionId);
            pendingSessions.delete(sessionId);
            finishedSessions.delete(sessionId);
            discoveredSessions.delete(sessionId);
        }
    }

    async function discoverNewSessionIds(): Promise<string[]> {
        if (!opts.discoverNewSessions) return [];
        const projectDir = effectiveProjectDir();
        let entries: string[];
        try {
            entries = await readdir(projectDir);
        } catch {
            return [];
        }

        const sessionIds: string[] = [];
        for (const entry of entries) {
            const sessionId = readClaudeSessionJsonlEntrySessionId(entry);
            if (!sessionId) continue;
            if (discoveredSessions.has(sessionId) || pendingSessions.has(sessionId) || finishedSessions.has(sessionId)) continue;
            if (currentSessionId === sessionId || sessionFollowers.has(sessionId)) continue;
            if (!isMainSessionAllowed(sessionId)) continue;
            const filePath = join(projectDir, entry);
            // Cross-session contamination guard (incident pid-14419): the project dir can be
            // SHARED across config roots/profiles (projects symlinked to ~/.claude/projects), so a
            // pre-existing JSONL that grows is by definition another live session writing — never a
            // fresh spawn of THIS runner. Only files created after scanner start are discoverable.
            if (sessionDiscoveryBaselines.has(sessionId)) continue;
            try {
                await stat(filePath);
            } catch {
                continue;
            }
            const messages = await readClaudeSessionJsonlMessages({
                sessionFilePath: filePath,
                logLabel: 'SESSION_SCANNER',
            });
            const disposition = resolveUnhookedSessionDisposition({
                bindDiscoveredSessions: opts.bindDiscoveredSessions,
                classifyDiscoveredSession: opts.classifyDiscoveredSession,
                filePath,
                messages,
                sessionId,
            });
            if (disposition === 'ignore') continue;
            if (disposition === 'diagnostic') {
                for (const message of messages) {
                    await processSessionMessage(
                        normalizeClaudeToolUseNamesInRawJsonLines(message),
                        { suppressSideEffects: true },
                    );
                }
                discoveredSessions.add(sessionId);
                continue;
            }
            if (disposition === 'main') {
                bindMainSession(sessionId);
                // The classifier is caller-provided and may synchronously observe a
                // trusted SessionStart. Promote only if this candidate actually won
                // the scanner binding after classification completes.
                if (!isMainSessionAllowed(sessionId)) continue;
                trustRawTranscriptSession(sessionId);
                opts.onDiscoveredMainSession?.({ filePath, sessionId });
            }
            discoveredSessions.add(sessionId);
            sessionIds.push(sessionId);
        }
        return sessionIds;
    }

    const subagentCollector = new ClaudeRemoteSubagentFileCollector({
        emitImported: (body) => {
            // Best-effort: avoid double-emitting imported sidechain messages within the same scanner lifetime.
            try {
                const key = messageKey(body);
                if (processedMessageKeys.has(key)) return;
                processedMessageKeys.add(key);
            } catch {
                // If we can't key it (unexpected type), still emit; downstream should dedupe by uuid.
            }
            try {
                shapeLogger.log('emit:sidechain-import', body);
                opts.onMessage(body);
            } catch (err) {
                logger.debug('[SESSION_SCANNER] onMessage callback threw (sidechain import):', err);
            }
        },
        resolveJsonlPathForAgentId: ({ agentId, sidechainId, claudeSessionId }) => {
            if (!claudeSessionId) return null;
            const sanitized = String(agentId ?? '').trim();
            return resolveClaudeSubagentJsonlPath({
                projectDir: effectiveProjectDir(),
                claudeSessionId,
                agentId: sanitized,
                sidechainId,
            });
        },
    });

    const teamInboxCollector = createClaudeTeamInboxCollector({
        claudeConfigDir: typeof opts.claudeConfigDir === 'string' && opts.claudeConfigDir.trim().length > 0 ? opts.claudeConfigDir.trim() : null,
        onInvalidate: () => invalidate?.(),
        emit: (body) => {
            try {
                const uuid = typeof (body as any)?.uuid === 'string' ? String((body as any).uuid) : '';
                const sidechainId = typeof (body as any)?.sidechainId === 'string' ? String((body as any).sidechainId) : '';
                const key = uuid && sidechainId ? `team-inbox:${sidechainId}:${uuid}` : messageKey(body);
                if (processedMessageKeys.has(key)) return;
                processedMessageKeys.add(key);
            } catch {
                // ignore
            }
            try {
                shapeLogger.log('emit:team-inbox', body);
                opts.onMessage(body);
            } catch (err) {
                logger.debug('[SESSION_SCANNER] onMessage callback threw (team inbox):', err);
            }
        },
    });

    function isTaskNotificationUserText(message: RawJSONLines): boolean {
        if (message.type !== 'user') return false;
        if ((message as any).isSidechain === true) return false;
        const content = (message as any)?.message?.content;
        if (typeof content !== 'string') return false;
        return /^\s*<task-notification>/i.test(content);
    }

    function extractTaskNotification(payload: string): Readonly<{
        taskId: string;
        toolUseId: string | null;
        status: string | null;
        result: string;
    }> | null {
        const parsed = parseClaudeTaskNotificationXml(payload);
        if (!parsed?.taskId || !parsed.result) return null;
        return {
            taskId: parsed.taskId,
            toolUseId: parsed.toolUseId,
            status: parsed.status,
            result: parsed.result,
        };
    }

    function observeTaskToolResultMapping(message: RawJSONLines): void {
        if (message.type !== 'user') return;
        const toolUseResult = (message as any).toolUseResult;
        if (!toolUseResult || typeof toolUseResult !== 'object') return;
        const agentId =
            typeof (toolUseResult as any).agentId === 'string' ? String((toolUseResult as any).agentId).trim() : '';
        if (!agentId) return;

        const content = (message as any)?.message?.content;
        if (!Array.isArray(content)) return;
        for (const item of content) {
            if (!item || typeof item !== 'object') continue;
            if ((item as any).type !== 'tool_result') continue;
            const toolUseId = readNonBlankOpaqueIdentifier((item as any).tool_use_id) ?? '';
            if (!toolUseId) continue;
            taskToolUseIdByAgentId.set(agentId, toolUseId);
        }
    }

    type TaskNotificationAction = { type: 'rewrite'; message: RawJSONLines } | { type: 'drop' };

    function rewriteTaskNotificationToToolResult(message: RawJSONLines): TaskNotificationAction | null {
        if (!isTaskNotificationUserText(message)) return null;
        const content = String((message as any).message.content ?? '');
        const parsed = extractTaskNotification(content);
        if (!parsed) return { type: 'drop' };

        const toolUseId = parsed.toolUseId ?? taskToolUseIdByAgentId.get(parsed.taskId) ?? null;
        if (!toolUseId) {
            // If we can't map the task-id to a Task tool_use, drop it to avoid transcript spam.
            return { type: 'drop' };
        }

        return { type: 'rewrite', message: {
            ...(message as any),
            isMeta: true,
            origin: {
                ...((message as any).origin && typeof (message as any).origin === 'object'
                    ? (message as any).origin
                    : {}),
                kind: 'task-notification',
                taskId: parsed.taskId,
                toolUseId,
                ...(parsed.status ? { status: parsed.status } : {}),
            },
            type: 'user',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: toolUseId,
                        content: [{ type: 'text', text: parsed.result }],
                        is_error: false,
                    },
                ],
            },
        } as any };
    }

    // If the caller already knows the transcript path for the initial session,
    // apply it before reading any existing messages so we mark the correct history as processed.
    if (opts.sessionId && typeof opts.transcriptPath === 'string' && opts.transcriptPath.trim()) {
        const transcriptPath = opts.transcriptPath.trim();
        sessionFileOverrides.set(opts.sessionId, transcriptPath);
        projectDirOverride = dirname(transcriptPath);
    }

    // Mark existing messages as processed and start watching the initial session
    if (opts.sessionId) {
        const initialReplayOpts = {
            suppressBeforeMs: opts.replaySuppressRowsBeforeMs ?? null,
            suppressSideEffects: true,
        };
        let messages = await readClaudeSessionJsonlMessages({
            sessionFilePath: getSessionFilePath(opts.sessionId),
            logLabel: 'SESSION_SCANNER',
            onJsonValue: (value) => observeReplayableRawJsonlValueForTrustedSession(
                opts.sessionId!,
                value,
                initialReplayOpts,
            ),
        });
        logger.debug(`[SESSION_SCANNER] Marking ${messages.length} existing messages as processed from session ${opts.sessionId}`);
        for (let m of messages) {
            // Observe history for sidechain import + task-notification mapping, even when we do not replay history.
            try {
                observeTaskToolResultMapping(m);
                subagentCollector.observe(m as any);
                teamInboxCollector.observe(m as any);
            } catch (err) {
                logger.debug('[SESSION_SCANNER] Failed observing historical message:', err);
            }
            if (!opts.replayInitialMessages) {
                processedMessageKeys.add(messageKey(m));
            }
        }
        // Backfill sidechain messages for any already-launched tasks.
        await subagentCollector.syncAll();
        await teamInboxCollector.syncAll();
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
        scheduleTranscriptMissingWarning(opts.sessionId);
    }

    if (opts.discoverNewSessions) {
        try {
            const entries = await readdir(initialProjectDir);
            for (const entry of entries) {
                const sessionId = readClaudeSessionJsonlEntrySessionId(entry);
                if (!sessionId) continue;
                sessionDiscoveryBaselines.add(sessionId);
            }
        } catch {
            // Missing or unreadable project directories are handled by later discovery attempts.
        }
    }

    function parseClaudeJsonlValue(value: unknown): RawJSONLines | null {
        const type = typeof (value as any)?.type === 'string' ? String((value as any).type) : '';
        if (type && INTERNAL_CLAUDE_EVENT_TYPES.has(type)) return null;
        const parsed = parseRawJsonLinesObject(value);
        return parsed ? normalizeClaudeToolUseNamesInRawJsonLines(parsed) : null;
    }

    function isReplaySuppressedRow(file: RawJSONLines, suppressBeforeMs: number | null | undefined): boolean {
        return isClaudeJsonlReplaySuppressedValue(file, suppressBeforeMs);
    }

    function isForeignBoundSessionRow(file: RawJSONLines): boolean {
        if (!opts.bindToFirstSession || !boundSessionId) return false;
        const rawSessionId = (file as Record<string, unknown>).sessionId;
        const rowSessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
        return rowSessionId.length > 0 && rowSessionId !== boundSessionId;
    }

    async function processSessionMessage(
        file: RawJSONLines,
        replayOpts?: Readonly<{ suppressBeforeMs?: number | null; suppressSideEffects?: boolean | undefined }>,
    ): Promise<boolean> {
        // Hard per-row provider-session filter (incident pid-14419): once this scanner is bound
        // to a Claude session, rows belonging to ANY other session must be structurally impossible
        // to import or observe (no transcript emit, no sidechain/team-inbox collection).
        if (isForeignBoundSessionRow(file)) {
            return false;
        }
        if (replayOpts?.suppressSideEffects === true && isReplaySuppressedRow(file, replayOpts.suppressBeforeMs)) {
            return false;
        }
        try {
            observeTaskToolResultMapping(file);
            subagentCollector.observe(file as any);
            teamInboxCollector.observe(file as any);
        } catch (err) {
            logger.debug('[SESSION_SCANNER] Failed observing message:', err);
        }
        if (isClaudeInternalTranscriptMessage(file)) {
            return false;
        }
        const key = messageKey(file);
        if (processedMessageKeys.has(key)) {
            return false;
        }
        processedMessageKeys.add(key);
        if (isFilteredSystemMessage(file)) {
            return false;
        }
        if (isReplaySuppressedRow(file, replayOpts?.suppressBeforeMs)) {
            return false;
        }
        logger.debug(`[SESSION_SCANNER] Sending new message: type=${file.type}, uuid=${file.type === 'summary' ? file.leafUuid : file.uuid}`);
        try {
            const action = rewriteTaskNotificationToToolResult(file);
            if (action?.type === 'drop') {
                return false;
            }
            if (action?.type === 'rewrite') {
                shapeLogger.log('emit:rewritten-task-notification', action.message);
                await opts.onMessage(action.message, { historicalReplay: replayOpts?.suppressSideEffects === true });
            } else {
                shapeLogger.log(`emit:${String((file as any)?.type ?? 'unknown')}`, file);
                await opts.onMessage(file, { historicalReplay: replayOpts?.suppressSideEffects === true });
            }
            return true;
        } catch (err) {
            if (replayOpts?.suppressSideEffects === true) {
                processedMessageKeys.delete(key);
                throw err;
            }
            logger.debug('[SESSION_SCANNER] onMessage callback threw:', err);
            return false;
        }
    }

    async function processSessionJsonValue(
        session: string,
        value: unknown,
        replayOpts?: Readonly<{ suppressBeforeMs?: number | null; suppressSideEffects?: boolean | undefined }>,
    ): Promise<boolean> {
        if (!isMainSessionAllowed(session)) return false;
        if (shouldSuppressReplaySideEffects(value, replayOpts)) {
            return false;
        }
        observeRawJsonlValueForTrustedSession(session, value, { historicalReplay: false });
        const parsed = parseClaudeJsonlValue(value);
        if (!parsed) return false;
        return await processSessionMessage(parsed, replayOpts);
    }

    async function readSnapshotStartOffsetBytes(session: string): Promise<number> {
        try {
            return (await stat(getSessionFilePath(session))).size;
        } catch {
            return 0;
        }
    }

    async function processSessionSnapshot(session: string): Promise<number> {
        const startOffsetBytes = await readSnapshotStartOffsetBytes(session);
        const replayOpts = {
            suppressBeforeMs: opts.replaySuppressRowsBeforeMs ?? null,
            suppressSideEffects: true,
        };
        const sessionMessages = await readClaudeSessionJsonlMessages({
            sessionFilePath: getSessionFilePath(session),
            logLabel: 'SESSION_SCANNER',
            onJsonValue: (value) => observeReplayableRawJsonlValueForTrustedSession(
                session,
                value,
                replayOpts,
            ),
        });
        if (closed) return startOffsetBytes;
        let skipped = 0;
        let sent = 0;
        for (const file of sessionMessages) {
            if (!isMainSessionAllowed(session)) break;
            if (await processSessionMessage(normalizeClaudeToolUseNamesInRawJsonLines(file), replayOpts)) sent += 1;
            else skipped += 1;
        }
        if (sessionMessages.length > 0) {
            logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionMessages.length}, skipped=${skipped}, sent=${sent}`);
        }
        return startOffsetBytes;
    }

    async function ensureSessionFollower(session: string): Promise<void> {
        if (closed || !isMainSessionAllowed(session)) return;
        const desiredPath = getSessionFilePath(session);
        const existing = sessionFollowers.get(session);
        if (existing?.filePath === desiredPath) {
            await existing.controller.drainNow();
            return;
        }

        if (existing) {
            await existing.controller.stop();
            sessionFollowers.delete(session);
            resetReplaySuppressorBySession.delete(session);
        }

        const startOffsetBytes = await processSessionSnapshot(session);
        if (closed) return;
        let liveJsonlObservationEnabled = true;
        let controller!: JsonlFollowController;
        const isCurrentLiveFollower = (): boolean => (
            !closed
            && isMainSessionAllowed(session)
            && sessionFollowers.get(session)?.controller === controller
        );
        const handleFollowerMetric = (event: JsonlFollowerMetricEvent): void => {
            if (event.type !== 'file_reset') return;
            let suppressor = resetReplaySuppressorBySession.get(session);
            if (!suppressor) {
                suppressor = createClaudeJsonlResetReplaySuppressor();
                resetReplaySuppressorBySession.set(session, suppressor);
            }
            const suppressBeforeMs = suppressor.markReset({
                baselineSuppressBeforeMs: opts.replaySuppressRowsBeforeMs ?? null,
            });
            logger.debug('[SESSION_SCANNER] JSONL follower reset; suppressing replay-prone rows', {
                session,
                reason: event.reason,
                suppressBeforeMs,
            });
            if (liveJsonlObservationEnabled && isCurrentLiveFollower()) {
                liveJsonlObservationEnabled = false;
                observeLiveJsonlObservationLost(session, `file_reset:${event.reason}`);
            }
        };
        controller = createJsonlFollowController({
            filePath: desiredPath,
            startOffsetBytes,
            metrics: { emit: handleFollowerMetric },
            onJson: async (value) => {
                const suppressor = resetReplaySuppressorBySession.get(session);
                if (suppressor?.shouldSuppress(value)) return;
                if (liveJsonlObservationEnabled && isCurrentLiveFollower()) {
                    observeLiveJsonlValue(session, value);
                }
                await processSessionJsonValue(session, value);
            },
            onError: (error) => {
                logger.debug('[SESSION_SCANNER] Follower error:', error);
            },
        });
        sessionFollowers.set(session, { filePath: desiredPath, controller });
        await controller.start();
        if (closed || sessionFollowers.get(session)?.controller !== controller) {
            await controller.stop();
        }
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {
        if (closed) return;
        // logger.debug(`[SESSION_SCANNER] Syncing...`);

        // Collect session ids - include all sessions that have followers.
        // This ensures we continue processing sessions that Claude Code may still write to.
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            sessions.push(p);
        }
        for (const discoveredSessionId of await discoverNewSessionIds()) {
            sessions.push(discoveredSessionId);
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        if (closed) return;
        // Also process sessions that have active followers (they may still receive updates)
        for (let [sessionId, follower] of sessionFollowers) {
            if (!isMainSessionAllowed(sessionId)) {
                void follower.controller.stop();
                sessionFollowers.delete(sessionId);
                continue;
            }
            if (!sessions.includes(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process each session once via a one-time tail snapshot, then follow appended bytes incrementally.
        for (let session of sessions) {
            await ensureSessionFollower(session);
            if (closed) return;
        }

        await subagentCollector.syncAll();
        await teamInboxCollector.syncAll();
        if (closed) return;

        // Move pending sessions to finished sessions (but keep processing them via followers).
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }
    });
    invalidate = () => sync.invalidate();
    await sync.invalidateAndAwait();

    const closeProjectDirWatcher = (): void => {
        projectDirWatcher?.close();
        projectDirWatcher = null;
        watchedProjectDir = null;
    };

    const refreshProjectDirWatcher = (): void => {
        if (!opts.discoverNewSessions) {
            closeProjectDirWatcher();
            return;
        }

        const projectDir = effectiveProjectDir();
        if (projectDirWatcher && watchedProjectDir === projectDir) return;
        closeProjectDirWatcher();

        try {
            const watcher = watch(projectDir, (_eventType, filename) => {
                if (closed) return;
                const name = typeof filename === 'string' ? filename : null;
                if (name && !name.endsWith('.jsonl')) return;
                sync.invalidate();
            });
            watcher.unref?.();
            projectDirWatcher = watcher;
            watchedProjectDir = projectDir;
        } catch {
            // Best-effort only. The slow fallback interval below handles missed or unsupported watches.
        }
    };

    refreshProjectDirWatcher();

    // Slow fallback for missed fs.watch events and active follower maintenance.
    const intervalId = setInterval(
        () => { sync.invalidate(); },
        opts.discoverNewSessions ? DISCOVERY_WATCH_FALLBACK_INTERVAL_MS : ACTIVE_SESSION_FALLBACK_INTERVAL_MS,
    );
    intervalId.unref?.();

    // Public interface
    return {
        /**
         * The ONE sidechain importer for this scanner's session.
         *
         * `Task`/`Agent` sub-agent transcripts are discovered here from tool uses. Workflow-agent
         * sidecars cannot be: a workflow run has one `Workflow` tool call and many
         * `agent-<id>.jsonl` files, so the journal follower is the only thing that knows they
         * exist. It is exposed rather than duplicated so both kinds of sidechain share one follower
         * budget, one dedupe and one marking rule (see `registerSidechainFile`). Launchers reach it
         * through `createWorkflowAgentTranscriptRegistrar`, which fails closed while it is absent.
         */
        subagentFileCollector: subagentCollector,
        cleanup: async () => {
            closed = true;
            clearInterval(intervalId);
            closeProjectDirWatcher();
            invalidate = null;
            subagentCollector.cleanup();
            teamInboxCollector.cleanup();
            const followers = Array.from(sessionFollowers.values());
            sessionFollowers.clear();
            for (let follower of followers) {
                await follower.controller.stop();
            }
            pendingSessions.clear();
            finishedSessions.clear();
            discoveredSessions.clear();
            resetReplaySuppressorBySession.clear();
            trustedRawTranscriptSessionIds.clear();
            currentSessionId = null;
            for (const timeoutId of missingTranscriptTimers.values()) {
                clearTimeout(timeoutId);
            }
            missingTranscriptTimers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        onNewSession: (arg: string | SessionScannerSessionInfo) => {
            if (closed) return;
            const sessionId = typeof arg === 'string' ? arg : arg.sessionId;
            const transcriptPathRaw = typeof arg === 'string' ? null : arg.transcriptPath;
            const transcriptPath = typeof transcriptPathRaw === 'string' && transcriptPathRaw.trim() ? transcriptPathRaw : null;

            // Public onNewSession calls come from Claude's authenticated primary
            // SessionStart/offline-session boundary. Unlike unhooked directory
            // discovery, that trusted boundary may legitimately rotate the native
            // id on resume, fork, or compact and must replace a provisional bind.
            rebindMainSession(sessionId);
            trustRawTranscriptSession(sessionId);
            cleanupUnallowedSessionFollowers();

            let didUpdatePaths = false;
            if (transcriptPath) {
                const prevOverride = sessionFileOverrides.get(sessionId);
                if (prevOverride !== transcriptPath) {
                    sessionFileOverrides.set(sessionId, transcriptPath);
                    didUpdatePaths = true;
                }
                const nextProjectDir = dirname(transcriptPath);
                if (!projectDirOverride || projectDirOverride !== nextProjectDir) {
                    projectDirOverride = nextProjectDir;
                    didUpdatePaths = true;
                    refreshProjectDirWatcher();
                }
            }

            if (currentSessionId === sessionId) {
                if (didUpdatePaths) {
                    sync.invalidate();
                } else {
                    logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                }
                return;
            }
            if (finishedSessions.has(sessionId)) {
                if (didUpdatePaths) sync.invalidate();
                else logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                if (didUpdatePaths) sync.invalidate();
                else logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            if (currentSessionId && isMainSessionAllowed(currentSessionId)) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            scheduleTranscriptMissingWarning(sessionId);
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    const claudeJsonlKey = buildClaudeJsonlMessageKey(message);
    if (claudeJsonlKey) return claudeJsonlKey;
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else if (message.type === 'progress') {
        const uuid = typeof (message as any).uuid === 'string' ? (message as any).uuid : '';
        if (uuid) return `progress:${uuid}`;
        const ts = typeof (message as any).timestamp === 'string' ? (message as any).timestamp : '';
        if (ts) return `progress:timestamp:${ts}`;
        return `progress:${JSON.stringify(message)}`;
    } else {
        throw Error() // Impossible
    }
}

// Claude Code `system` lines are out-of-band side-channels (init, stop-hook summaries, inactivity
// recaps, etc.) — none of them are agent transcript content. `compact_boundary` is the one live
// lifecycle signal consumers need so they can publish compaction completion and close standalone
// `/compact` turns; downstream raw-message bridges still suppress it from visible transcript rows.
function isFilteredSystemMessage(message: RawJSONLines): boolean {
    if (message.type !== 'system') return false;
    return (message as Record<string, unknown>).subtype !== 'compact_boundary';
}

function resolveUnhookedSessionDisposition(params: Readonly<{
    bindDiscoveredSessions: boolean | undefined;
    classifyDiscoveredSession?: ((params: {
        sessionId: string;
        filePath: string;
        messages: readonly RawJSONLines[];
    }) => SessionScannerUnhookedSessionDisposition | null | undefined) | undefined;
    filePath: string;
    messages: readonly RawJSONLines[];
    sessionId: string;
}>): SessionScannerUnhookedSessionDisposition {
    const customDisposition = params.classifyDiscoveredSession?.({
        sessionId: params.sessionId,
        filePath: params.filePath,
        messages: params.messages,
    });
    if (customDisposition) return customDisposition;
    if (!shouldDiscoverUnhookedSession(params.messages)) return 'ignore';
    return params.bindDiscoveredSessions === false ? 'diagnostic' : 'main';
}

function shouldDiscoverUnhookedSession(messages: readonly RawJSONLines[]): boolean {
    return messages.some((message) => {
        if (message.type !== 'assistant') return false;
        const record = message as Record<string, unknown>;
        return record.isApiErrorMessage === true
            || record.error != null
            || record.apiErrorStatus != null
            || record.api_error_status != null
            || record.errorStatus != null
            || record.error_status != null;
    });
}

function readClaudeSessionJsonlEntrySessionId(entry: string): string | null {
    if (!entry.endsWith('.jsonl')) return null;
    const sessionId = entry.slice(0, -'.jsonl'.length);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) ? sessionId : null;
}

/**
 * Read and parse session log files lives in `readClaudeSessionJsonlMessages`.
 */
