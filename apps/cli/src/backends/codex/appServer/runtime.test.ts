import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';
import {
    buildConnectedServiceCredentialRecord,
    SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1,
    SessionMediaMessageMetaEnvelopeV1Schema,
    SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
    type AccountSettings,
} from '@happier-dev/protocol';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { Metadata } from '@/api/types';
import type { AgentMessage } from '@/agent';
import type { SessionTurnLifecycle } from '@/agent/runtime/session/turn/types';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { waitForCondition } from '@/testkit/async/waitFor';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { runScmCommand } from '@/scm/runtime';
import {
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import { logger } from '@/ui/logger';

import { createCodexAppServerRuntime, writeUsageLimitRecoveryIntentToMetadata } from './runtime';
import { createCodexAppServerProcessEnv, createCodexAppServerTestEnvScope } from './testkit/fakeCodexAppServer';

type CommittedSnapshotBody = Readonly<{
    type?: string;
    message?: string;
    text?: string;
    sidechainId?: string | null;
}>;

type TestCommittedMessageOptions = Readonly<{
    localId?: string;
    meta?: Readonly<{
        happierStreamSegmentV1?: Readonly<{
            segmentState?: string;
        }>;
    }>;
}>;

type RuntimeSessionMediaMessage = Extract<AgentMessage, { type: 'session-media' }>;

function createRuntimeMetadata(path: string): Metadata {
    return {
        path,
        host: 'test-host',
        homeDir: path,
        happyHomeDir: join(path, '.happier'),
        happyLibDir: join(path, '.happier', 'lib'),
        happyToolsDir: join(path, '.happier', 'tools'),
    };
}

it('recomputes the Codex scheduler usage-limit merge from latest metadata at the write boundary', async () => {
    const terminal = {
        v: 1 as const,
        status: 'cancelled' as const,
        issueFingerprint: 'usage-limit:codex:turn-1',
        armedAtMs: 100,
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 3,
        maxAttempts: 4,
        lastProbeError: null,
        resumePromptMode: 'standard' as const,
        selectedAuth: { kind: 'native' as const },
    };
    const staleWaiting = {
        ...terminal,
        status: 'waiting' as const,
        nextCheckAtMs: 200,
        attemptCount: 1,
    };
    let metadata = { path: '/tmp/session', sessionUsageLimitRecoveryV1: terminal } as unknown as Metadata;
    const session = {
        updateMetadata: vi.fn(async (updater: (latest: Metadata) => Metadata) => {
            metadata = updater(metadata);
        }),
    } as unknown as ApiSessionClient;

    await writeUsageLimitRecoveryIntentToMetadata(session, staleWaiting);

    expect(metadata).toMatchObject({
        sessionUsageLimitRecoveryV1: {
            status: 'cancelled',
            attemptCount: 3,
        },
    });
});

function createSessionTurnLifecycleTestDouble(overrides: Partial<SessionTurnLifecycle> = {}): SessionTurnLifecycle {
    return {
        beginTurn: vi.fn(async () => ({ turnId: 'session-turn-1' })),
        attachProviderTurnId: vi.fn(async () => {}),
        appendTranscriptAnchors: vi.fn(async () => {}),
        touchActiveTurn: vi.fn(async () => {}),
        completeTurn: vi.fn(async () => {}),
        failTurn: vi.fn(async () => {}),
        cancelTurn: vi.fn(async () => {}),
        endSession: vi.fn(async () => {}),
        markRollbackEligible: vi.fn(async () => {}),
        markRolledBack: vi.fn(async () => {}),
        hasActiveTurn: vi.fn(() => false),
        ...overrides,
    };
}

async function writeFakeCodexAppServerScript(params: Readonly<{
    dir: string;
    requestLogPath: string;
    rateLimitReadResult?: unknown;
    rateLimitReadError?: Readonly<{ code: number; message: string }>;
    rateLimitReadDelayMs?: number;
    accountReadResult?: unknown;
    rejectRateLimitRead?: boolean;
    rejectAccountRead?: boolean;
    rejectAccountReadCount?: number;
    loginStartError?: Readonly<{
        code: number;
        message: string;
    }>;
    loginStartResponseDelayMs?: number;
    rollbackError?: Readonly<{
        code: number;
        message: string;
    }>;
    rejectFirstInterruptAsNoActiveTurn?: boolean;
    interruptTerminalWithoutResponse?: boolean;
    interruptTerminalDelayMs?: number;
    rejectSteerAsNoActiveTurn?: boolean;
    rejectPermissionsProfile?: boolean;
    rejectGoalMethods?: boolean;
    rejectGoalMethodsAsInvalidRequest?: boolean;
    emitGoalContinuationTurn?: boolean;
    emitGoalContinuationUsageLimitFailure?: boolean;
    emitGoalContinuationItemsBeforeStarted?: boolean;
    rejectReviewStartMethodUnavailable?: boolean;
    rejectStructuredTurnInput?: boolean;
    rejectStructuredSteerInput?: boolean;
    steerUserMessageEchoDelayMs?: number;
    emitResumeContinuationUserInputRequest?: boolean;
    emitHistoricalResumeUserInputRequestBeforeResponse?: boolean;
    emitResumeTurnStartedBeforeResponse?: boolean;
    emitResumeHistoryBoundaryNotifications?: boolean;
    emitHistoricalNotificationOnResume?: boolean;
    resumeResponseDelayMs?: number;
    resumeResponseThreadId?: string;
    threadReadResponseDelayMs?: number;
    emitIdleMcpRequestAfterThreadStart?: boolean;
    rejectPermissionsProfileAsStringShape?: boolean;
    rejectThreadRead?: boolean;
    requireResumeBeforeThreadRead?: boolean;
    oversizedResumePayloadChars?: number;
    omitTurnStartedForPrompt?: string;
    omitTurnCompletedForPrompt?: string;
}>): Promise<string> {
    const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
    const script = [
        '#!/usr/bin/env node',
        'import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";',
        'import readline from "node:readline";',
        `const requestLogPath = ${JSON.stringify(params.requestLogPath)};`,
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        'let staleTerminalTurnId = null;',
        'let loginStartCount = 0;',
        'let accountReadCount = 0;',
        'let interruptCount = 0;',
        'const resumedThreadIds = new Set();',
        'for await (const line of rl) {',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        '    await appendFile(requestLogPath, JSON.stringify({ id: msg.id ?? null, method: msg.method, params: msg.params ?? null, result: msg.result ?? null, error: msg.error ?? null }) + "\\n");',
        '    if (msg.method === "initialize") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "initialized") continue;',
        '    if (msg.method === "thread/start") {',
        `        if (${JSON.stringify(params.rejectPermissionsProfile === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: permissions unsupported" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectPermissionsProfileAsStringShape === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request: invalid type: map, expected a string" } }) + "\\n");',
        '            continue;',
        '        }',
        '        if (msg.params?.persistExtendedHistory !== true || msg.params?.experimentalRawEvents !== true) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "missing thread/start flags" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null, activePermissionProfile: msg.params?.permissions ?? null } }) + "\\n");',
        `        if (${JSON.stringify(params.emitIdleMcpRequestAfterThreadStart === true)}) {`,
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "idle-mcp-request", method: "mcpServer/elicitation/request", params: { threadId: "thread-started", id: "request_scoped_idle_mcp", serverName: "happier", message: "Tool \\"change_title\\" needs input", _meta: { tool_params: { title: "Idle Title" } } } }) + "\\n");',
        '            }, 5);',
        '        }',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/read") {',
        `        if (${JSON.stringify(params.rejectThreadRead === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found: thread/read" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.requireResumeBeforeThreadRead === true)} && !resumedThreadIds.has(msg.params?.threadId ?? "")) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "thread not found: " + (msg.params?.threadId ?? "") } }) + "\\n");',
        '            continue;',
        '        }',
        '        const threadReadResponse = JSON.stringify({ id: msg.id, result: { thread: { id: msg.params?.threadId ?? null, turns: msg.params?.includeTurns === true ? [{ id: "turn-history", items: [{ id: "item-history", type: "agentMessage", text: "history" }] }] : [] } } }) + "\\n";',
        `        if (${JSON.stringify(params.threadReadResponseDelayMs ?? 0)} > 0) {`,
        `            setTimeout(() => { process.stdout.write(threadReadResponse); }, ${JSON.stringify(params.threadReadResponseDelayMs ?? 0)});`,
        '        } else {',
        '            process.stdout.write(threadReadResponse);',
        '        }',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/resume") {',
        `        if (${JSON.stringify(params.rejectPermissionsProfile === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: permissions unsupported" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectPermissionsProfileAsStringShape === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request: invalid type: map, expected a string" } }) + "\\n");',
        '            continue;',
        '        }',
        '        if (msg.params?.persistExtendedHistory !== true || typeof msg.params?.excludeTurns !== "boolean") {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "missing thread/resume flags" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const adoptsOverrideThread = Object.prototype.hasOwnProperty.call(msg.params ?? {}, "model") || Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier");',
        `        const resumedThreadId = ${JSON.stringify(params.resumeResponseThreadId ?? null)} ?? (adoptsOverrideThread ? "thread-overrides" : (msg.params?.threadId ?? null));`,
        '        if (resumedThreadId) resumedThreadIds.add(resumedThreadId);',
        `        if (${JSON.stringify(params.emitResumeTurnStartedBeforeResponse === true)}) {`,
        '            const resumeTurnId = "turn-resume-start-before-response";',
        '            process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: resumedThreadId, turn: { id: resumeTurnId } } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: resumedThreadId, turnId: resumeTurnId, itemId: "resume_msg_1", delta: "Still working" } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: resumedThreadId, model: msg.params?.model ?? (adoptsOverrideThread ? "gpt-5.4-mini" : "gpt-5.4"), serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null, activePermissionProfile: msg.params?.permissions ?? null } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.emitResumeHistoryBoundaryNotifications === true)}) {`,
        '            const historicalTurnId = "turn-resume-history";',
        '            const historicalItemId = "item-resume-history";',
        '            const liveTurnId = "turn-resume-live";',
        '            const liveItemId = "item-resume-live";',
        '            process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: resumedThreadId, turn: { id: historicalTurnId } } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: resumedThreadId, turnId: historicalTurnId, itemId: historicalItemId, delta: "Historical replay" } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: resumedThreadId, turnId: historicalTurnId, item: { id: historicalItemId, type: "agentMessage", text: "Historical replay" } } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: resumedThreadId, turn: { id: historicalTurnId, status: "completed" } } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: resumedThreadId, turn: { id: liveTurnId } } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: resumedThreadId, turnId: liveTurnId, itemId: liveItemId, delta: "Genuinely live" } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: resumedThreadId, turns: [{ id: historicalTurnId, status: "completed", items: [{ id: historicalItemId, type: "agentMessage", text: "Historical replay" }] }] }, model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '            }, 20);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: resumedThreadId, turnId: liveTurnId, item: { id: liveItemId, type: "agentMessage", text: "Genuinely live" } } }) + "\\n");',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: resumedThreadId, turn: { id: liveTurnId, status: "completed" } } }) + "\\n");',
        '            }, 35);',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.emitHistoricalResumeUserInputRequestBeforeResponse === true)}) {`,
        '            const historicalTurnId = "turn-resume-request-history";',
        '            const historicalItemId = "resume_tool_input_history";',
        '            process.stdout.write(JSON.stringify({ id: "resume-request-input-history", method: "item/tool/requestUserInput", params: { threadId: resumedThreadId, turnId: historicalTurnId, itemId: historicalItemId, item: { id: historicalItemId, type: "mcpToolCall", server: "happier", tool: "confirm", arguments: { prompt: "continue" } }, questions: [{ id: "resume_question_history", question: "Continue old turn?" }] } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: resumedThreadId, turns: [{ id: historicalTurnId, status: "completed", items: [{ id: historicalItemId, type: "mcpToolCall" }] }] }, model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.emitHistoricalNotificationOnResume === true)}) {`,
        '            const historicalTurnId = "turn-resume-recovery-history";',
        '            const historicalItemId = "item-resume-recovery-history";',
        '            process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: resumedThreadId, turn: { id: historicalTurnId } } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: resumedThreadId, turnId: historicalTurnId, itemId: historicalItemId, delta: "Historical recovery replay" } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: resumedThreadId, turnId: historicalTurnId, item: { id: historicalItemId, type: "agentMessage", text: "Historical recovery replay" } } }) + "\\n");',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: resumedThreadId, turn: { id: historicalTurnId, status: "completed" } } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: resumedThreadId, turns: [{ id: historicalTurnId, status: "completed", items: [{ id: historicalItemId, type: "agentMessage", text: "Historical recovery replay" }] }] }, model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        `        const oversizedPayload = ${JSON.stringify(params.oversizedResumePayloadChars ?? 0)} > 0 ? "x".repeat(${JSON.stringify(params.oversizedResumePayloadChars ?? 0)}) : undefined;`,
        '        const resumeResponse = JSON.stringify({ id: msg.id, result: { threadId: resumedThreadId, model: msg.params?.model ?? (adoptsOverrideThread ? "gpt-5.4-mini" : "gpt-5.4"), serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null, activePermissionProfile: msg.params?.permissions ?? null, ...(oversizedPayload ? { oversizedPayload } : {}) } }) + "\\n";',
        `        if (${JSON.stringify(params.resumeResponseDelayMs ?? 0)} > 0) {`,
        `            setTimeout(() => { process.stdout.write(resumeResponse); }, ${JSON.stringify(params.resumeResponseDelayMs ?? 0)});`,
        '        } else {',
        '            process.stdout.write(resumeResponse);',
        '        }',
        `        if (${JSON.stringify(params.emitResumeContinuationUserInputRequest === true)}) {`,
        '            const resumeTurnId = "turn-resume-request";',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "resume-request-input", method: "item/tool/requestUserInput", params: { threadId: resumedThreadId, turnId: resumeTurnId, itemId: "resume_tool_input", item: { id: "resume_tool_input", type: "mcpToolCall", server: "happier", tool: "confirm", arguments: { prompt: "continue" } }, questions: [{ id: "resume_question", question: "Continue?" }] } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: resumedThreadId, turn: { id: resumeTurnId } } }) + "\\n");',
        '            }, 30);',
        '        }',
        '        continue;',
        '    }',
        '    if (msg.method === "account/rateLimits/read") {',
        `        if (${JSON.stringify(params.rateLimitReadError ?? null)}) {`,
        `            setTimeout(() => process.stdout.write(JSON.stringify({ id: msg.id, error: ${JSON.stringify(params.rateLimitReadError ?? null)} }) + "\\n"), ${JSON.stringify(params.rateLimitReadDelayMs ?? 0)});`,
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectRateLimitRead === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "connection reset while reading rate limits" } }) + "\\n");',
        '            continue;',
        '        }',
        `        setTimeout(() => process.stdout.write(JSON.stringify({ id: msg.id, result: ${JSON.stringify(params.rateLimitReadResult ?? { plan_type: 'pro', primary: { used_percent: 12, resets_at: '2026-05-17T12:00:00.000Z' } })} }) + "\\n"), ${JSON.stringify(params.rateLimitReadDelayMs ?? 0)});`,
        '        continue;',
        '    }',
        '    if (msg.method === "account/read") {',
        '        accountReadCount += 1;',
        `        if (accountReadCount <= ${JSON.stringify(params.rejectAccountReadCount ?? 0)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "account/read cold spawn not ready" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectAccountRead === true)} && loginStartCount > 0) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "account/read diagnostics unavailable" } }) + "\\n");',
        '            continue;',
        '        }',
        `        process.stdout.write(JSON.stringify({ id: msg.id, result: ${JSON.stringify(params.accountReadResult ?? { account: { id: 'acct_live_codex', email: 'codex-user@example.test' } })} }) + "\\n");`,
        '        continue;',
        '    }',
        '    if (msg.method === "account/login/start") {',
        `        if (${JSON.stringify(params.loginStartError ?? null)}) {`,
        `            process.stdout.write(JSON.stringify({ id: msg.id, error: ${JSON.stringify(params.loginStartError ?? null)} }) + "\\n");`,
        '            continue;',
        '        }',
        '        loginStartCount += 1;',
        `        if (${JSON.stringify(params.loginStartResponseDelayMs ?? 0)} > 0) {`,
        `            setTimeout(() => process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n"), ${JSON.stringify(params.loginStartResponseDelayMs ?? 0)});`,
        '        } else {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
        '        }',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/goal/get") {',
        `        if (${JSON.stringify(params.rejectGoalMethodsAsInvalidRequest === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectGoalMethods === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found: thread/goal/get" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { goal: { threadId: msg.params?.threadId ?? "thread-started", objective: "Ship the Codex app-server lane", status: "active", updatedAt: "2026-05-13T10:00:00.000Z" } } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/goal/set") {',
        `        if (${JSON.stringify(params.rejectGoalMethodsAsInvalidRequest === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectGoalMethods === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found: thread/goal/set" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { goal: { threadId: msg.params?.threadId ?? "thread-started", objective: msg.params?.objective ?? "Current objective", status: msg.params?.status ?? "active", tokenBudget: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "tokenBudget") ? msg.params.tokenBudget : undefined, updatedAt: "2026-05-13T10:05:00.000Z" } } }) + "\\n");',
        '        process.stdout.write(JSON.stringify({ method: "thread/goal/updated", params: { threadId: msg.params?.threadId ?? "thread-started", goal: { threadId: msg.params?.threadId ?? "thread-started", objective: msg.params?.objective ?? "Current objective", status: msg.params?.status ?? "active", tokenBudget: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "tokenBudget") ? msg.params.tokenBudget : undefined, updatedAt: "2026-05-13T10:05:00.000Z" } } }) + "\\n");',
        `        if (${JSON.stringify(params.emitGoalContinuationTurn === true || params.emitGoalContinuationUsageLimitFailure === true)}) {`,
        '            const goalThreadId = msg.params?.threadId ?? "thread-started";',
        '            const goalTurnId = "turn-goal-continuation";',
        `            if (${JSON.stringify(params.emitGoalContinuationUsageLimitFailure === true)}) {`,
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: goalThreadId, turn: { id: goalTurnId } } }) + "\\n");',
        '                }, 80);',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: goalThreadId, turn: { id: goalTurnId, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", additionalDetails: null } } } }) + "\\n");',
        '                }, 100);',
        '                continue;',
        '            }',
        `            if (${JSON.stringify(params.emitGoalContinuationItemsBeforeStarted === true)}) {`,
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: goalThreadId, turnId: goalTurnId, itemId: "goal_msg_1", delta: "Goal continuation" } }) + "\\n");',
        '                }, 5);',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: goalThreadId, turnId: goalTurnId, item: { id: "goal_msg_1", type: "agentMessage", text: "Goal continuation" } } }) + "\\n");',
        '                }, 6);',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: goalThreadId, turn: { id: goalTurnId } } }) + "\\n");',
        '                }, 9);',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: goalThreadId, turn: { id: goalTurnId } } }) + "\\n");',
        '                }, 15);',
        '                continue;',
        '            }',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: goalThreadId, turn: { id: goalTurnId } } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: goalThreadId, turnId: goalTurnId, itemId: "goal_msg_1", delta: "Goal " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: goalThreadId, turnId: goalTurnId, item: { id: "goal_cmd_1", type: "commandExecution", command: "git status", cwd: "/repo" } } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: goalThreadId, turnId: goalTurnId, item: { id: "goal_cmd_1", type: "commandExecution", stdout: "clean", exitCode: 0 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: goalThreadId, turnId: goalTurnId, itemId: "goal_msg_1", delta: "continuation" } }) + "\\n");',
        '            }, 9);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: goalThreadId, turnId: goalTurnId, item: { id: "goal_msg_1", type: "agentMessage", text: "Goal continuation" } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: goalThreadId, turn: { id: goalTurnId } } }) + "\\n");',
        '            }, 15);',
        '        }',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/goal/clear") {',
        `        if (${JSON.stringify(params.rejectGoalMethodsAsInvalidRequest === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: "Invalid request" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectGoalMethods === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found: thread/goal/clear" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
        '        process.stdout.write(JSON.stringify({ method: "thread/goal/cleared", params: { threadId: msg.params?.threadId ?? "thread-started" } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "plugin/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { marketplaces: [{ name: "codex", path: null, interface: null, plugins: [{ id: "reviewer@codex", name: "reviewer", source: { type: "remote" }, interface: { displayName: "Reviewer", shortDescription: "Review session context" }, enabled: true, installed: true }] }] } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "skills/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [{ cwd: msg.params?.cwds?.[0] ?? null, skills: [{ name: "debugger", description: "Debug code", interface: { displayName: "Debugger", shortDescription: "Debug code" }, path: "/skills/debugger/SKILL.md", scope: "repo", enabled: true }], errors: [] }] } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/name/set") {',
        '        if (msg.params?.name === "fail-native-title-sync") {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "native title sync failed" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "collaborationMode/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: [{ name: "Default", mode: "default", reasoning_effort: null }, { name: "Plan", mode: "plan", reasoning_effort: "medium" }] }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "model/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium" }, { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }] }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/compact/start") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "manual_compact_1", type: "contextCompaction" } } }) + "\\n");',
        '        }, 8);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "manual_compact_1", type: "contextCompaction" } } }) + "\\n");',
        '        }, 12);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: "turn-manual-compact" } } }) + "\\n");',
        '        }, 16);',
        '        continue;',
        '    }',
        '    if (msg.method === "review/start") {',
        `        if (${JSON.stringify(params.rejectReviewStartMethodUnavailable === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Method not found: review/start" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const turnId = "turn-review-native";',
        '        if (typeof msg.params?.target?.instructions === "string" && msg.params.target.instructions.includes("invalid-review-input")) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: review target is invalid" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const reviewText = typeof msg.params?.target?.instructions === "string" && msg.params.target.instructions.includes("different-final") ? "Native review body" : "Native review text";',
        '        const finalText = typeof msg.params?.target?.instructions === "string" && msg.params.target.instructions.includes("different-final") ? "Different final assistant text" : reviewText;',
        '        const completionDelayMs = typeof msg.params?.target?.instructions === "string" && msg.params.target.instructions.includes("delayed-review") ? 50 : 15;',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, reviewThreadId: msg.params?.threadId ?? null } }) + "\\n");',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_entered_1", type: "enteredReviewMode", review: "current changes" } } }) + "\\n");',
        '        }, 5);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_entered_1", type: "enteredReviewMode", review: "current changes" } } }) + "\\n");',
        '        }, 6);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_exited_1", type: "exitedReviewMode", review: reviewText } } }) + "\\n");',
        '        }, 7);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_exited_1", type: "exitedReviewMode", review: reviewText } } }) + "\\n");',
        '        }, 8);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "review_msg_1", type: "agentMessage", text: finalText } } }) + "\\n");',
        '        }, 9);',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '        }, completionDelayMs);',
        '        continue;',
        '    }',
        '    if (msg.method === "turn/start") {',
        `        if (${JSON.stringify(params.rejectPermissionsProfile === true)} && msg.params?.permissions) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: permissions unsupported" } }) + "\\n");',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectStructuredTurnInput === true)} && Array.isArray(msg.params?.input) && msg.params.input.length > 1) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: structured turn input unsupported" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const text = Array.isArray(msg.params?.input) ? String(msg.params.input[0]?.text ?? "unknown") : "unknown";',
        '        const matchingTurnStartCount = (await readFile(requestLogPath, "utf8").catch(() => "")).split("\\n").filter((line) => { try { const entry = JSON.parse(line); return entry.method === "turn/start" && Array.isArray(entry.params?.input) && String(entry.params.input[0]?.text ?? "") === text; } catch { return false; } }).length;',
        '        const turnId = matchingTurnStartCount > 1 ? `turn-${text}-${matchingTurnStartCount}` : `turn-${text}`;',
        '        const completionDelayMs = text === "connected-service-invalidation-active-turn" && matchingTurnStartCount === 1 ? 120000 : text === "overlap-start" ? 180 : text === "cancel-me" ? 50 : 15;',
        '        if (text === "usage-limit-before-turn-response") {',
        '            process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", additionalDetails: null } } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '            }, 15);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", additionalDetails: null } } } }) + "\\n");',
        '            }, 25);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-error-then-primary-activity") {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", additionalDetails: null } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "continued_after_usage_warning", delta: "Continued after usage warning" } }) + "\\n");',
        '            }, 800);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "continued_after_usage_warning", type: "agentMessage", text: "Continued after usage warning" } } }) + "\\n");',
        '            }, 805);',
        '            continue;',
        '        }',
        '        if (text === "nonterminal-error-then-process-exit") {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", additionalDetails: null } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(async () => {',
        '                await appendFile(requestLogPath, JSON.stringify({ id: null, method: "test/process-exit", params: null, result: null, error: null }) + "\\n");',
        '                process.exit(19);',
        '            }, 15);',
        '            continue;',
        '        }',
        '        const respondDelayMs = (text === "connected-service-invalidation-before-acceptance" || text === "connected-service-invalidation-before-acceptance-after-activity") && matchingTurnStartCount === 1 ? 120000 : text === "steer-delay" ? 60 : (text === "overlap-start" || text === "unknown-terminal-before-turn-start-response" || text === "owned-terminal-before-turn-start-response" || text === "owned-then-unknown-terminal-before-turn-start-response" || text === "unknown-then-owned-terminal-before-turn-start-response") ? 80 : 0;',
        '        if (text === "unknown-terminal-before-turn-start-response") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: "turn-unknown-before-start-response" } } }) + "\\n");',
        '            }, 5);',
        '        }',
        '        if (text === "owned-terminal-before-turn-start-response") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 5);',
        '        }',
        '        if (text === "owned-then-unknown-terminal-before-turn-start-response" || text === "unknown-then-owned-terminal-before-turn-start-response") {',
        '            const ownedFirst = text === "owned-then-unknown-terminal-before-turn-start-response";',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: ownedFirst ? turnId : turnId + "-unknown" } } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: ownedFirst ? turnId + "-unknown" : turnId } } }) + "\\n");',
        '            }, 10);',
        '        }',
        '        if (text === "bridge-stale-terminal-old-turn") {',
        '            staleTerminalTurnId = turnId;',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '            }, 0);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, id: turnId } }) + "\\n");',
        '            }, 15);',
        '            continue;',
        '        }',
        '        if (text === "bridge-stale-terminal-next-turn") {',
        '            setTimeout(() => {',
        '                const staleTurnId = staleTerminalTurnId;',
        '                if (!staleTurnId) return;',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId: staleTurnId, item: { id: "stale_cmd_1", type: "commandExecution", command: "stale", cwd: "/repo" } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                const staleTurnId = staleTerminalTurnId;',
        '                if (!staleTurnId) return;',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId: staleTurnId, item: { id: "stale_cmd_1", type: "commandExecution", stdout: "stale", exitCode: 0 } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                const staleTurnId = staleTerminalTurnId;',
        '                if (!staleTurnId) return;',
        '                process.stdout.write(JSON.stringify({ id: "approval-stale-turn", method: "item/commandExecution/requestApproval", params: { threadId: msg.params?.threadId ?? null, turnId: staleTurnId, itemId: "stale_cmd_1", reason: "stale approval" } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '            }, 80);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 85);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 100);',
        '            continue;',
        '        }',
        '        if (text === "bridge-terminal-id-only-duplicate-command-result") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '            }, respondDelayMs);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, item: { id: "terminal_id_cmd_1", type: "commandExecution", command: "yarn test", cwd: "/repo" } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, item: { id: "terminal_id_cmd_1", type: "commandExecution", stdout: "passed", exitCode: 0 } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "terminal_id_cmd_1", type: "commandExecution", stdout: "passed", exitCode: 0 } } }) + "\\n");',
        '            }, 70);',
        '            continue;',
        '        }',
        '        setTimeout(() => {',
        '            const result = text === "no-id-response-unknown-before-owned-start" || text === "no-id-response-owned-terminal-before-owned-start" || text === "child-terminal-before-primary-identity-no-activity" || text === "child-terminal-after-primary-idless-activity"',
        '                ? { threadId: msg.params?.threadId ?? null }',
        '                : { turn: { id: turnId }, threadId: msg.params?.threadId ?? null };',
        '            process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");',
        '        }, respondDelayMs);',
        '        if (text === "child-terminal-before-primary-identity-no-activity" || text === "child-terminal-after-primary-idless-activity") {',
        '            if (text === "child-terminal-after-primary-idless-activity") {',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, itemId: "primary_activity", delta: "working" } }) + "\\n");',
        '                }, 3);',
        '            }',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-child-terminal", turn: { id: "turn-child-terminal" } } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 300);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 320);',
        '        } else if (text === "no-id-response-unknown-before-owned-start" || text === "no-id-response-owned-terminal-before-owned-start") {',
        '            const unknownFirst = text === "no-id-response-unknown-before-owned-start";',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: unknownFirst ? turnId + "-unknown" : turnId } } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 120);',
        '            if (unknownFirst) {',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '                }, 140);',
        '            }',
        '        } else if (text === "overlap-start") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 5);',
        '        } else if (text === "connected-service-invalidation-before-acceptance-after-activity") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "auth_invalidation_msg_1", delta: "I started" } }) + "\\n");',
        '            }, 5);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "auth_invalidation_msg_1", type: "agentMessage", text: "I started" } } }) + "\\n");',
        '            }, 6);',
        `        } else if (text !== ${JSON.stringify(params.omitTurnStartedForPrompt ?? null)}) {`,
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, respondDelayMs + 5);',
        '        }',
        '        if (text === "bridge-streams") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_1", delta: "Hello " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/reasoning/textDelta", params: { itemId: "reason_1", delta: "thinking" } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "cmd_1", type: "commandExecution", command: "ls -la", cwd: "/repo" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "cmd_1", type: "commandExecution", stdout: "done", exitCode: 0 } } }) + "\\n");',
        '            }, 9);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "tool_1", type: "mcpToolCall", server: "playwright", tool: "browser_navigate", arguments: { url: "https://example.com" } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "tool_1", type: "mcpToolCall", result: { Ok: { status: "ok" } } } } }) + "\\n");',
        '            }, 11);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "patch_1", type: "fileChange", auto_approved: true, changes: [{ path: "src/file.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1,2 @@\\n-old line\\n+old line\\n+new line\\n" }] } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "patch_1", type: "fileChange", stdout: "patched", success: true } } }) + "\\n");',
        '            }, 13);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "reason_1", type: "reasoning", content: ["thinking hard"] } } }) + "\\n");',
        '            }, 14);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_1", type: "agentMessage", text: "Hello world" } } }) + "\\n");',
        '            }, 15);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "mcp-elicitation-request", method: "mcpServer/elicitation/request", params: { toolUseId: "mcp_tool_1", invocation: { server: "happier", tool: "change_title", arguments: { title: "New Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-callid") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "mcp-elicitation-request-callid", method: "mcpServer/elicitation/request", params: { callId: "call_test_1", invocation: { tool: "mcp__happier__change_title", arguments: { title: "New Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-param-id") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "mcp-elicitation-request-param-id", method: "mcpServer/elicitation/request", params: { threadId: msg.params?.threadId ?? null, id: "mcp_request_param_id_1", serverName: "happier", mode: "form", _meta: { tool_title: "change_title", tool_params: { title: "New Title" } }, message: "Allow the happier MCP server to run tool \\"change_title\\"?", requestedSchema: { type: "object", properties: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-meta") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params: { threadId: msg.params?.threadId ?? null, turnId: turnId, serverName: "happier", mode: "form", _meta: { tool_params: { title: "New Title" } }, message: "Allow the happier MCP server to run tool \\"change_title\\"?", requestedSchema: { type: "object", properties: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-meta-tool-title") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params: { threadId: msg.params?.threadId ?? null, turnId: turnId, serverName: "happier", mode: "form", _meta: { tool_title: "change_title", tool_params: { title: "New Title" } }, requestedSchema: { type: "object", properties: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-display-title-with-message-tool") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params: { threadId: msg.params?.threadId ?? null, turnId: turnId, serverName: "happier", mode: "form", _meta: { tool_title: "Change Chat Title", tool_description: "Change the title of the current chat session", tool_params: { title: "New Title" } }, message: "Allow the happier MCP server to run tool \\"change_title\\"?", requestedSchema: { type: "object", properties: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-elicitation-unidentified") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: 0, method: "mcpServer/elicitation/request", params: { threadId: msg.params?.threadId ?? null, turnId: turnId, serverName: "happier", mode: "form", requestedSchema: { type: "object", properties: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-completed") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_1", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "New Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_1", type: "mcpToolCall", result: { Ok: { success: true, title: "New Title" } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-completed-content-envelope") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_content_1", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "Content Envelope Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_content_1", type: "mcpToolCall", result: { Ok: { content: [{ type: "text", text: "{\\"success\\":true,\\"title\\":\\"Content Envelope Title\\"}" }], isError: false } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-blank-title") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_blank", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "   " } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_blank", type: "mcpToolCall", result: { Ok: { success: true, title: "   " } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-failed") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_failed", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "Failed Title" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_failed", type: "mcpToolCall", result: { Ok: { success: false, title: "Failed Title" } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-mcp-title-tool-native-sync-fails") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "mcp_title_native_fail", type: "mcpToolCall", server: "happier", tool: "change_title", arguments: { title: "fail-native-title-sync" } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "mcp_title_native_fail", type: "mcpToolCall", result: { Ok: { success: true, title: "fail-native-title-sync" } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 20);',
        '            continue;',
        '        }',
        '        if (text === "bridge-streams-divergent-final") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_diverge", delta: "READY " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_diverge", type: "agentMessage", text: "READY_FOR_FOLLOWUP" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-generated-image") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_img", delta: "Generated image:" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "img_1", type: "image_generation_call", status: "completed", result: "iVBORw0KGgo=" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-generated-image-duplicate") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_img_dup", delta: "Generated image:" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "img_dup", type: "image_generation_call", status: "completed", result: "iVBORw0KGgo=" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "img_dup", type: "image_generation_call", status: "completed", result: "iVBORw0KGgo=" } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-late-command-result-after-turn-completed") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "late_cmd_1", type: "commandExecution", command: "yarn test", cwd: "/repo" } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "late_cmd_1", type: "commandExecution", stdout: "passed", exitCode: 0 } } }) + "\\n");',
        '            }, 70);',
        '            continue;',
        '        }',
        '        if (text === "bridge-duplicate-command-result-during-terminal-drain") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "drain_dup_cmd_1", type: "commandExecution", command: "yarn test", cwd: "/repo" } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "drain_dup_cmd_1", type: "commandExecution", command: "yarn test", cwd: "/repo", stdout: "passed", exitCode: 0 } } }) + "\\n");',
        '            }, 70);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "drain_dup_cmd_1", type: "commandExecution", command: "yarn test", cwd: "/repo", stdout: "passed", exitCode: 0 } } }) + "\\n");',
        '            }, 72);',
        '            continue;',
        '        }',
        '        if (text === "bridge-late-command-start-after-turn-completed") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "late_start_cmd_1", type: "commandExecution", command: "yarn test", cwd: "/repo" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "late_start_cmd_1", type: "commandExecution", command: "yarn test", cwd: "/repo", stdout: "passed", exitCode: 0 } } }) + "\\n");',
        '            }, 70);',
        '            continue;',
        '        }',
        '        if (text === "bridge-late-filechange-start-after-turn-completed") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "late_file_1", type: "fileChange" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "late_file_1", type: "fileChange", changes: [{ path: "src/file.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1,2 @@\\n-old\\n+new\\n" }], stdout: "patched", success: true } } }) + "\\n");',
        '            }, 70);',
        '            continue;',
        '        }',
        '        if (text === "bridge-top-level-item-id-with-nested-turn") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, id: "nested_cmd_1", type: "commandExecution", turn: { id: turnId }, command: "pwd", cwd: "/repo" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId }, item: { id: "nested_cmd_1", type: "commandExecution", command: "pwd", cwd: "/repo", stdout: "/repo", exitCode: 0 } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, id: turnId } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "bridge-duplicate-command-result-after-terminal-turn") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "dup_cmd_1", type: "commandExecution", command: "yarn test", cwd: "/repo" } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "dup_cmd_1", type: "commandExecution", stdout: "passed", exitCode: 0 } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "dup_cmd_1", type: "commandExecution", stdout: "passed", exitCode: 0 } } }) + "\\n");',
        '            }, 70);',
        '            continue;',
        '        }',
        '        if (text === "bridge-streams-multi-item") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_a", delta: "Alpha" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/reasoning/textDelta", params: { itemId: "reason_a", delta: "think-a" } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_a", type: "agentMessage", text: "Alpha done" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "reason_a", type: "reasoning", content: ["think-a done"] } } }) + "\\n");',
        '            }, 9);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_b", delta: "Beta" } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/reasoning/textDelta", params: { itemId: "reason_b", delta: "think-b" } }) + "\\n");',
        '            }, 11);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_b", type: "agentMessage", text: "Beta done" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "reason_b", type: "reasoning", content: ["think-b done"] } } }) + "\\n");',
        '            }, 13);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-plan-and-agent-message") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/plan/delta", params: { itemId: "plan_1", delta: "Plan draft" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "plan_1", type: "Plan", text: "Plan final" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_after_plan", delta: "Answer draft" } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_after_plan", type: "agentMessage", text: "Answer final" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-late-final-after-turn-completed") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_late", type: "agentMessage", text: "Late final answer" } } }) + "\\n");',
        '            }, 12);',
        '            continue;',
        '        }',
        '        if (text === "bridge-raw-final-only") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Raw final answer" }] } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "bridge-raw-and-normalized-final") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Raw fallback answer" }] } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_raw_normalized", delta: "Normalized " } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_raw_normalized", type: "agentMessage", text: "Normalized final answer" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-raw-and-normalized-different-items") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { item: { id: "raw_msg_a", type: "message", role: "assistant", content: [{ type: "output_text", text: "Raw item answer" }] } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "msg_b", delta: "Normalized " } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "msg_b", type: "agentMessage", text: "Normalized item answer" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-item-raw-final-before-tool-call") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { item: { id: "raw_before_tool", type: "message", role: "assistant", content: [{ type: "output_text", text: "Raw item before tool" }] } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "cmd_after_raw", type: "commandExecution", command: "pwd", cwd: process.cwd() } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "bridge-turn-diff") {',
            '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/diff/updated", params: { threadId: msg.params?.threadId ?? null, turnId, unifiedDiff: "diff --git a/src/diffed.ts b/src/diffed.ts\\n--- a/src/diffed.ts\\n+++ b/src/diffed.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "bridge-command-only-git-diff") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "cmd_git_diff_1", type: "commandExecution", command: "mkdir -p src && printf generated > src/command-only.ts", cwd: process.cwd() } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(async () => {',
        '                await mkdir("src", { recursive: true });',
        '                await writeFile("src/command-only.ts", "generated by shell\\n", "utf8");',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "cmd_git_diff_1", type: "commandExecution", command: "mkdir -p src && printf generated > src/command-only.ts", cwd: process.cwd(), aggregatedOutput: "", exitCode: 0, status: "completed" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 24);',
        '            continue;',
        '        }',
        '        if (text === "bridge-token-usage") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: msg.params?.threadId ?? null, turnId, tokenUsage: { total: { totalTokens: 1200, inputTokens: 700, cachedInputTokens: 200, outputTokens: 250, reasoningOutputTokens: 50 }, last: { totalTokens: 1200, inputTokens: 700, cachedInputTokens: 200, outputTokens: 250, reasoningOutputTokens: 50 }, modelContextWindow: 1000000 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "bridge-context-compaction") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "compact_1", type: "contextCompaction" } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "compact_1", type: "contextCompaction" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "failed-turn") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "model-capacity-once" && matchingTurnStartCount === 1) {',
        '            const capacityError = { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "other", additionalDetails: null };',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: capacityError } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "model-capacity-twice" && matchingTurnStartCount <= 2) {',
        '            const capacityMessage = matchingTurnStartCount === 1 ? "ORIGINAL_CAPACITY_FAILURE: Selected model is at capacity. Please try a different model." : "RETRY_CAPACITY_FAILURE: Selected model is at capacity. Please try a different model.";',
        '            const capacityError = { message: capacityMessage, codexErrorInfo: "other", additionalDetails: null };',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: capacityError } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "model-capacity-after-activity-once" && matchingTurnStartCount === 1) {',
        '            const capacityError = { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "other", additionalDetails: null };',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "capacity_mid_turn_msg", delta: "I changed " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: capacityError } } }) + "\\n");',
        '            }, 12);',
        '            continue;',
        '        }',
        '        if (text === "top-level-failed-turn") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, id: turnId, status: "failed", error: { message: "top-level failed turn", codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "top-level-interrupted-turn") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, id: turnId, status: "interrupted" } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-structured") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", resetsAt: "2026-05-17T12:00:00.000Z", planType: "pro", rateLimits: { primary: { usedPercent: 100 } }, additionalDetails: null } } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-after-mid-turn-auth-apply") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", resetsAt: "2026-05-17T12:00:00.000Z", planType: "pro", rateLimits: { primary: { usedPercent: 100 } }, additionalDetails: null } } } }) + "\\n");',
        '            }, 150);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-then-late-raw-item") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", resetsAt: "2026-05-17T12:00:00.000Z", additionalDetails: null } } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "rawResponseItem/completed", params: { threadId: msg.params?.threadId ?? null, id: "auto-compact-1", item: { id: "auto-compact-1", type: "context_compaction" } } }) + "\\n");',
        '            }, 30);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, itemId: "late_msg_1", delta: "late output" } }) + "\\n");',
        '            }, 35);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-stable-message") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:37 PM.", codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:37 PM.", codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "refresh-token-was-already-used") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Failed to refresh token: 401 Unauthorized: Your refresh token was already used to generate a new access token.", codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "usage-limit-retry-after-only") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "Usage limit reached", codexErrorInfo: "UsageLimitExceeded", retryAfterMs: 120000, planType: "pro", rateLimits: { primary: { usedPercent: 100 } }, additionalDetails: null } } } }) + "\\n");',
        '            }, 8);',
        '            continue;',
        '        }',
        '        if (text === "rate-limit-update") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: 1779098400 }, secondary: null, credits: null, planType: "pro", rateLimitReachedType: null } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 12);',
        '            continue;',
        '        }',
        '        if (text === "rate-limit-update-sparse-after-full") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { account: { id: "acct_live_codex", email: "codex-user@example.test" }, primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1779098400 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1779698400 }, planType: "pro" } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 88 } } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 12);',
        '            continue;',
        '        }',
        '        if (text === "bridge-chatgpt-refresh") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "refresh-chatgpt-tokens", method: "account/chatgptAuthTokens/refresh", params: { chatgptPlanType: "plus" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "retry-then-failed-turn") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: true, error: { message: "temporary upstream overload", codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "account-mismatch-once" && matchingTurnStartCount === 1) {',
        '            const authAccountChangedMessage = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: authAccountChangedMessage, codexErrorInfo: "unauthorized", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: authAccountChangedMessage, codexErrorInfo: "unauthorized", additionalDetails: null } } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "context-window-exhausted-once" && matchingTurnStartCount === 1) {',
        '            const contextWindowError = { message: "upstream provider rejected the request", codexErrorInfo: "ContextWindowExceeded", additionalDetails: null };',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: contextWindowError } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: contextWindowError } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "context-window-exhausted-after-activity" && matchingTurnStartCount === 1) {',
        '            const contextWindowError = { message: "upstream provider rejected the request", codexErrorInfo: "ContextWindowExceeded", additionalDetails: null };',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "mid_turn_msg", delta: "I changed " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "mid_turn_cmd", type: "commandExecution", command: "touch changed.txt", cwd: "/repo" } } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "mid_turn_cmd", type: "commandExecution", stdout: "done", exitCode: 0 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: contextWindowError } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: contextWindowError } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "context-window-exhausted-twice" && matchingTurnStartCount <= 2) {',
        '            const contextWindowMessage = matchingTurnStartCount === 1',
        '                ? "Codex ran out of room in the model\'s context window. ORIGINAL_CONTEXT_WINDOW_FAILURE before retrying."',
        '                : "Codex ran out of room in the model\'s context window. RETRY_CONTEXT_WINDOW_FAILURE before retrying.";',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "error", params: { threadId: msg.params?.threadId ?? null, turnId, willRetry: false, error: { message: contextWindowMessage, codexErrorInfo: "other", additionalDetails: null } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId, status: "failed", error: { message: contextWindowMessage, codexErrorInfo: "other", additionalDetails: null } } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "bridge-completed-only-command-result") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "call_failed_1", type: "commandExecution", command: "mkdir -p /tmp/demo", cwd: "/repo", stderr: "Rejected(\\\\\\"rejected by user\\\\\\")", exitCode: 1 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "bridge-foreign-thread-streams") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-child", turnId: "turn-child", itemId: "child_msg", delta: "Child " } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: "thread-child", turnId: "turn-child", item: { id: "child_cmd", type: "commandExecution", command: "pwd", cwd: "/child" } } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: "thread-child", turnId: "turn-child", item: { id: "child_cmd", type: "commandExecution", stdout: "/child", exitCode: 0 } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: "thread-child", turnId: "turn-child", item: { id: "child_msg", type: "agentMessage", text: "Child final" } } }) + "\\n");',
        '            }, 9);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-child", turn: { id: "turn-child" } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "parent_msg", delta: "Parent " } }) + "\\n");',
        '            }, 11);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "parent_msg", type: "agentMessage", text: "Parent final" } } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 18);',
        '            continue;',
        '        }',
        '        if (text === "bridge-late-child-terminal") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-late-child", turnId: "turn-late-child", itemId: "late_child_msg", delta: "Child still working" } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: "thread-late-child", turnId: "turn-late-child", item: { id: "late_child_msg", type: "agentMessage", text: "Child still working" } } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 15);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-late-child", turn: { id: "turn-late-child" } } }) + "\\n");',
        '            }, 180);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-late-child", turn: { id: "turn-late-child" } } }) + "\\n");',
        '            }, 190);',
        '            continue;',
        '        }',
        '        if (text === "bridge-approvals") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "cmd_approval", type: "commandExecution", command: "rm -rf /tmp/demo", cwd: "/repo" } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "approval-cmd", method: "item/commandExecution/requestApproval", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "cmd_approval", reason: "Needs approval" } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "cmd_approval", type: "commandExecution", stdout: "approved", exitCode: 0 } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "patch_approval", type: "fileChange", changes: { "src/file.ts": { hunks: 1 } } } } }) + "\\n");',
        '            }, 11);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "approval-patch", method: "item/fileChange/requestApproval", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "patch_approval", reason: "Review file edits" } }) + "\\n");',
        '            }, 12);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "patch_approval", type: "fileChange", stdout: "patched", success: true } } }) + "\\n");',
        '            }, 15);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "tool_input", type: "mcpToolCall", server: "playwright", tool: "browser_navigate", arguments: { url: "https://example.com" } } } }) + "\\n");',
        '            }, 16);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "request-input", method: "item/tool/requestUserInput", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "tool_input", questions: [{ id: "freeform_note", header: "Context", question: "Optional note", isOther: false, isSecret: false, options: [] }, { id: "tool_questions", header: "Approve tool", question: "Allow navigation?", isOther: false, isSecret: false, options: [{ label: "Approve Once", description: "Allow once" }, { label: "Deny", description: "Reject" }] }] } }) + "\\n");',
        '            }, 17);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "tool_input", type: "mcpToolCall", result: { Ok: { status: "ok" } } } } }) + "\\n");',
        '            }, 20);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 24);',
        '            continue;',
        '        }',
        '        if (text === "bridge-request-permissions") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "request-permissions", method: "item/permissions/requestApproval", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "perm_request_1", cwd: "/repo", reason: "Needs network access", permissions: { network: { enabled: true }, fileSystem: { write: ["/repo/generated"] } } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
        '            continue;',
        '        }',
        '        if (text === "bridge-user-action") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "tool_input_general", type: "mcpToolCall", server: "functions", tool: "request_user_input", arguments: {} } } }) + "\\n");',
        '            }, 6);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: "request-input-general", method: "item/tool/requestUserInput", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "tool_input_general", questions: [{ id: "export_shape", header: "Export Shape", question: "Which session export behavior should the plan target?", isOther: false, isSecret: false, options: [{ label: "Single JSON", description: "Portable JSON export" }, { label: "Single CSV", description: "Spreadsheet export" }] }] } }) + "\\n");',
        '            }, 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: "tool_input_general", type: "mcpToolCall", result: { Ok: { status: "ok" } } } } }) + "\\n");',
        '            }, 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 14);',
        '            continue;',
        '        }',
        '        if (text === "cancel-no-active") {',
        '            continue;',
        '        }',
        '        if (text === "goal-successor-during-terminal-settle" || text === "goal-successor-stream-first-during-terminal-settle" || text === "goal-successor-long-lived-during-terminal-settle") {',
        '            const successorTurnId = "turn-native-goal-successor-during-terminal-settle";',
        '            const successorStreamFirst = text === "goal-successor-stream-first-during-terminal-settle";',
        '            const successorCompletionDelayMs = text === "goal-successor-long-lived-during-terminal-settle" ? 250 : 4;',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, respondDelayMs + completionDelayMs);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: successorTurnId } } }) + "\\n");',
        '            }, respondDelayMs + completionDelayMs + (successorStreamFirst ? 3 : 1));',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, turnId: successorTurnId, itemId: "goal_successor_msg_1", delta: "Goal successor" } }) + "\\n");',
        '            }, respondDelayMs + completionDelayMs + (successorStreamFirst ? 1 : 2));',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId: successorTurnId, item: { id: "goal_successor_msg_1", type: "agentMessage", text: "Goal successor" } } }) + "\\n");',
        '            }, respondDelayMs + completionDelayMs + (successorStreamFirst ? 2 : 3));',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: successorTurnId } } }) + "\\n");',
        '            }, respondDelayMs + completionDelayMs + successorCompletionDelayMs);',
        '            continue;',
        '        }',
        '        if (text === "ignore-unknown-mismatched-turn-completion") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId + "-unknown" } } }) + "\\n");',
        '            }, respondDelayMs + 7);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: msg.params?.threadId ?? null, turnId, itemId: "mismatched_terminal_msg_1", delta: "Still owned by the active turn" } }) + "\\n");',
        '            }, respondDelayMs + 9);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/completed", params: { threadId: msg.params?.threadId ?? null, turnId, item: { id: "mismatched_terminal_msg_1", type: "agentMessage", text: "Still owned by the active turn" } } }) + "\\n");',
        '            }, respondDelayMs + 10);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, respondDelayMs + completionDelayMs);',
        '            continue;',
        '        }',
        '        if (text === "interrupt-notification-before-terminal") {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/interrupt", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/interrupted", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 60);',
        '            continue;',
        '        }',
        '        if (text === "owned-terminal-before-turn-start-response" || text === "owned-then-unknown-terminal-before-turn-start-response" || text === "unknown-then-owned-terminal-before-turn-start-response" || text === "no-id-response-unknown-before-owned-start" || text === "no-id-response-owned-terminal-before-owned-start" || text === "child-terminal-before-primary-identity-no-activity" || text === "child-terminal-after-primary-idless-activity") {',
            '            continue;',
        '        }',
        `        if (text === ${JSON.stringify(params.omitTurnCompletedForPrompt ?? null)}) continue;`,
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '        }, respondDelayMs + completionDelayMs);',
        '        continue;',
        '    }',
        '    if (msg.method === "turn/interrupt") {',
        '        interruptCount += 1;',
        `        if (${JSON.stringify(params.rejectFirstInterruptAsNoActiveTurn === true)} && interruptCount === 1) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "no active turn to interrupt" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const turnId = msg.params?.turnId ?? null;',
        `        if (${JSON.stringify(params.interruptTerminalWithoutResponse === true)}) {`,
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/interrupted", params: { threadId: msg.params?.threadId ?? null, turn: turnId ? { id: turnId } : undefined } }) + "\\n");',
        `            }, ${JSON.stringify(params.interruptTerminalDelayMs ?? 5)});`,
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/interrupted", params: { threadId: msg.params?.threadId ?? null, turn: turnId ? { id: turnId } : undefined } }) + "\\n");',
        '        }, turnId === "turn-cancel-no-active" ? 150 : 5);',
        '        continue;',
        '    }',
        '    if (msg.method === "turn/steer") {',
        '        const steerText = Array.isArray(msg.params?.input) ? String(msg.params.input[0]?.text ?? "") : "";',
        '        if (steerText === "late-no-active-steer") {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "no active turn to steer" } }) + "\\n");',
        '            }, 80);',
        '            continue;',
        '        }',
        `        if (${JSON.stringify(params.rejectSteerAsNoActiveTurn === true)}) {`,
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "no active turn to steer" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const expectedTurnId = typeof msg.params?.expectedTurnId === "string" ? msg.params.expectedTurnId : null;',
        '        const turnId = typeof msg.params?.turnId === "string" ? msg.params.turnId : null;',
        '        const selected = expectedTurnId ?? turnId;',
        `        if (${JSON.stringify(params.rejectStructuredSteerInput === true)} && Array.isArray(msg.params?.input) && msg.params.input.length > 1) {`,
        '            if (steerText === "structured-fallback-owner-change") {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: selected } } }) + "\\n");',
        '                setTimeout(() => {',
        '                    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: structured steer input unsupported" } }) + "\\n");',
        '                }, 20);',
        '            } else {',
        '                process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "invalid params: structured steer input unsupported" } }) + "\\n");',
        '            }',
        '            continue;',
        '        }',
        '        if (!selected) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "turn/steer requires expectedTurnId" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const steerResponseDelayMs = steerText === "overlap-steer" ? 250 : 0;',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, result: { turnId: selected } }) + "\\n");',
        '        }, steerResponseDelayMs);',
        '        if (typeof msg.params?.clientUserMessageId === "string" && msg.params.clientUserMessageId.length > 0) {',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { threadId: msg.params?.threadId ?? null, turnId: selected, item: { id: "steer-user-" + msg.params.clientUserMessageId, type: "userMessage", clientId: msg.params.clientUserMessageId, content: msg.params?.input ?? [] } } }) + "\\n");',
        `            }, ${JSON.stringify(params.steerUserMessageEchoDelayMs ?? 0)});`,
        '        }',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/rollback") {',
        `        const rollbackError = ${JSON.stringify(params.rollbackError ?? null)};`,
        '        if (rollbackError) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: rollbackError }) + "\\n");',
        '            continue;',
        '        }',
        '        if (typeof msg.params?.numTurns !== "number" || !Number.isFinite(msg.params.numTurns) || msg.params.numTurns < 1 || typeof msg.params?.threadId !== "string" || msg.params.threadId.length === 0) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "thread/rollback requires { threadId, numTurns >= 1 }" } }) + "\\n");',
            '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params.threadId } }) + "\\n");',
        '        continue;',
        '    }',
        '    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
        '}',
    ].join('\n');
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    return scriptPath;
}

describe('createCodexAppServerRuntime', () => {
    let envScope = createCodexAppServerTestEnvScope();
    const tempRoots = new Set<string>();

    afterEach(async () => {
        setActiveAccountSettingsSnapshot({
            source: 'none',
            settings: {} as AccountSettings,
            settingsVersion: 0,
            loadedAtMs: 0,
            settingsSecretsReadKeys: [],
        });
        envScope.restore();
        envScope = createCodexAppServerTestEnvScope();
        await Promise.all([...tempRoots].map(async (dir) => {
            await removeTempDir(dir);
        }));
        tempRoots.clear();
    });

    async function createRuntimeFixture(
        prefix: string,
        options: Readonly<{
            rollbackError?: Readonly<{
                code: number;
                message: string;
            }>;
            rejectFirstInterruptAsNoActiveTurn?: boolean;
            interruptTerminalWithoutResponse?: boolean;
            interruptTerminalDelayMs?: number;
            rejectSteerAsNoActiveTurn?: boolean;
            rejectPermissionsProfile?: boolean;
            rejectGoalMethods?: boolean;
            rejectGoalMethodsAsInvalidRequest?: boolean;
            emitGoalContinuationTurn?: boolean;
            emitGoalContinuationUsageLimitFailure?: boolean;
            emitGoalContinuationItemsBeforeStarted?: boolean;
            rejectReviewStartMethodUnavailable?: boolean;
            rejectStructuredTurnInput?: boolean;
            rejectStructuredSteerInput?: boolean;
            steerUserMessageEchoDelayMs?: number;
            emitResumeContinuationUserInputRequest?: boolean;
            emitHistoricalResumeUserInputRequestBeforeResponse?: boolean;
            emitResumeTurnStartedBeforeResponse?: boolean;
            emitResumeHistoryBoundaryNotifications?: boolean;
            emitHistoricalNotificationOnResume?: boolean;
            resumeResponseDelayMs?: number;
            resumeResponseThreadId?: string;
            threadReadResponseDelayMs?: number;
            emitIdleMcpRequestAfterThreadStart?: boolean;
            rejectPermissionsProfileAsStringShape?: boolean;
            rateLimitReadResult?: unknown;
            rateLimitReadError?: Readonly<{ code: number; message: string }>;
            rateLimitReadDelayMs?: number;
            accountReadResult?: unknown;
            rejectRateLimitRead?: boolean;
            rejectAccountRead?: boolean;
            rejectAccountReadCount?: number;
            loginStartError?: Readonly<{
                code: number;
                message: string;
            }>;
            loginStartResponseDelayMs?: number;
            rejectThreadRead?: boolean;
            requireResumeBeforeThreadRead?: boolean;
            oversizedResumePayloadChars?: number;
            omitTurnStartedForPrompt?: string;
            omitTurnCompletedForPrompt?: string;
            maxJsonLineChars?: number;
            rpcTimeoutMs?: number;
            startupRpcTimeoutMs?: number;
            resumeRecoveryTimeoutMs?: number;
        }> = {},
    ): Promise<{
        root: string;
        requestLogPath: string;
        fakeAppServer: string;
    }> {
        const root = await createTempDir(prefix);
        tempRoots.add(root);
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            requestLogPath,
            rollbackError: options.rollbackError,
            rejectFirstInterruptAsNoActiveTurn: options.rejectFirstInterruptAsNoActiveTurn,
            interruptTerminalWithoutResponse: options.interruptTerminalWithoutResponse,
            interruptTerminalDelayMs: options.interruptTerminalDelayMs,
            rejectSteerAsNoActiveTurn: options.rejectSteerAsNoActiveTurn,
            rejectPermissionsProfile: options.rejectPermissionsProfile,
            rejectGoalMethods: options.rejectGoalMethods,
            rejectGoalMethodsAsInvalidRequest: options.rejectGoalMethodsAsInvalidRequest,
            emitGoalContinuationTurn: options.emitGoalContinuationTurn,
            emitGoalContinuationUsageLimitFailure: options.emitGoalContinuationUsageLimitFailure,
            emitGoalContinuationItemsBeforeStarted: options.emitGoalContinuationItemsBeforeStarted,
            rejectReviewStartMethodUnavailable: options.rejectReviewStartMethodUnavailable,
            rejectStructuredTurnInput: options.rejectStructuredTurnInput,
            rejectStructuredSteerInput: options.rejectStructuredSteerInput,
            steerUserMessageEchoDelayMs: options.steerUserMessageEchoDelayMs,
            emitResumeContinuationUserInputRequest: options.emitResumeContinuationUserInputRequest,
            emitHistoricalResumeUserInputRequestBeforeResponse: options.emitHistoricalResumeUserInputRequestBeforeResponse,
            emitResumeTurnStartedBeforeResponse: options.emitResumeTurnStartedBeforeResponse,
            emitResumeHistoryBoundaryNotifications: options.emitResumeHistoryBoundaryNotifications,
            emitHistoricalNotificationOnResume: options.emitHistoricalNotificationOnResume,
            resumeResponseDelayMs: options.resumeResponseDelayMs,
            resumeResponseThreadId: options.resumeResponseThreadId,
            threadReadResponseDelayMs: options.threadReadResponseDelayMs,
            emitIdleMcpRequestAfterThreadStart: options.emitIdleMcpRequestAfterThreadStart,
            rejectPermissionsProfileAsStringShape: options.rejectPermissionsProfileAsStringShape,
            rateLimitReadResult: options.rateLimitReadResult,
            rateLimitReadError: options.rateLimitReadError,
            rateLimitReadDelayMs: options.rateLimitReadDelayMs,
            accountReadResult: options.accountReadResult,
            rejectRateLimitRead: options.rejectRateLimitRead,
            rejectAccountRead: options.rejectAccountRead,
            rejectAccountReadCount: options.rejectAccountReadCount,
            loginStartError: options.loginStartError,
            loginStartResponseDelayMs: options.loginStartResponseDelayMs,
            rejectThreadRead: options.rejectThreadRead,
            requireResumeBeforeThreadRead: options.requireResumeBeforeThreadRead,
            oversizedResumePayloadChars: options.oversizedResumePayloadChars,
            omitTurnStartedForPrompt: options.omitTurnStartedForPrompt,
            omitTurnCompletedForPrompt: options.omitTurnCompletedForPrompt,
        });
        envScope.patch({
            HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: String(options.rpcTimeoutMs ?? 10000),
            ...(options.startupRpcTimeoutMs ? { HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: String(options.startupRpcTimeoutMs) } : {}),
            ...(options.resumeRecoveryTimeoutMs ? { HAPPIER_CODEX_APP_SERVER_RESUME_RECOVERY_TIMEOUT_MS: String(options.resumeRecoveryTimeoutMs) } : {}),
            ...(options.maxJsonLineChars ? { HAPPIER_CODEX_APP_SERVER_MAX_JSON_LINE_CHARS: String(options.maxJsonLineChars) } : {}),
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            CODEX_API_KEY: undefined,
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: undefined,
            [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: undefined,
            [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: undefined,
        });
        return { root, requestLogPath, fakeAppServer };
    }

    async function readRequestLog(requestLogPath: string): Promise<Array<{ id: unknown; method: string; params: unknown; result: unknown; error: unknown }>> {
        return (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    }

    it('allows app-server startup when Codex credentials are missing so the backend can surface auth errors itself', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-auth-missing-');

        envScope.patch({
            OPENAI_API_KEY: '',
            CODEX_API_KEY: '',
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'acceptEdits',
        });

        await expect(runtime.startOrLoad({})).resolves.toBeUndefined();

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ method: 'initialize' }),
                expect.objectContaining({ method: 'thread/start' }),
            ]),
        );
    });

    it('keeps a new app-server thread provisional until the first provider turn is accepted', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-start-');

        let metadata: Record<string, unknown> = { machineId: 'machine_1' };
        const updateMetadata = vi.fn((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
            metadata = updater(metadata);
            return metadata;
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
            permissionMode: 'acceptEdits',
        });

        await runtime.startOrLoad({});

        expect(runtime.getSessionId()).toBe('thread-started');
        expect(runtime.getPublishedSessionId()).toBeNull();
        expect(updateMetadata).toHaveBeenCalled();
        expect(updateMetadata.mock.results.map((result) => result.value)).not.toContainEqual(
            expect.objectContaining({ codexSessionId: 'thread-started' }),
        );
        expect(updateMetadata.mock.results.map((result) => result.value)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                [SESSION_MODELS_STATE_KEY]: expect.objectContaining({
                    currentModelId: 'gpt-5.4',
                    availableModels: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'gpt-5.4',
                            modelOptions: expect.arrayContaining([
                                expect.objectContaining({ id: 'reasoning_effort', currentValue: 'medium' }),
                            ]),
                        }),
                    ]),
                }),
            }),
            expect.objectContaining({
                [SESSION_MODES_STATE_KEY]: expect.objectContaining({
                    v: 1,
                    provider: 'codex',
                    currentModeId: 'default',
                    availableModes: expect.arrayContaining([
                        expect.objectContaining({ id: 'default', name: 'Default' }),
                        expect.objectContaining({ id: 'plan', name: 'Plan' }),
                    ]),
                }),
            }),
        ]));

        await runtime.sendPrompt('publish-after-provider-acceptance');

        expect(runtime.getPublishedSessionId()).toBe('thread-started');
        expect(updateMetadata.mock.results.map((result) => result.value)).toContainEqual(
            expect.objectContaining({
                codexSessionId: 'thread-started',
                codexBackendMode: 'appServer',
            }),
        );
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/start',
                    params: expect.objectContaining({
                        cwd: root,
                        permissions: {
                            type: 'profile',
                            id: ':workspace',
                        },
                        experimentalRawEvents: true,
                        persistExtendedHistory: true,
                    }),
                }),
                expect.objectContaining({ method: 'collaborationMode/list' }),
                expect.objectContaining({ method: 'model/list' }),
            ]),
        );
    });

    it('starts safe-yolo app-server threads with auto-reviewer approvals instead of disabling approvals', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-safe-yolo-start-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'safe-yolo',
        });

        await runtime.startOrLoad({});

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/start',
                    params: expect.objectContaining({
                        permissions: {
                            type: 'profile',
                            id: ':workspace',
                        },
                    }),
                }),
            ]),
        );
        const startRequest = requestLog.find((entry: { method: string }) => entry.method === 'thread/start') as { params?: Record<string, unknown> } | undefined;
        expect(startRequest?.params).not.toHaveProperty('sandbox');
        expect(startRequest?.params).not.toHaveProperty('approvalPolicy');
        expect(startRequest?.params).not.toHaveProperty('approvalsReviewer');
    });

    it('falls back to legacy app-server permission fields after older Codex rejects permission profiles', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-permission-fallback-', {
            rejectPermissionsProfile: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('legacy-fallback');

        const requestLog = await readRequestLog(requestLogPath);
        const startRequests = requestLog.filter((entry) => entry.method === 'thread/start') as Array<{ params?: Record<string, unknown> }>;
        expect(startRequests).toHaveLength(2);
        expect(startRequests[0]?.params).toMatchObject({
            permissions: {
                type: 'profile',
                id: ':read-only',
            },
        });
        expect(startRequests[0]?.params).not.toHaveProperty('sandbox');
        expect(startRequests[1]?.params).toMatchObject({
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
        expect(startRequests[1]?.params).not.toHaveProperty('permissions');

        const turnStart = requestLog.find((entry) => entry.method === 'turn/start') as { params?: Record<string, unknown> } | undefined;
        expect(turnStart?.params).toMatchObject({
            approvalPolicy: 'never',
            sandboxPolicy: {
                type: 'readOnly',
            },
        });
        expect(turnStart?.params).not.toHaveProperty('permissions');
    });

    it('falls back to legacy app-server permission fields when older Codex expects a string profile id', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-permission-string-fallback-', {
            rejectPermissionsProfileAsStringShape: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});

        const requestLog = await readRequestLog(requestLogPath);
        const startRequests = requestLog.filter((entry) => entry.method === 'thread/start') as Array<{ params?: Record<string, unknown> }>;
        expect(startRequests).toHaveLength(2);
        expect(startRequests[0]?.params).toMatchObject({
            permissions: {
                type: 'profile',
                id: ':read-only',
            },
        });
        expect(startRequests[1]?.params).toMatchObject({
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
        expect(startRequests[1]?.params).not.toHaveProperty('permissions');
    });

    it('publishes connected-service direct-session metadata when activeServerDir owns CODEX_HOME', async () => {
        const { root, requestLogPath, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-direct-');
        const scopedEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            HAPPIER_TRANSCRIPT_STORAGE: 'direct',
            CODEX_HOME: join(root, 'servers', 'cloud', 'daemon', 'connected-services', 'homes', 'openai-codex', 'profile', 'codex', 'codex-home'),
        });
        const codexHomeDir = scopedEnv.CODEX_HOME;
        if (!codexHomeDir) {
            throw new Error('Expected CODEX_HOME to be set for codex app-server runtime test');
        }
        await mkdir(codexHomeDir, { recursive: true });

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            activeServerDir: join(root, 'servers', 'cloud'),
            processEnv: scopedEnv,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('publish-direct-session-after-provider-acceptance');

        expect(updateMetadata.mock.results.map((result) => result.value)).toContainEqual(
            expect.objectContaining({
                directSessionV1: expect.objectContaining({
                    source: expect.objectContaining({
                        kind: 'codexHome',
                        home: 'connectedService',
                        connectedServiceId: 'openai-codex',
                        connectedServiceProfileId: 'profile',
                    }),
                }),
            }),
        );
    });

    it('loads an existing app-server thread with resume even when history import is disabled', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-', {
            requireResumeBeforeThreadRead: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({ resumeId: 'resume-123', importHistory: false });
        await runtime.startOrLoad({ existingSessionId: 'existing-456', importHistory: false });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/read')).toEqual([]);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/resume')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'resume-123',
                        cwd: root,
                        persistExtendedHistory: true,
                        excludeTurns: true,
                    }),
                }),
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'existing-456',
                        cwd: root,
                        persistExtendedHistory: true,
                        excludeTurns: true,
                    }),
                }),
            ]),
        );
    });

    it('rejects an explicitly different resumed thread before publishing either identity', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-mismatch-', {
            resumeResponseThreadId: 'thread-other',
        });
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ codexSessionId: 'resume-requested' }),
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
            permissionMode: 'read-only',
        });

        await expect(runtime.startOrLoad({
            resumeId: 'resume-requested',
            strictNativeResumeIdentity: true,
            importHistory: false,
        }))
            .rejects.toMatchObject({
                name: 'CodexAppServerResumeIdentityMismatchError',
                happierNativeResumeIdentityMismatch: true,
            });
        expect(runtime.getSessionId()).toBeNull();
        expect(updateMetadata.mock.results.map((result) => result.value)).not.toContainEqual(
            expect.objectContaining({ codexSessionId: 'resume-requested' }),
        );
    });

    it('hydrates authoritative thread history after an oversized resume response', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-oversized-', {
            requireResumeBeforeThreadRead: true,
            oversizedResumePayloadChars: 4 * 1024,
            maxJsonLineChars: 1024,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({ resumeId: 'resume-123' });

        expect(runtime.getSessionId()).toBe('resume-123');
        const requestLog = await readRequestLog(requestLogPath);
        const resumeIndex = requestLog.findIndex((entry) => entry.method === 'thread/resume');
        const readIndex = requestLog.findIndex((entry) => entry.method === 'thread/read');
        expect(resumeIndex).toBeGreaterThanOrEqual(0);
        expect(readIndex).toBeGreaterThan(resumeIndex);
        expect(requestLog[readIndex]).toMatchObject({
            method: 'thread/read',
            params: {
                threadId: 'resume-123',
                includeTurns: true,
            },
        });
    });

    it('waits beyond the normal startup timeout for authoritative oversized-resume recovery', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-delayed-oversized-', {
            requireResumeBeforeThreadRead: true,
            resumeResponseDelayMs: 500,
            oversizedResumePayloadChars: 4 * 1024,
            maxJsonLineChars: 1024,
            rpcTimeoutMs: 250,
            startupRpcTimeoutMs: 1000,
            resumeRecoveryTimeoutMs: 1200,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({ resumeId: 'resume-slow' });

        expect(runtime.getSessionId()).toBe('resume-slow');
        const requestLog = await readRequestLog(requestLogPath);
        const resumeIndex = requestLog.findIndex((entry) => entry.method === 'thread/resume');
        const readIndex = requestLog.findIndex((entry) => entry.method === 'thread/read');
        expect(resumeIndex).toBeGreaterThanOrEqual(0);
        expect(readIndex).toBeGreaterThan(resumeIndex);
        expect(requestLog[readIndex]).toMatchObject({
            method: 'thread/read',
            params: {
                threadId: 'resume-slow',
                includeTurns: true,
            },
        });
    });

    it('uses the resume recovery timeout for authoritative history reads after oversized resumes', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-oversized-delayed-read-', {
            requireResumeBeforeThreadRead: true,
            threadReadResponseDelayMs: 500,
            oversizedResumePayloadChars: 4 * 1024,
            maxJsonLineChars: 1024,
            rpcTimeoutMs: 250,
            // Initialization is not the behavior under test and can exceed the normal
            // RPC budget on a loaded development machine. Keep the ordinary RPC timeout
            // below the delayed thread/read response while giving startup its own budget.
            startupRpcTimeoutMs: 1000,
            resumeRecoveryTimeoutMs: 1200,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({ resumeId: 'resume-slow-read' });

        expect(runtime.getSessionId()).toBe('resume-slow-read');
        const requestLog = await readRequestLog(requestLogPath);
        const resumeIndex = requestLog.findIndex((entry) => entry.method === 'thread/resume');
        const readIndex = requestLog.findIndex((entry) => entry.method === 'thread/read');
        expect(resumeIndex).toBeGreaterThanOrEqual(0);
        expect(readIndex).toBeGreaterThan(resumeIndex);
        expect(requestLog[readIndex]).toMatchObject({
            method: 'thread/read',
            params: {
                threadId: 'resume-slow-read',
                includeTurns: true,
            },
        });
    });

    it('resumes an existing app-server thread with full history when history import is requested', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-history-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({ resumeId: 'resume-123', importHistory: true });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/read')).toEqual([]);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/resume')).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'resume-123',
                        permissions: {
                            type: 'profile',
                            id: ':read-only',
                        },
                        persistExtendedHistory: true,
                        excludeTurns: false,
                    }),
                }),
            ]),
        );
    });

    it('publishes the requested resume thread id before delayed app-server history hydration completes', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-delayed-', {
            resumeResponseDelayMs: 500,
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (updater: (current: Metadata) => Metadata) => {
            metadata = updater(metadata);
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
            permissionMode: 'read-only',
        });

        let settled = false;
        const startPromise = runtime.startOrLoad({ resumeId: 'resume-slow' })
            .finally(() => {
                settled = true;
            });

        try {
            await waitForCondition(
                () => metadata.codexSessionId === 'resume-slow',
                {
                    timeoutMs: 200,
                    intervalMs: 20,
                    label: 'resume metadata to publish before app-server history hydration completes',
                    debug: () => JSON.stringify({ metadata, settled }),
                },
            );
            expect(settled).toBe(false);
            expect(metadata).toMatchObject({
                codexSessionId: 'resume-slow',
                codexBackendMode: 'appServer',
                agentRuntimeDescriptorV1: expect.objectContaining({
                    providerId: 'codex',
                    provider: expect.objectContaining({
                        backendMode: 'appServer',
                        vendorSessionId: 'resume-slow',
                    }),
                }),
            });
        } finally {
            await startPromise;
        }
    });

    it('drains accepted pending queue rows after resuming an app-server thread', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-pending-');
        const drainPending = vi.fn(async () => ({ materialized: 1, stoppedReason: 'no_pending' as const }));

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
            pendingQueue: {
                drainAfterStartOrLoad: true,
                drainPending,
            },
        });

        await runtime.startOrLoad({ resumeId: 'resume-123', importHistory: false });

        expect(runtime.getSessionId()).toBe('resume-123');
        expect(drainPending).toHaveBeenCalledWith({
            logPrefix: '[CodexAppServer]',
            reason: 'startOrLoad',
        });
    });

    it('sets an initial resume goal before draining pending queue rows', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-initial-goal-');
        const drainPending = vi.fn(async () => ({ materialized: 1, stoppedReason: 'no_pending' as const }));

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
            pendingQueue: {
                drainAfterStartOrLoad: true,
                drainPending,
            },
        });

        await runtime.startOrLoad({
            resumeId: 'resume-123',
            importHistory: false,
            initialGoal: {
                objective: 'Line one\nLine two',
            },
        } as any);

        expect(drainPending).toHaveBeenCalledWith({
            logPrefix: '[CodexAppServer]',
            reason: 'startOrLoad',
        });
        const requestLog = await readRequestLog(requestLogPath);
        const resumeIndex = requestLog.findIndex((entry) => entry.method === 'thread/resume');
        const goalSetIndex = requestLog.findIndex((entry) => entry.method === 'thread/goal/set');
        expect(resumeIndex).toBeGreaterThanOrEqual(0);
        expect(goalSetIndex).toBeGreaterThan(resumeIndex);
        expect(requestLog[goalSetIndex]).toMatchObject({
            method: 'thread/goal/set',
            params: {
                threadId: 'resume-123',
                objective: 'Line one\nLine two',
            },
        });
    });

    it('sends prompts over the persistent client and waits for turn completion notifications', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-turn-');

        const onThinkingChange = vi.fn();
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('hello-world');

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({
            provider: 'codex',
        }));
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'turn-hello-world',
        });
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(1);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/start')).toHaveLength(1);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/start')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    input: [{ type: 'text', text: 'hello-world' }],
                    permissions: {
                        type: 'profile',
                        id: ':read-only',
                    },
                }),
            }),
        ]);
        const turnStart = requestLog.find((entry: { method: string }) => entry.method === 'turn/start') as { params?: Record<string, unknown> } | undefined;
        expect(turnStart?.params).not.toHaveProperty('sandboxPolicy');
        expect(turnStart?.params).not.toHaveProperty('approvalPolicy');
    });

    it.each([
        ['turn-ledger', true],
        ['legacy', false],
    ] as const)('cancels a pending usage-limit recovery intent on normal turn completion (%s path)', async (_label, useTurnLedger) => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-turn-usage-limit-cancel-');

        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            // nextCheckAtMs far in the future so the scheduler's own wake timer cannot
            // probe-and-cancel during the test; only normal turn completion may cancel.
            [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
                v: 1,
                status: 'waiting',
                issueFingerprint: 'usage-limit:codex:turn-old:1:2',
                armedAtMs: Date.now(),
                resetAtMs: Date.now() + 3_600_000,
                nextCheckAtMs: Date.now() + 3_600_000,
                attemptCount: 0,
                maxAttempts: 3,
                lastProbeError: null,
                resumePromptMode: 'standard',
                selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
            },
        } as unknown as Metadata;
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_handoff',
                accountLabel: 'handoff@example.test',
                profileId: 'handoff-profile',
                groupId: 'handoff-group',
                generation: 1,
                credentialFingerprint: 'sha256:handoff0',
                source: 'spawn_selection',
            },
            session: {
                sessionId: 'session-usage-limit-cancel',
                updateMetadata,
                getMetadataSnapshot: () => metadata,
                ...(useTurnLedger ? { sessionTurnLifecycle: createSessionTurnLifecycleTestDouble() } : {}),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('hello-world');

        expect((metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]).toMatchObject({
            status: 'cancelled',
        });
    });

    it('does not report an active provider turn before native Codex starts one', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-preflight-turn-');

        const onThinkingChange = vi.fn();
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        runtime.beginTurn();

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.canSteerPrompt()).toBe(false);
        expect(onThinkingChange).not.toHaveBeenCalledWith(true);
        expect(sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
    });

    it('does not fail completed prompts when primary turn status persistence fails', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-turn-status-failure-');

        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble({
            completeTurn: vi.fn(async () => {
                throw new Error('status persistence unavailable');
            }),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});

        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        try {
            await expect(Promise.race([
                runtime.sendPrompt('hello-world'),
                new Promise((_resolve, reject) => {
                    settleTimer = setTimeout(() => reject(new Error('sendPrompt did not settle')), 1000);
                }),
            ])).resolves.toBeUndefined();
        } finally {
            if (settleTimer) {
                clearTimeout(settleTimer);
            }
        }
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({
            provider: 'codex',
        }));
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'turn-hello-world',
        });
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });
    });

    it('does not write a completed projection when flushing after a failed turn already cleared pending state', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-failed-flush-');

        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await expect(runtime.sendPrompt('failed-turn')).rejects.toThrow(/unauthorized/i);
        await runtime.flushTurn();

        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.cancelTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-failed-turn',
        }));
    });

    it('treats top-level failed turn/completed status as a failed Codex turn', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-top-level-failed-turn-');

        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await expect(runtime.sendPrompt('top-level-failed-turn')).rejects.toThrow(/top-level failed turn/);

        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-top-level-failed-turn',
        }));
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('treats top-level interrupted turn/completed status as a cancelled Codex turn', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-top-level-interrupted-turn-');

        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('top-level-interrupted-turn');

        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'turn-top-level-interrupted-turn',
        });
        expect(sessionTurnLifecycle.cancelTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
        }));
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('does not adopt late raw response items as new turns after app-server usage-limit failure', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-late-raw-after-usage-limit-');

        const onThinkingChange = vi.fn();
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await expect(runtime.sendPrompt('usage-limit-then-late-raw-item')).rejects.toMatchObject({
            runtimeAuthClassification: expect.objectContaining({ kind: 'usage_limit' }),
        });
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
        }));
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'turn-usage-limit-then-late-raw-item',
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-usage-limit-then-late-raw-item',
        }));
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('uses the structured turn input builder for text, mentions, skills, and image attachments', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-structured-input-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });
        const uploadedPath = '.happier/uploads/messages/m1/screenshot.png';
        const uploadedContent = Buffer.from('fake screenshot');
        const sha256 = createHash('sha256').update(uploadedContent).digest('hex');
        await mkdir(join(root, '.happier', 'uploads', 'messages', 'm1'), { recursive: true });
        await writeFile(join(root, uploadedPath), uploadedContent);

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            sendPrompt: (prompt: string, options?: { metadata?: Record<string, unknown> }) => Promise<void>;
        }).sendPrompt('structured-input', {
            metadata: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            {
                                path: uploadedPath,
                                mimeType: 'image/png',
                                sizeBytes: uploadedContent.byteLength,
                                sha256,
                            },
                        ],
                    },
                },
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
                    ],
                    skillMentions: [
                        { name: 'debugger', path: '/skills/debugger/SKILL.md' },
                    ],
                    attachments: [
                        {
                            kind: 'image',
                            localPath: uploadedPath,
                            path: uploadedPath,
                            sha256,
                            provenance: { kind: 'sessionAttachmentUpload' },
                        },
                        { mimeType: 'image/png', url: 'https://example.test/image.png' },
                    ],
                },
            },
        });

        const requestLog = await readRequestLog(requestLogPath);
        const turnStart = requestLog.find((entry) => entry.method === 'turn/start') as { params?: Record<string, unknown> } | undefined;
        expect(turnStart?.params).toMatchObject({
            input: [
                { type: 'text', text: 'structured-input' },
                { type: 'mention', name: 'Reviewer', path: 'plugin://reviewer@codex' },
                { type: 'skill', name: 'debugger', path: '/skills/debugger/SKILL.md' },
                { type: 'localImage', path: uploadedPath },
                { type: 'image', url: 'https://example.test/image.png' },
            ],
        });
    });

    it('sends native reviews over review/start and waits for completion', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-review-start-');

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'Review current changes',
            },
        });

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
        expect(requestLog.filter((entry) => entry.method === 'review/start')).toEqual([
            expect.objectContaining({
                params: {
                    threadId: 'thread-started',
                    target: {
                        type: 'custom',
                        instructions: 'Review current changes',
                    },
                    delivery: 'inline',
                },
            }),
        ]);
    });

    it('rejects prompts while a native review turn is pending', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-review-pending-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const reviewPromise = (runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'delayed-review',
            },
        });
        await waitForCondition(() => runtime.isTurnInFlight(), {
            timeoutMs: 2_000,
            intervalMs: 1,
            label: 'native review enters active control turn',
        });

        expect(runtime.canSteerPrompt()).toBe(false);
        await expect(runtime.steerPrompt('must-remain-queued-during-native-review')).rejects.toThrow(/not steerable/i);
        await expect(runtime.sendPrompt('second prompt')).rejects.toThrow(/turn in flight/);
        await reviewPromise;
    });

    it('clears native review pending state after invalid request failures', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-review-invalid-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        await expect((runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'invalid-review-input',
            },
        })).rejects.toThrow(/review target is invalid/);
        await runtime.sendPrompt('after-review-failure');

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'review/start')).toHaveLength(1);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toHaveLength(1);
    });

    it('returns an unsupported result when native review/start is unavailable', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-review-unsupported-', {
            rejectReviewStartMethodUnavailable: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        await expect((runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'Review current changes',
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: 'unsupported_session_runtime_method:review/start',
        });
    });

    it('syncs native app-server goals through goal RPCs and sessionWorkStateV1 metadata', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-');

        let metadataSnapshot: Record<string, unknown> = {
            keep: 'yes',
            sessionWorkStateV1: {
                v: 1,
                backendId: 'codex',
                updatedAt: 1,
                items: [
                    { id: 'todo:other:1', kind: 'todo', origin: 'vendor', status: 'active', title: 'Keep me', updatedAt: 1 },
                ],
                primaryItemId: 'todo:other:1',
            },
        };
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            metadataSnapshot = updater(metadataSnapshot);
            return metadataSnapshot;
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            setGoal: (objective: string, options?: { status?: string; tokenBudget?: number | null }) => Promise<void>;
        }).setGoal('Finish native goal wiring', { status: 'paused', tokenBudget: 1200 });
        await (runtime as unknown as { clearGoal: () => Promise<void> }).clearGoal();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/get',
                params: { threadId: 'thread-started' },
            }),
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-started',
                    objective: 'Finish native goal wiring',
                    status: 'paused',
                    tokenBudget: 1200,
                },
            }),
            expect.objectContaining({
                method: 'thread/goal/clear',
                params: { threadId: 'thread-started' },
            }),
        ]));
        expect(metadataSnapshot.keep).toBe('yes');
        const workState = metadataSnapshot.sessionWorkStateV1 as { items?: Array<{ id?: string; title?: string }> };
        expect(workState.items).toEqual([
            expect.objectContaining({ id: 'todo:other:1', title: 'Keep me' }),
        ]);
        expect(updateMetadata).toHaveBeenCalledWith(expect.any(Function));
    });

    it('sends live status-only goal mutations without starting a turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-status-only-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            setGoal: (objective: string | undefined, options?: { status?: string }) => Promise<void>;
        }).setGoal(undefined, { status: 'paused' });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-started',
                    status: 'paused',
                },
            }),
        ]));
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
        expect(sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
    });

    it('rejects unsupported generic goal statuses before calling native goal set', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-invalid-status-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await expect((runtime as unknown as {
            setGoal: (objective: string | undefined, options?: { status?: string }) => Promise<unknown>;
        }).setGoal(undefined, { status: 'blocked' })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_goal_status',
            error: 'invalid_goal_status',
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/goal/set')).toEqual([]);
    });

    it('sends live budget-only goal mutations without starting a turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-budget-only-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            setGoal: (objective: string | undefined, options?: { tokenBudget?: number | null }) => Promise<void>;
        }).setGoal(undefined, { tokenBudget: null });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-started',
                    tokenBudget: null,
                },
            }),
        ]));
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
        expect(sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
    });

    it('adopts native app-server goal continuation turns and bridges their stream events', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-continuation-', {
            emitGoalContinuationTurn: true,
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
            sessionTurnLifecycle,
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as { setGoal: (objective: string) => Promise<void> }).setGoal('Continue autonomously');

        await waitForCondition(() => {
            const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
                [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
            >;
            const assistantText = committedCalls
                .filter(([, body]) => body.type === 'message')
                .map(([, body]) => String(body.message ?? ''))
                .join('');
            return assistantText.includes('Goal continuation');
        }, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'native Codex goal continuation transcript event',
        });

        expect(session.sendCodexMessage.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({ type: 'tool-call', callId: 'goal_cmd_1', name: 'CodexBash', input: { command: 'git status', cwd: '/repo' } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'goal_cmd_1', output: { stdout: 'clean', exitCode: 0 } })],
            ]),
        );
        await waitForCondition(() => vi.mocked(sessionTurnLifecycle.completeTurn).mock.calls.length > 0, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'native Codex goal continuation lifecycle completion',
        });
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-goal-continuation',
        }));
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });
        expect(sessionTurnLifecycle.markRollbackEligible).not.toHaveBeenCalled();
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
    });

    it.each([
        ['turn-start first', 'goal-successor-during-terminal-settle'],
        ['stream first', 'goal-successor-stream-first-during-terminal-settle'],
    ] as const)('hands off a completed tracked turn to an immediate same-thread goal successor (%s)', async (_order, prompt) => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-successor-handoff-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
            sessionTurnLifecycle,
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        const initialTurn = runtime.sendPrompt(prompt);
        await (runtime as unknown as { setGoal: (objective: string) => Promise<void> }).setGoal('Continue autonomously');
        await initialTurn;

        await waitForCondition(() => {
            const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
                [string, { type?: string; message?: string }, { localId: string }]
            >;
            return committedCalls.some(([, body]) => (
                body.type === 'message' && String(body.message ?? '').includes('Goal successor')
            ));
        }, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'same-thread goal successor transcript event',
        });
        await waitForCondition(() => vi.mocked(sessionTurnLifecycle.completeTurn).mock.calls.length === 2, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'both predecessor and goal successor lifecycle completions',
            debug: () => JSON.stringify({
                beginTurnCalls: vi.mocked(sessionTurnLifecycle.beginTurn).mock.calls,
                completeTurnCalls: vi.mocked(sessionTurnLifecycle.completeTurn).mock.calls,
                turnInFlight: runtime.isTurnInFlight(),
            }),
        });

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(2);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenLastCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-native-goal-successor-during-terminal-settle',
        }));
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('fences fresh prompts during handoff and permits explicit steering once the regular successor starts', async () => {
        const { root, requestLogPath, fakeAppServer } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-goal-successor-atomic-handoff-',
        );
        let releasePredecessorCompletion!: () => void;
        const predecessorCompletionGate = new Promise<void>((resolve) => {
            releasePredecessorCompletion = resolve;
        });
        let completionCount = 0;
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble({
            completeTurn: vi.fn(async () => {
                completionCount += 1;
                if (completionCount === 1) await predecessorCompletionGate;
            }),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                    kind: 'group',
                    serviceId: 'openai-codex',
                    groupId: 'handoff-group',
                    activeProfileId: 'handoff-profile',
                    fallbackProfileId: 'handoff-fallback',
                    generation: 1,
                }]),
            }),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_handoff',
                accountLabel: null,
                profileId: 'handoff-profile',
                groupId: 'handoff-group',
                generation: 1,
                credentialFingerprint: 'sha256:handoff1',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        const initialTurn = runtime.sendPrompt('goal-successor-during-terminal-settle');
        await (runtime as unknown as { setGoal: (objective: string) => Promise<void> }).setGoal('Continue autonomously');
        await waitForCondition(() => completionCount === 1, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'predecessor lifecycle completion enters handoff gate',
        });
        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            requireExactProof: true,
        })).resolves.toMatchObject({
            ok: true,
            runtime: {
                inProviderTurn: true,
                safeToApply: true,
            },
        });
        await expect((runtime as any).rollbackConversation({
            v: 1,
            target: { type: 'latest_turn' },
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'turn_in_flight',
        });

        const competingPrompt = runtime.sendPrompt('must-not-start-during-native-handoff');
        competingPrompt.catch(() => undefined);
        try {
            await new Promise((resolve) => setTimeout(resolve, 25));
            const requestLog = await readRequestLog(requestLogPath);
            const competingTurnStarts = requestLog.filter((entry) => {
                if (entry.method !== 'turn/start') return false;
                const input = (entry.params as { input?: Array<{ text?: unknown }> } | null)?.input;
                return input?.[0]?.text === 'must-not-start-during-native-handoff';
            });
            expect(competingTurnStarts).toHaveLength(0);
        } finally {
            releasePredecessorCompletion();
        }

        await initialTurn;
        // The initiating prompt owns exactly the predecessor turn. Its caller must preserve the
        // runtime while the separately-owned native successor is active.
        expect(runtime.hasActiveProviderTurn()).toBe(true);
        expect(runtime.canSteerPrompt()).toBe(true);
        await runtime.steerPrompt('explicit-steer-into-native-goal-successor');
        const requestLogAfterSteer = await readRequestLog(requestLogPath);
        expect(requestLogAfterSteer).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'turn/steer',
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-native-goal-successor-during-terminal-settle',
                    input: expect.arrayContaining([
                        expect.objectContaining({ text: 'explicit-steer-into-native-goal-successor' }),
                    ]),
                }),
            }),
        ]));
        await expect(competingPrompt).rejects.toThrow(/turn in flight/i);
        await waitForCondition(() => vi.mocked(sessionTurnLifecycle.completeTurn).mock.calls.length === 2, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'native successor completes after atomic handoff',
        });
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(2);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('does not resurrect a native successor when reset disposes the runtime during handoff', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-goal-successor-reset-handoff-',
        );
        let releasePredecessorCompletion!: () => void;
        const predecessorCompletionGate = new Promise<void>((resolve) => {
            releasePredecessorCompletion = resolve;
        });
        let completionCount = 0;
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble({
            completeTurn: vi.fn(async () => {
                completionCount += 1;
                if (completionCount === 1) await predecessorCompletionGate;
            }),
        });
        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        const initialTurn = runtime.sendPrompt('goal-successor-during-terminal-settle');
        await (runtime as unknown as { setGoal: (objective: string) => Promise<void> }).setGoal('Continue autonomously');
        await waitForCondition(() => completionCount === 1, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'predecessor completion enters reset handoff gate',
        });

        const reset = runtime.reset();
        await new Promise((resolve) => setTimeout(resolve, 20));
        releasePredecessorCompletion();
        await Promise.all([reset, initialTurn]);
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(runtime.getSessionId()).toBeNull();
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
    });

    it('adopts native app-server goal continuation turns from same-thread stream events', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-continuation-stream-first-', {
            emitGoalContinuationTurn: true,
            emitGoalContinuationItemsBeforeStarted: true,
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
            sessionTurnLifecycle,
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as { setGoal: (objective: string) => Promise<void> }).setGoal('Continue autonomously');

        await waitForCondition(() => {
            const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
                [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
            >;
            const assistantText = committedCalls
                .filter(([, body]) => body.type === 'message')
                .map(([, body]) => String(body.message ?? ''))
                .join('');
            return assistantText.includes('Goal continuation');
        }, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'stream-first native Codex goal continuation transcript event',
        });

        await waitForCondition(() => vi.mocked(sessionTurnLifecycle.completeTurn).mock.calls.length > 0, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'stream-first native Codex goal continuation lifecycle completion',
        });
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-goal-continuation',
        }));
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
    });

    it('adopts resumed native app-server turns from server requests before terminal notifications', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-request-continuation-', {
            emitResumeContinuationUserInputRequest: true,
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({
                decision: 'approved',
                answers: { resume_question: ['yes'] },
            }),
        };

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionHandler: permissionHandler as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({ resumeId: 'thread-resume-active' });
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'resume_tool_input',
            'AskUserQuestion',
            expect.objectContaining({
                questions: [
                    expect.objectContaining({ question: 'Continue?' }),
                ],
            }),
        );
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-resume-request',
        }));
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'resume-request-input',
                params: null,
                result: {
                    answers: {
                        resume_question: {
                            answers: ['yes'],
                        },
                    },
                },
                error: null,
            }),
        ]));
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
    });

    it('declines historical server requests received before resume history hydration', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-resume-historical-request-',
            { emitHistoricalResumeUserInputRequestBeforeResponse: true },
        );
        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValue({
                decision: 'approved',
                answers: { resume_question_history: ['yes'] },
            }),
        };
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionHandler: permissionHandler as any,
        });

        await runtime.startOrLoad({ resumeId: 'thread-resume-historical-request' });
        await waitForCondition(async () => {
            const requestLog = await readRequestLog(requestLogPath);
            return requestLog.some((entry) => entry.id === 'resume-request-input-history');
        }, {
            timeoutMs: 500,
            intervalMs: 5,
            label: 'historical resume request denial',
        });

        expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'resume-request-input-history',
                result: { answers: {} },
                error: null,
            }),
        ]));
    });

    it('preserves provider-adopted resumed turns that start before thread resume responds', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-start-before-response-', {
            emitResumeTurnStartedBeforeResponse: true,
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const onThinkingChange = vi.fn();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'default',
        });

        try {
            await runtime.startOrLoad({ resumeId: 'thread-resume-active' });

            expect(runtime.hasActiveProviderTurn()).toBe(true);
            expect(runtime.isTurnInFlight()).toBe(true);
            expect(onThinkingChange).toHaveBeenCalledWith(true);
            expect(onThinkingChange).not.toHaveBeenCalledWith(false);
            expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
            expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
                provider: 'codex',
                providerTurnId: 'turn-resume-start-before-response',
            }));
            expect(sessionTurnLifecycle.cancelTurn).not.toHaveBeenCalled();
            expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();

            const requestLog = await readRequestLog(requestLogPath);
            expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
        } finally {
            await runtime.reset();
        }
    });

    it('rejects historical resume notifications while releasing one genuinely live buffered turn after history hydration', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-resume-history-boundary-',
            { emitResumeHistoryBoundaryNotifications: true },
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const onThinkingChange = vi.fn();
        const sendAgentMessageCommitted = vi.fn(async (
            _provider: string,
            _body: { type?: string; message?: string },
        ) => {});

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted,
                sendCodexMessage: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({ resumeId: 'thread-resume-history-boundary' });
        await waitForCondition(() => runtime.isTurnInFlight() === false, {
            timeoutMs: 1_000,
            intervalMs: 2,
            label: 'genuinely live buffered resume turn completion',
        });

        await runtime.startOrLoad({ resumeId: 'thread-resume-history-boundary-second-attach' });
        await waitForCondition(() => vi.mocked(sessionTurnLifecycle.completeTurn).mock.calls.length === 2, {
            timeoutMs: 1_000,
            intervalMs: 2,
            label: 'genuinely live buffered second resume turn completion',
        });

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(2);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            providerTurnId: 'turn-resume-live',
        }));
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(2);
        expect(onThinkingChange).toHaveBeenCalledTimes(4);
        expect(onThinkingChange).toHaveBeenNthCalledWith(1, true);
        expect(onThinkingChange).toHaveBeenNthCalledWith(2, false);
        expect(onThinkingChange).toHaveBeenNthCalledWith(3, true);
        expect(onThinkingChange).toHaveBeenNthCalledWith(4, false);

        const committedAssistantMessages = sendAgentMessageCommitted.mock.calls
            .map(([, body]) => body)
            .filter((body) => body?.type === 'message')
            .map((body) => body.message);
        expect(committedAssistantMessages).toContain('Genuinely live');
        expect(committedAssistantMessages).not.toContain('Historical replay');

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toEqual([]);
    });

    it('returns stable unsupported results when app-server goal methods are unavailable', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-unsupported-', {
            rejectGoalMethods: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        const expected = {
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: 'unsupported_session_runtime_method:session.goal.set',
        };

        await expect((runtime as unknown as {
            setGoal: (objective: string) => Promise<unknown>;
        }).setGoal('Unsupported native goal')).resolves.toEqual(expected);
        await expect((runtime as unknown as {
            clearGoal: () => Promise<unknown>;
        }).clearGoal()).resolves.toEqual({
            ...expected,
            error: 'unsupported_session_runtime_method:session.goal.clear',
        });
        await expect((runtime as unknown as {
            refreshGoal: () => Promise<unknown>;
        }).refreshGoal()).resolves.toEqual({
            ...expected,
            error: 'unsupported_session_runtime_method:session.goal.get',
        });
    });

    it('returns stable unsupported results when app-server goal methods return invalid-request errors', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-goal-invalid-request-', {
            rejectGoalMethodsAsInvalidRequest: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});

        await expect((runtime as unknown as {
            setGoal: (objective: string) => Promise<unknown>;
        }).setGoal('Unsupported native goal')).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: 'unsupported_session_runtime_method:session.goal.set',
        });
        await expect((runtime as unknown as {
            refreshGoal: () => Promise<unknown>;
        }).refreshGoal()).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: 'unsupported_session_runtime_method:session.goal.get',
        });
    });

    it('lists Codex vendor plugin and skill catalogs through app-server RPCs', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-catalog-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        const vendorPluginCatalog = await (runtime as unknown as {
            listVendorPlugins: (options?: { cwd?: string }) => Promise<unknown>;
        }).listVendorPlugins({ cwd: '/override' });
        const skillCatalog = await (runtime as unknown as {
            listSkills: (options?: { cwd?: string }) => Promise<unknown>;
        }).listSkills({ cwd: '/override' });

        expect(vendorPluginCatalog).toMatchObject({
            supported: true,
            vendorPlugins: [
                expect.objectContaining({
                    name: 'reviewer',
                    vendorPluginRef: 'plugin://reviewer@codex',
                    mentionable: true,
                }),
            ],
        });
        expect(skillCatalog).toMatchObject({
            supported: true,
            skills: [
                expect.objectContaining({
                    name: 'debugger',
                    path: '/skills/debugger/SKILL.md',
                }),
            ],
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({ method: 'plugin/list', params: { cwds: ['/override'] } }),
            expect.objectContaining({ method: 'skills/list', params: { cwds: ['/override'] } }),
        ]));
    });

    it('interrupts an in-flight turn without spawning a replacement app-server process', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-interrupt-');

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('cancel-me');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.cancel();
        await sendPromptPromise;

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(1);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/interrupt')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({ threadId: 'thread-started', turnId: 'turn-cancel-me' }),
            }),
        ]);
    });

    it('retries the exact interrupt through the provider startup gap and waits for its terminal', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-interrupt-no-active-', {
            rejectFirstInterruptAsNoActiveTurn: true,
        });

        const onThinkingChange = vi.fn();
        const cancelTurn = vi.fn(async () => {});
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble({ cancelTurn }),
            } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('cancel-no-active');
        await waitForCondition(() => runtime.isTurnInFlight(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to enter in-flight state',
        });

        const cancel = runtime.cancel();
        await new Promise((resolve) => setTimeout(resolve, 75));

        const requestsBeforeTerminal = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestsBeforeTerminal.filter((entry: { method: string }) => entry.method === 'turn/interrupt')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({ threadId: 'thread-started', turnId: 'turn-cancel-no-active' }),
            }),
            expect.objectContaining({
                params: expect.objectContaining({ threadId: 'thread-started', turnId: 'turn-cancel-no-active' }),
            }),
        ]);
        expect(runtime.isTurnInFlight()).toBe(true);
        expect(cancelTurn).not.toHaveBeenCalled();

        await expect(cancel).resolves.toBeUndefined();
        await sendPromptPromise;

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(cancelTurn).toHaveBeenCalledOnce();
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/interrupt')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({ threadId: 'thread-started', turnId: 'turn-cancel-no-active' }),
            }),
            expect.objectContaining({
                params: expect.objectContaining({ threadId: 'thread-started', turnId: 'turn-cancel-no-active' }),
            }),
        ]);
    });

    it('accepts exact provider terminal proof when the interrupt response times out', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-interrupt-timeout-after-terminal-', {
            interruptTerminalWithoutResponse: true,
            interruptTerminalDelayMs: 400,
            omitTurnCompletedForPrompt: 'cancel-after-provider-terminal',
            rpcTimeoutMs: 250,
        });

        const cancelTurn = vi.fn(async () => {});
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble({ cancelTurn }),
            } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('cancel-after-provider-terminal');
        await waitForCondition(() => runtime.isTurnInFlight(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to enter in-flight state',
        });

        await expect(runtime.cancel()).resolves.toBeUndefined();
        await sendPromptPromise;
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('keeps a Codex turn in flight until the terminal interrupted notification arrives', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-interrupt-notification-');

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('interrupt-notification-before-terminal');
        await waitForCondition(() => runtime.isTurnInFlight(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to enter in-flight state',
        });

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(runtime.isTurnInFlight()).toBe(true);

        await sendPromptPromise;

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
    });

    it('advertises in-flight steer support and can call turn/steer while a turn is in flight', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-');
        const acceptedPrompts: Array<{
            localIds?: readonly string[] | null;
            userMessageSeq: number | null;
            providerTurnId: string;
        }> = [];

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });
        runtime.setOnPromptAcceptedByProvider((prompt) => {
            acceptedPrompts.push(prompt);
        });

        await runtime.startOrLoad({});
        expect(runtime.supportsInFlightSteer()).toBe(true);
        expect(runtime.supportsInFlightConfigApply()).toBe(true);

        const sendPromptPromise = runtime.sendPrompt('overlap-start');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.steerPrompt('nudge', { localId: ' local-steer-42\n', userMessageSeq: 42 });
        await sendPromptPromise;

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-overlap-start',
                    input: [{ type: 'text', text: 'nudge' }],
                }),
            }),
        ]);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/start')).toHaveLength(1);
        expect(acceptedPrompts).toContainEqual({
            localIds: [' local-steer-42\n'],
            userMessageSeq: 42,
            providerTurnId: 'turn-overlap-start',
        });
    });

    it('places a correlated steer at the provider user-message boundary before accepting Pending custody', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-steer-user-boundary-',
            { steerUserMessageEchoDelayMs: 80 },
        );
        const acceptedPrompts: Array<Readonly<{
            localIds?: readonly string[] | null;
            userMessageSeq: number | null;
            providerTurnId: string;
        }>> = [];
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });
        runtime.setOnPromptAcceptedByProvider((prompt) => {
            acceptedPrompts.push(prompt);
        });

        await runtime.startOrLoad({});
        const activeTurn = runtime.sendPrompt('overlap-start');
        await waitForCondition(() => runtime.canSteerPrompt(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'active Codex turn to become steerable',
        });

        await runtime.steerPrompt('correlated steer', {
            localId: 'pending-steer-287',
            userMessageSeq: 287,
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'turn/steer',
                params: expect.objectContaining({
                    clientUserMessageId: 'pending-steer-287',
                }),
            }),
        ]));
        expect(acceptedPrompts).not.toContainEqual(expect.objectContaining({
            localIds: ['pending-steer-287'],
        }));

        await waitForCondition(
            () => acceptedPrompts.some((prompt) => prompt.localIds?.includes('pending-steer-287') === true),
            {
                timeoutMs: 1_000,
                intervalMs: 10,
                label: 'provider user-message echo to settle Pending custody',
            },
        );
        await activeTurn;
    });

    it('materializes a woken head steer during a genuinely active turn and leaves its FIFO neighbor queued', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-active-turn-pending-');
        const metadataWakes: Array<(updated: boolean) => void> = [];
        let runtime!: ReturnType<typeof createCodexAppServerRuntime>;
        const materializeNextPendingMessageSafely = vi
            .fn()
            .mockResolvedValueOnce({ type: 'no_pending' as const })
            .mockImplementationOnce(async () => {
                await runtime.steerPrompt('pending head steer', {
                    localId: 'pending-head-steer',
                });
                return {
                    type: 'materialized' as const,
                    localId: 'pending-head-steer',
                    seq: 12,
                    content: null,
                };
            })
            .mockImplementationOnce(async () => {
                throw new Error('later ordinary FIFO neighbor must remain queued during the active turn');
            });
        const inputConsumer = createSessionProviderInputConsumer({
            messageQueue: new MessageQueue2<{ id: string }>(() => 'hash'),
            session: {
                materializeNextPendingMessageSafely,
                waitForPendingEligibilityUpdate: async (signal) => await new Promise<boolean>((resolve) => {
                    const finish = (updated: boolean) => {
                        signal?.removeEventListener('abort', onAbort);
                        resolve(updated);
                    };
                    const onAbort = () => finish(false);
                    metadataWakes.push(finish);
                    signal?.addEventListener('abort', onAbort, { once: true });
                }),
            },
        });

        runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            pendingQueue: {
                drainPending: (opts) => inputConsumer.drainPending(opts),
                pumpPendingWhileActive: (opts) => inputConsumer.pumpPendingWhileActive(opts),
            },
        });

        await runtime.startOrLoad({});
        const activeTurn = runtime.sendPrompt('overlap-start');
        await waitForCondition(
            () => runtime.canSteerPrompt() && materializeNextPendingMessageSafely.mock.calls.length === 1,
            {
                timeoutMs: 1_000,
                intervalMs: 10,
                label: 'active Codex turn to arm and complete its immediate Pending pass',
            },
        );

        metadataWakes.shift()?.(true);
        await waitForCondition(async () => (
            (await readRequestLog(requestLogPath)).filter((entry) => entry.method === 'turn/steer').length === 1
        ), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'woken Pending head to invoke one native Codex steer',
        });
        expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);

        await activeTurn;

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    expectedTurnId: 'turn-overlap-start',
                    input: [{ type: 'text', text: 'pending head steer' }],
                }),
            }),
        ]);
        expect(materializeNextPendingMessageSafely).toHaveBeenCalledTimes(2);
    });

    it('blocks turn/start and turn/steer on unavailable group truth until a valid generation is applied', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-group-unavailable-');
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onConnectedServiceAuthGenerationApplied: vi.fn(async () => {}),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_original',
                accountLabel: 'original@example.test',
                profileId: 'original',
                groupId: 'team',
                generation: 1,
                credentialFingerprint: 'sha256:original',
                source: 'spawn_selection',
            },
            session: { updateMetadata: vi.fn() } as any,
        });
        const replacement = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'openai-codex',
            profileId: 'replacement',
            kind: 'oauth',
            expiresAt: 2_000,
            oauth: {
                accessToken: 'replacement-access',
                refreshToken: 'replacement-refresh',
                idToken: 'replacement-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_replacement',
                providerEmail: 'replacement@example.test',
            },
        });
        const applyValidGeneration = () => runtime.applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            expected: { profileId: 'replacement', groupId: 'team', generation: 2 },
            authGeneration: {
                credential: replacement,
                selection: {
                    kind: 'group',
                    serviceId: 'openai-codex',
                    groupId: 'team',
                    activeProfileId: 'replacement',
                    generation: 2,
                },
            },
        });

        await runtime.startOrLoad({});
        await expect(runtime.applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            authGeneration: {
                kind: 'current_auth_group_unavailable',
                groupId: 'team',
                unavailableReason: 'group_missing',
            },
        })).resolves.toMatchObject({ ok: true, appliedVia: 'current_truth_fence' });
        await expect(runtime.sendPrompt('must-not-start')).rejects.toMatchObject({
            code: 'connected_service_auth_group_unavailable',
        });
        expect((await readRequestLog(requestLogPath)).filter((entry) => entry.method === 'turn/start')).toHaveLength(0);

        await runtime.applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            authGeneration: {
                kind: 'current_auth_group_available',
                groupId: 'replacement-team',
                generation: 1,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
        });
        await expect(runtime.sendPrompt('works-after-group-rebinding')).resolves.toBeUndefined();
        await runtime.applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            authGeneration: {
                kind: 'current_auth_group_unavailable',
                groupId: 'team',
                unavailableReason: 'group_missing',
            },
        });

        await expect(applyValidGeneration()).resolves.toMatchObject({ ok: true });
        const activeTurn = runtime.sendPrompt('overlap-start');
        await waitForCondition(() => runtime.canSteerPrompt(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become steerable before unavailable truth',
        });
        await runtime.applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            authGeneration: {
                kind: 'current_auth_group_unavailable',
                groupId: 'team',
                unavailableReason: 'active_profile_missing',
            },
        });
        await expect(runtime.steerPrompt('must-not-steer')).rejects.toMatchObject({
            code: 'connected_service_auth_group_unavailable',
        });
        expect((await readRequestLog(requestLogPath)).filter((entry) => entry.method === 'turn/steer')).toHaveLength(0);
        await activeTurn;
        await expect(applyValidGeneration()).resolves.toMatchObject({ ok: true });
        await expect(runtime.sendPrompt('works-after-valid-generation')).resolves.toBeUndefined();
    });

    it('does not let a delayed turn/start response confirm an overlapping steer prompt', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-overlap-');
        const acceptedPrompts: Array<{ userMessageSeq: number | null; providerTurnId: string }> = [];

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });
        runtime.setOnPromptAcceptedByProvider((prompt) => {
            acceptedPrompts.push(prompt);
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('overlap-start', { userMessageSeq: 10 });
        await waitForCondition(() => acceptedPrompts.some((prompt) => prompt.userMessageSeq === 10), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'initial turn/start prompt acceptance',
        });
        await waitForCondition(() => runtime.canSteerPrompt() === true, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become steerable',
        });

        const steerPromise = runtime.steerPrompt('overlap-steer', { userMessageSeq: 11 });
        await waitForCondition(async () => {
            const requestLog = await readRequestLog(requestLogPath);
            return requestLog.some((entry) => entry.method === 'turn/steer');
        }, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'overlapping turn/steer request',
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(acceptedPrompts).toEqual([{
            userMessageSeq: 10,
            providerTurnId: 'turn-overlap-start',
        }]);

        await steerPromise;
        expect(acceptedPrompts).toEqual([
            { userMessageSeq: 10, providerTurnId: 'turn-overlap-start' },
            { userMessageSeq: 11, providerTurnId: 'turn-overlap-start' },
        ]);
        await sendPromptPromise;
    });

    it('clears stale in-flight state when native steer reports no active turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-no-active-', {
            rejectSteerAsNoActiveTurn: true,
        });

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('stale-steer');
        await waitForCondition(() => runtime.canSteerPrompt() === true, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become steerable',
        });

        expect(runtime.isTurnInFlight()).toBe(true);
        await expect(runtime.steerPrompt('nudge')).rejects.toThrow(/no active turn to steer/i);
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(runtime.canSteerPrompt()).toBe(false);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
        await expect(sendPromptPromise).resolves.toBeUndefined();

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-stale-steer',
                    input: [{ type: 'text', text: 'nudge' }],
                }),
            }),
        ]);
    });

    it('does not let a late no-active steer response clear a same-thread successor', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-steer-late-no-active-successor-',
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
            } as any,
            permissionMode: 'default',
        });

        await runtime.startOrLoad({});
        const predecessor = runtime.sendPrompt('goal-successor-long-lived-during-terminal-settle');
        await (runtime as unknown as { setGoal: (objective: string) => Promise<void> }).setGoal('Continue autonomously');
        await waitForCondition(() => runtime.canSteerPrompt(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'predecessor to become steerable before delayed stale response',
        });

        const staleSteer = runtime.steerPrompt('late-no-active-steer');
        staleSteer.catch(() => undefined);
        await predecessor;
        await waitForCondition(() => runtime.canSteerPrompt(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'same-thread successor to become steerable',
        });

        await expect(staleSteer).rejects.toThrow(/no active turn to steer/i);
        expect(runtime.hasActiveProviderTurn()).toBe(true);
        expect(runtime.canSteerPrompt()).toBe(true);
        await runtime.steerPrompt('successor-remains-owned');

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'turn/steer',
                params: expect.objectContaining({
                    expectedTurnId: 'turn-native-goal-successor-during-terminal-settle',
                    input: [{ type: 'text', text: 'successor-remains-owned' }],
                }),
            }),
        ]));
    });

    it('retries turn start with text-only input while keeping native permissions when structured input is unsupported', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-turn-structured-fallback-permissions-', {
            rejectStructuredTurnInput: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('structured-turn-fallback', {
            metadata: {
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
                    ],
                },
            },
        });

        const turnStarts = (await readRequestLog(requestLogPath))
            .filter((entry) => entry.method === 'turn/start') as Array<{ params?: Record<string, unknown> }>;
        expect(turnStarts).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    input: [
                        { type: 'text', text: 'structured-turn-fallback' },
                        { type: 'mention', name: 'Reviewer', path: 'plugin://reviewer@codex' },
                    ],
                    permissions: { type: 'profile', id: ':read-only' },
                }),
            }),
            expect.objectContaining({
                params: expect.objectContaining({
                    input: [{ type: 'text', text: 'structured-turn-fallback' }],
                    permissions: { type: 'profile', id: ':read-only' },
                }),
            }),
        ]);
        expect(turnStarts[1]?.params).not.toHaveProperty('sandboxPolicy');
        expect(turnStarts[1]?.params).not.toHaveProperty('approvalPolicy');
    });

    it('retries turn steer with text-only input when structured steer input is unsupported', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-structured-fallback-', {
            rejectStructuredSteerInput: true,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('overlap-start');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.steerPrompt('nudge with plugin', {
            metadata: {
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
                    ],
                },
            },
        });
        await sendPromptPromise;

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-overlap-start',
                    input: [
                        { type: 'text', text: 'nudge with plugin' },
                        { type: 'mention', name: 'Reviewer', path: 'plugin://reviewer@codex' },
                    ],
                }),
            }),
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-overlap-start',
                    input: [{ type: 'text', text: 'nudge with plugin' }],
                }),
            }),
        ]);
    });

    it('does not retry a structured steer after the active turn owner terminates', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-steer-structured-fallback-owner-race-',
            { rejectStructuredSteerInput: true },
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('overlap-start');
        await waitForCondition(() => runtime.canSteerPrompt(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'active turn to become steerable before structured fallback race',
        });

        await expect(runtime.steerPrompt('structured-fallback-owner-change', {
            metadata: {
                happierStructuredInputV1: {
                    vendorPluginMentions: [
                        { displayName: 'Reviewer', vendorPluginRef: 'plugin://reviewer@codex' },
                    ],
                },
            },
        })).rejects.toThrow('Codex app-server active turn is not steerable');
        await sendPromptPromise;

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/steer')).toHaveLength(1);
    });

    it('records one durable turn-start boundary for a steered turn and rejects the steer user row as a point rollback target', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-session-turn-');

        let metadataSnapshot: Record<string, unknown> = { machineId: 'machine_1' };
        let lastObservedMessageSeq = 10;
        let lastObservedUserMessageSeq = 10;
        const committedUserSeqs = new Map([
            ['prompt-local-1', 10],
            ['steer-local-1', 12],
        ]);
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            metadataSnapshot = updater(metadataSnapshot);
            return metadataSnapshot;
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session_1',
                updateMetadata,
                getMetadataSnapshot: vi.fn(() => metadataSnapshot),
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                getLastObservedUserMessageSeq: vi.fn(() => lastObservedUserMessageSeq),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => committedUserSeqs.get(localId) ?? null),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        const sendPromptPromise = (runtime as any).sendPrompt('cancel-me', {
            localId: 'prompt-local-1',
        });
        await new Promise((resolve) => setTimeout(resolve, 30));

        lastObservedMessageSeq = 12;
        lastObservedUserMessageSeq = 12;
        await (runtime as any).steerPrompt('nudge', {
            localId: 'steer-local-1',
        });
        lastObservedMessageSeq = 15;
        await sendPromptPromise;

        expect(metadataSnapshot).not.toHaveProperty('sessionTurnLedgerV1');

        await expect((runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 12,
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            errorMessage: 'Rollback target is not available in the active conversation',
        });

        await expect((runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 10,
            },
        })).resolves.toMatchObject({ ok: true });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/rollback')).toEqual([
            expect.objectContaining({
                params: { threadId: 'thread-started', numTurns: 1 },
            }),
        ]);
    });

    it('marks a completed turn as non-steerable while completion is still settling', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-settle-');
        const activeTurnPendingPump: {
            signal?: AbortSignal;
            resolve?: () => void;
        } = {};

        envScope.patch({
            HAPPIER_CODEX_APP_SERVER_TURN_COMPLETION_SETTLE_MS: '1000',
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            pendingQueue: {
                drainPending: vi.fn(async () => ({ materialized: 0, stoppedReason: 'no_pending' as const })),
                pumpPendingWhileActive: vi.fn(async ({ abortSignal }) => {
                    activeTurnPendingPump.signal = abortSignal;
                    await new Promise<void>((resolve) => {
                        activeTurnPendingPump.resolve = resolve;
                        abortSignal.addEventListener('abort', resolve, { once: true });
                    });
                }),
            },
        });
        const steerableRuntime = runtime as typeof runtime & { canSteerPrompt?: () => boolean };

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('settle-after-complete');

        await waitForCondition(() => steerableRuntime.canSteerPrompt?.() === true, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become steerable',
        });

        await waitForCondition(() => steerableRuntime.canSteerPrompt?.() === false, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become non-steerable after terminal notification',
        });

        expect(runtime.isTurnInFlight()).toBe(true);
        expect(activeTurnPendingPump.signal?.aborted).toBe(false);
        await expect(runtime.steerPrompt('late-nudge')).rejects.toThrow('Codex app-server active turn is not steerable');
        await sendPromptPromise;
        expect(activeTurnPendingPump.signal?.aborted).toBe(true);
        activeTurnPendingPump.resolve?.();
    });

    it('keeps an active app-server turn steerable when the selected session mode changes', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-mode-change-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });
        const steerableRuntime = runtime as typeof runtime & { canSteerPrompt?: () => boolean };

        await runtime.startOrLoad({});
        await runtime.setSessionMode('plan');
        const sendPromptPromise = runtime.sendPrompt('overlap-start');

        await waitForCondition(() => steerableRuntime.canSteerPrompt?.() === true, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server turn to become steerable with matching session mode',
        });

        await runtime.setSessionMode('default');

        expect(steerableRuntime.canSteerPrompt?.()).toBe(true);
        await runtime.steerPrompt('nudge-after-mode-change');
        await sendPromptPromise;

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-overlap-start',
                    input: [{ type: 'text', text: 'nudge-after-mode-change' }],
                }),
            }),
        ]);
    });

    it('waits for the active turn id before calling turn/steer', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-wait-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});

        const sendPromptPromise = runtime.sendPrompt('steer-delay');
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(runtime.isTurnInFlight()).toBe(true);
        expect(runtime.canSteerPrompt()).toBe(false);

        let steerSettled = false;
        const steerPromise = runtime.steerPrompt('nudge-early');
        void steerPromise.then(
            () => { steerSettled = true; },
            () => { steerSettled = true; },
        );
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(steerSettled).toBe(false);
        const earlyRequestLog = await readRequestLog(requestLogPath);
        expect(earlyRequestLog.filter((entry) => entry.method === 'turn/steer')).toHaveLength(0);

        await steerPromise;
        await sendPromptPromise;

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    expectedTurnId: 'turn-steer-delay',
                    input: [{ type: 'text', text: 'nudge-early' }],
                }),
            }),
        ]);
    });

    it('does not steer a turn whose ownership changes while structured input is resolving', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-steer-input-owner-race-',
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });
        const uploadedPath = '.happier/uploads/messages/race/screenshot.png';
        const uploadedContent = Buffer.from('race screenshot');
        const sha256 = createHash('sha256').update(uploadedContent).digest('hex');
        await mkdir(join(root, '.happier', 'uploads', 'messages', 'race'), { recursive: true });
        await writeFile(join(root, uploadedPath), uploadedContent);

        await runtime.startOrLoad({});
        const sendPromptPromise = runtime.sendPrompt('overlap-start');
        await waitForCondition(() => runtime.canSteerPrompt(), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'active turn to become steerable before input resolution race',
        });

        let scheduledOwnerChange = false;
        const metadata = {
            get happier() {
                if (!scheduledOwnerChange) {
                    scheduledOwnerChange = true;
                    queueMicrotask(() => {
                        void runtime.flushTurn();
                    });
                }
                return {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [{
                            path: uploadedPath,
                            mimeType: 'image/png',
                            sizeBytes: uploadedContent.byteLength,
                            sha256,
                        }],
                    },
                };
            },
            happierStructuredInputV1: {
                attachments: [{
                    kind: 'image',
                    localPath: uploadedPath,
                    path: uploadedPath,
                    sha256,
                    provenance: { kind: 'sessionAttachmentUpload' },
                }],
            },
        };

        await expect(runtime.steerPrompt('must-not-steer-after-owner-change', { metadata }))
            .rejects.toThrow('Codex app-server active turn is not steerable');
        await sendPromptPromise;

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/steer')).toHaveLength(0);
    });

    it('bridges stream notifications into transcript deltas and tool updates during sendPrompt', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-streams-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, unknown> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message' && !call.body.sidechainId)
            .map((call) => String(call.body?.message ?? ''));
        const thinkingMessages = committedCalls
            .map(([, body]) => body)
            .filter((body: any) => body?.type === 'thinking' && !body?.sidechainId)
            .map((body: any) => String(body.text ?? ''));

        expect(assistantMessages.some((msg) => msg.includes('Hello'))).toBe(true);
        expect(assistantMessages.some((msg) => msg.includes('world'))).toBe(true);
        expect(thinkingMessages.some((msg) => msg.includes('thinking'))).toBe(true);
        expect(thinkingMessages.some((msg) => msg.includes('hard'))).toBe(true);
        expect(session.sendCodexMessage.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({ type: 'tool-call', callId: 'cmd_1', name: 'CodexBash', input: { command: 'ls -la', cwd: '/repo' } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'cmd_1', output: { stdout: 'done', exitCode: 0 } })],
                [expect.objectContaining({ type: 'tool-call', callId: 'tool_1', name: 'mcp__playwright__browser_navigate', input: { url: 'https://example.com' } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'tool_1', output: { status: 'ok' } })],
                [expect.objectContaining({
                    type: 'tool-call',
                    callId: 'patch_1',
                    name: 'CodexPatch',
                    input: {
                        auto_approved: true,
                        changes: [
                            {
                                path: 'src/file.ts',
                                kind: { type: 'update', move_path: null },
                                diff: '@@ -1 +1,2 @@\n-old line\n+old line\n+new line\n',
                            },
                        ],
                    },
                })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'patch_1', output: { stdout: 'patched', success: true } })],
                [expect.objectContaining({
                    type: 'tool-call',
                    name: 'Diff',
                    input: expect.objectContaining({
                        files: [
                            expect.objectContaining({
                                file_path: 'src/file.ts',
                                oldText: 'old line\n',
                                newText: 'old line\nnew line\n',
                            }),
                        ],
                    }),
                })],
                [expect.objectContaining({ type: 'tool-call-result', output: { status: 'completed' } })],
            ]),
        );
    });

    it('commits native review completion text without duplicating identical assistant finals', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-review-dedupe-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'Review current changes',
            },
        });

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, unknown> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body]) => body as CommittedSnapshotBody)
            .filter((body) => body.type === 'message' && !body.sidechainId)
            .map((body) => String(body.message ?? ''));
        const nativeReviewLocalIds = new Set(committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message' && !call.body.sidechainId && call.body.message === 'Native review text')
            .map((call) => call.opts.localId));
        expect(assistantMessages).toContain('Native review text');
        expect(nativeReviewLocalIds.size).toBe(1);
    });

    it('preserves assistant final text that differs from native review completion text', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-review-different-final-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            startReview: (request: { target: Record<string, unknown> }) => Promise<unknown>;
        }).startReview({
            target: {
                type: 'custom',
                instructions: 'different-final',
            },
        });

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, unknown> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body]) => body as CommittedSnapshotBody)
            .filter((body) => body.type === 'message' && !body.sidechainId)
            .map((body) => String(body.message ?? ''));
        expect(assistantMessages).toEqual(expect.arrayContaining([
            'Native review body',
            'Different final assistant text',
        ]));
    });

    it('commits inline native review results as structured review findings without duplicating final text', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-inline-review-');

        const session = {
            sessionId: 'sess-inline-review',
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await runtime.startOrLoad({});
        await (runtime as unknown as {
            startInlineReview: (input: unknown) => Promise<unknown>;
        }).startInlineReview({
            engineIds: ['codex'],
            instructions: 'Review current changes',
            runLocation: 'current_session',
            changeType: 'uncommitted',
            base: { kind: 'none' },
        });

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, unknown> }]
        >;
        const nativeReviewMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message' && !call.body.sidechainId && call.body.message === 'Native review text');

        expect(nativeReviewMessages).toHaveLength(1);
        expect(nativeReviewMessages[0]?.opts.meta?.happier).toMatchObject({
            kind: 'review_findings.v2',
            payload: {
                runRef: {
                    runId: 'session-review:sess-inline-review:turn-review-native',
                    callId: 'review_exited_1',
                    backendId: 'codex',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                },
                summary: 'Native review text',
                overviewMarkdown: 'Native review text',
                findings: [],
            },
        });
    });

    it('starts an app-server thread before inline native review when none is active', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-inline-review-start-');

        const session = {
            sessionId: 'sess-inline-review-start',
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await (runtime as unknown as {
            startInlineReview: (input: unknown) => Promise<unknown>;
        }).startInlineReview({
            engineIds: ['codex'],
            instructions: 'Review current changes',
            runLocation: 'current_session',
            changeType: 'uncommitted',
            base: { kind: 'none' },
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).toContain('thread/start');
        expect(requestLog.map((entry) => entry.method)).toContain('review/start');
    });

    it('rejects inline native reviews that do not target Codex', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-inline-review-wrong-engine-');

        const session = {
            sessionId: 'sess-inline-review-wrong-engine',
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        await expect((runtime as unknown as {
            startInlineReview: (input: unknown) => Promise<unknown>;
        }).startInlineReview({
            engineIds: ['claude'],
            runLocation: 'current_session',
            changeType: 'uncommitted',
            base: { kind: 'none' },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'inline_review_not_supported',
            error: 'inline_review_not_supported',
        });

        const requestLogText = await readFile(requestLogPath, 'utf8').catch(() => '');
        expect(requestLogText).not.toContain('"method":"review/start"');
    });

    it('handles /codex.review through the provider-owned user message hook', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-inline-review-command-');

        const session = {
            sessionId: 'sess-inline-review-command',
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as ApiSessionClient,
        });

        const result = await (runtime as unknown as {
            handleUserMessage: (request: {
                text: string;
                localId?: string;
                meta: Record<string, unknown>;
            }) => Promise<unknown>;
        }).handleUserMessage({
            text: '/codex.review focus on regressions',
            localId: 'local-review-command',
            meta: { source: 'test' },
        });

        expect(result).toEqual({ handled: true, result: { ok: true, reviewTurnId: 'turn-review-native' } });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toContainEqual(expect.objectContaining({
            method: 'review/start',
            params: expect.objectContaining({
                target: expect.objectContaining({
                    type: 'custom',
                    instructions: expect.stringContaining('focus on regressions'),
                }),
            }),
        }));
    });

    it('uses the explicit transcript session port for live and durable transcript snapshots', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-transcript-port-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const transcriptSession = {
            sendAgentMessageEphemeral: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async (_provider: string, _body: ACPMessageData, _options?: TestCommittedMessageOptions) => {}),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            transcriptSession: transcriptSession as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');

        expect(transcriptSession.sendAgentMessageEphemeral).toHaveBeenCalled();
        expect(transcriptSession.sendAgentMessageCommitted).toHaveBeenCalled();
        const committedSegmentStates = transcriptSession.sendAgentMessageCommitted.mock.calls
            .map(([, , opts]) => opts?.meta?.happierStreamSegmentV1?.segmentState);
        expect(committedSegmentStates).toContain('streaming');
        expect(committedSegmentStates).toContain('complete');
        expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    });

    it('does not append the full final assistant text into streaming drafts when the final text diverges from earlier deltas', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-divergent-final-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams-divergent-final');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message' && !call.body.sidechainId)
            .map((call) => String(call.body?.message ?? ''));
        expect(assistantMessages.some((msg) => msg === 'READY ')).toBe(true);
        expect(assistantMessages.some((msg) => msg === 'READY_FOR_FOLLOWUP')).toBe(true);
        expect(assistantMessages.some((msg) => msg.includes('READY_FOR_FOLLOWUP') && msg !== 'READY_FOR_FOLLOWUP')).toBe(false);
    });

    it('persists final image generation media before committing Codex app-server assistant metadata', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-generated-image-');

        const persistedMediaItem = {
            id: 'media-1',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'generated-image.png',
            path: '.happier/uploads/generated/message-1/media-1.png',
            sizeBytes: 67,
            sha256: 'a'.repeat(64),
            origin: {
                source: 'provider-generated',
                generationId: 'img_1',
            },
        } as const;
        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const sessionMediaPersist = vi.fn(async (_message: RuntimeSessionMediaMessage) => ({
            media: [persistedMediaItem],
            unavailable: [],
        }));
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            sessionMedia: { persist: sessionMediaPersist },
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-generated-image');

        expect(sessionMediaPersist).toHaveBeenCalledOnce();
        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const finalAssistant = committedCalls
            .map(([, body, opts]) => ({ body, opts }))
            .find((call) =>
                call.body?.type === 'message' &&
                call.body.message === 'Generated image:' &&
                call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete'
            );
        expect(finalAssistant?.opts.meta).toMatchObject({
            happier: {
                kind: 'session_media.v1',
                payload: {
                    media: [persistedMediaItem],
                },
            },
        });
        expect(JSON.stringify(finalAssistant?.opts.meta)).not.toContain('iVBORw0KGgo=');
        expect(JSON.stringify(finalAssistant?.opts.meta)).not.toContain('attachments.v1');
    });

    it('bounds large and mixed persister results to the canonical combined media envelope limit', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-generated-image-bound-');
        const logSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        const buildMedia = (id: string) => ({
            id,
            role: 'output' as const,
            category: 'generated' as const,
            mediaKind: 'image' as const,
            mimeType: 'image/png' as const,
            name: `${id}.png`,
            path: `.happier/uploads/generated/${id}.png`,
            sizeBytes: 67,
            origin: { source: 'provider-generated' as const, generationId: id },
        });
        const buildUnavailable = (id: string) => ({
            id,
            role: 'output' as const,
            category: 'generated' as const,
            mediaKind: 'image' as const,
            code: 'provider_file_unavailable',
            origin: { source: 'provider-generated' as const },
        });
        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        let persistenceAttempt = 0;
        const sessionMediaPersist = vi.fn(async (_message: RuntimeSessionMediaMessage) => {
            persistenceAttempt += 1;
            return persistenceAttempt === 1
                ? {
                    media: Array.from(
                        { length: SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1 + 1 },
                        (_, index) => buildMedia(`large-${index}`),
                    ),
                    unavailable: [],
                }
                : {
                    media: Array.from({ length: 200 }, (_, index) => buildMedia(`mixed-${index}`)),
                    unavailable: Array.from({ length: 100 }, (_, index) => buildUnavailable(`mixed-${index}`)),
                };
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            sessionMedia: { persist: sessionMediaPersist },
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-generated-image');
        await runtime.sendPrompt('bridge-generated-image');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, ACPMessageData, { meta?: { happier?: unknown } } | undefined]
        >;
        const mediaEnvelopes = committedCalls
            .map(([, , options]) => (options as { meta?: { happier?: unknown } } | undefined)?.meta?.happier)
            .filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object')
            .filter((value) => Reflect.get(value, 'kind') === 'session_media.v1');
        expect(mediaEnvelopes).toHaveLength(2);
        expect(mediaEnvelopes.every((envelope) => SessionMediaMessageMetaEnvelopeV1Schema.safeParse(envelope).success))
            .toBe(true);

        const firstPayload = Reflect.get(mediaEnvelopes[0]!, 'payload') as {
            media: unknown[];
            unavailable?: unknown[];
        };
        expect(firstPayload.media).toHaveLength(SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1);
        expect(firstPayload.unavailable).toBeUndefined();

        const secondPayload = Reflect.get(mediaEnvelopes[1]!, 'payload') as {
            media: unknown[];
            unavailable?: unknown[];
        };
        expect(secondPayload.media).toHaveLength(200);
        expect(secondPayload.unavailable).toHaveLength(SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1 - 200);
        expect(logSpy.mock.calls.filter(
            ([message]) => message === '[codex-app-server] Bounded excess session media entries',
        )).toEqual([
            ['[codex-app-server] Bounded excess session media entries', {
                droppedCount: 1,
                maxEntries: SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1,
            }],
            ['[codex-app-server] Bounded excess session media entries', {
                droppedCount: 44,
                maxEntries: SESSION_MEDIA_MESSAGE_MAX_ENTRIES_V1,
            }],
        ]);
        logSpy.mockRestore();
    });

    it('dedupes repeated Codex app-server media updates before persistence', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-generated-image-dedupe-');

        const persistedMediaItem = {
            id: 'media-1',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'generated-image.png',
            path: '.happier/uploads/generated/message-1/media-1.png',
            sizeBytes: 67,
            sha256: 'a'.repeat(64),
            origin: {
                source: 'provider-generated',
                generationId: 'img_dup',
            },
        } as const;
        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const sessionMediaPersist = vi.fn(async (_message: RuntimeSessionMediaMessage) => ({
            media: [persistedMediaItem],
            unavailable: [],
        }));
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
            sessionMedia: { persist: sessionMediaPersist },
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-generated-image-duplicate');

        expect(sessionMediaPersist).toHaveBeenCalledOnce();
        const persistedMessage = sessionMediaPersist.mock.calls[0]?.[0];
        expect(persistedMessage?.media).toHaveLength(1);
        expect(JSON.stringify(persistedMessage)).not.toContain('attachments.v1');
    });

    it('keeps multiple assistant and reasoning item streams isolated within one turn', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-multi-item-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams-multi-item');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const finalAssistantMessages = committedCalls
            .map(([, body, opts]) => ({ body, opts }))
            .filter((call) => call.body?.type === 'message' && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete');
        const finalThinkingMessages = committedCalls
            .map(([, body, opts]) => ({ body, opts }))
            .filter((call) => call.body?.type === 'thinking' && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete');

        expect(finalAssistantMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({ body: expect.objectContaining({ message: 'Alpha done' }) }),
            expect.objectContaining({ body: expect.objectContaining({ message: 'Beta done' }) }),
        ]));
        expect(new Set(finalAssistantMessages.map((call) => call.opts.localId)).size).toBe(2);

        expect(finalThinkingMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({ body: expect.objectContaining({ text: 'think-a done' }) }),
            expect.objectContaining({ body: expect.objectContaining({ text: 'think-b done' }) }),
        ]));
        expect(new Set(finalThinkingMessages.map((call) => call.opts.localId)).size).toBe(2);
    });

    it('keeps Codex plan and agent message assistant items in separate transcript streams', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-plan-agent-message-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-plan-and-agent-message');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const finalAssistantMessages = committedCalls
            .map(([, body, opts]) => ({ body, opts }))
            .filter((call) => call.body?.type === 'message' && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete');

        expect(finalAssistantMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({ body: expect.objectContaining({ message: 'Plan final' }) }),
            expect.objectContaining({ body: expect.objectContaining({ message: 'Answer final' }) }),
        ]));
        expect(finalAssistantMessages.some((call) => call.body.message === 'Plan finalAnswer final')).toBe(false);
        expect(new Set(finalAssistantMessages.map((call) => call.opts.localId)).size).toBe(2);
    });

    it('commits a late final assistant item that arrives after turn/completed', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-late-final-');

        const eventOrder: string[] = [];
        const session = {
            updateMetadata: vi.fn(),
            sessionTurnLifecycle: createSessionTurnLifecycleTestDouble({
                completeTurn: vi.fn(async () => {
                    eventOrder.push('completed-status');
                }),
            }),
            sendAgentMessageCommitted: vi.fn(async (_provider: string, body: { type?: string }) => {
                if (body.type === 'message') {
                    eventOrder.push('assistant-final');
                }
            }),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn((value: boolean) => {
                eventOrder.push(value ? 'thinking-started' : 'thinking-stopped');
            }),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-late-final-after-turn-completed');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message'
                && !call.body.sidechainId
                && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete')
            .map((call) => String(call.body?.message ?? ''));

        expect(assistantMessages).toContain('Late final answer');
        expect(eventOrder.indexOf('assistant-final')).toBeGreaterThanOrEqual(0);
        expect(eventOrder.indexOf('completed-status')).toBeGreaterThan(eventOrder.indexOf('assistant-final'));
        expect(eventOrder.indexOf('thinking-stopped')).toBeGreaterThan(eventOrder.indexOf('assistant-final'));
    });

    it('keeps the active Codex turn open until same-turn command items finish after turn/completed', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-late-command-result-');

        const eventOrder: string[] = [];
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble({
            completeTurn: vi.fn(async () => {
                eventOrder.push('completed-status');
            }),
        });
        const session = {
            updateMetadata: vi.fn(),
            sessionTurnLifecycle,
            sendCodexMessage: vi.fn((message: { type?: string; callId?: string }) => {
                if (message.type === 'tool-call-result' && message.callId === 'late_cmd_1') {
                    eventOrder.push('tool-result');
                }
            }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn((value: boolean) => {
                eventOrder.push(value ? 'thinking-started' : 'thinking-stopped');
            }),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-late-command-result-after-turn-completed');
        await waitForCondition(() => eventOrder.includes('tool-result'), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'late Codex command result bridged',
        });

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
        expect(eventOrder.indexOf('completed-status')).toBeGreaterThan(eventOrder.indexOf('tool-result'));
        expect(eventOrder.at(-1)).toBe('thinking-stopped');
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('cancels pending Codex turn finalization when same-turn command starts during settle', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-late-command-start-');

        const eventOrder: string[] = [];
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble({
            completeTurn: vi.fn(async () => {
                eventOrder.push('completed-status');
            }),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn((message: { type?: string; callId?: string }) => {
                    if (message.type === 'tool-call-result' && message.callId === 'late_start_cmd_1') {
                        eventOrder.push('tool-result');
                    }
                }),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-late-command-start-after-turn-completed');
        await waitForCondition(() => eventOrder.includes('tool-result'), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'late-start Codex command result bridged',
        });

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
        expect(eventOrder.indexOf('completed-status')).toBeGreaterThan(eventOrder.indexOf('tool-result'));
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('tracks blocking Codex item starts that produce no stream update during settle', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-late-filechange-start-');

        const eventOrder: string[] = [];
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble({
            completeTurn: vi.fn(async () => {
                eventOrder.push('completed-status');
            }),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn((message: { type?: string; callId?: string }) => {
                    if (message.type === 'tool-call-result' && message.callId === 'late_file_1') {
                        eventOrder.push('tool-result');
                    }
                }),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-late-filechange-start-after-turn-completed');
        await waitForCondition(() => eventOrder.includes('tool-result'), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'late-start Codex file change result bridged',
        });

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
        expect(eventOrder.indexOf('completed-status')).toBeGreaterThan(eventOrder.indexOf('tool-result'));
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('does not misread top-level item ids as provider turn ids when nested turn data is present', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-top-level-item-id-');

        const session = {
            updateMetadata: vi.fn(),
            sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-top-level-item-id-with-nested-turn');

        expect(session.sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'tool-call',
            callId: 'nested_cmd_1',
        }));
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('does not adopt duplicate post-terminal command results as new Codex turns', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-duplicate-post-terminal-command-result-');

        const onThinkingChange = vi.fn();
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage,
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-duplicate-command-result-after-terminal-turn');
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
        expect(sendCodexMessage.mock.calls.filter(([message]) =>
            message?.type === 'tool-call-result' && message.callId === 'dup_cmd_1',
        )).toHaveLength(1);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('ignores duplicate same-turn command completions while terminal finalization waits for blocking items', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-duplicate-terminal-drain-result-');

        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const sendCodexMessage = vi.fn();
        const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved' as const })) };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage,
            } as any,
            permissionHandler,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-duplicate-command-result-during-terminal-drain');
        await new Promise((resolve) => setTimeout(resolve, 140));

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
        expect(sendCodexMessage.mock.calls.filter(([message]) =>
            message?.type === 'tool-call-result' && message.callId === 'drain_dup_cmd_1',
        )).toHaveLength(1);
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('remembers terminal Codex turn ids that only arrive on turn/completed', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-terminal-id-only-duplicate-result-');

        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage,
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-terminal-id-only-duplicate-command-result');
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
        expect(sendCodexMessage.mock.calls.filter(([message]) =>
            message?.type === 'tool-call-result' && message.callId === 'terminal_id_cmd_1',
        )).toHaveLength(1);
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('ignores stale terminal Codex turn ids while the next active turn has not observed its provider id', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-stale-terminal-id-race-');

        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const sendCodexMessage = vi.fn();
        const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved' as const })) };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            permissionHandler,
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage,
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-stale-terminal-old-turn');
        await runtime.sendPrompt('bridge-stale-terminal-next-turn');
        await new Promise((resolve) => setTimeout(resolve, 130));

        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(2);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(2);
        expect(sendCodexMessage.mock.calls.filter(([message]) =>
            message?.type === 'tool-call-result' && message.callId === 'stale_cmd_1',
        )).toHaveLength(0);
        expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('commits a raw assistant final when no normalized assistant final arrives', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-raw-final-only-');

        const eventOrder: string[] = [];
        const session = {
            updateMetadata: vi.fn(),
            sessionTurnLifecycle: createSessionTurnLifecycleTestDouble({
                completeTurn: vi.fn(async () => {
                    eventOrder.push('completed-status');
                }),
            }),
            sendAgentMessageCommitted: vi.fn(async (_provider: string, body: { type?: string }) => {
                if (body.type === 'message') {
                    eventOrder.push('assistant-final');
                }
            }),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn((value: boolean) => {
                eventOrder.push(value ? 'thinking-started' : 'thinking-stopped');
            }),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-raw-final-only');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message'
                && !call.body.sidechainId
                && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete')
            .map((call) => String(call.body?.message ?? ''));

        expect(assistantMessages).toEqual(['Raw final answer']);
        expect(eventOrder.indexOf('assistant-final')).toBeGreaterThanOrEqual(0);
        expect(eventOrder.indexOf('completed-status')).toBeGreaterThan(eventOrder.indexOf('assistant-final'));
        expect(eventOrder.indexOf('thinking-stopped')).toBeGreaterThan(eventOrder.indexOf('assistant-final'));
    });

    it('does not duplicate the assistant message when a raw final and normalized final both arrive', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-raw-and-normalized-final-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-raw-and-normalized-final');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message'
                && !call.body.sidechainId
                && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete')
            .map((call) => String(call.body?.message ?? ''));

        expect(assistantMessages).toEqual(['Normalized final answer']);
    });

    it('does not drop an item-scoped raw final when another assistant item has a normalized final', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-raw-normalized-different-items-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-raw-and-normalized-different-items');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
        >;
        const assistantMessages = committedCalls
            .map(([, body, opts]) => ({ body: body as CommittedSnapshotBody, opts }))
            .filter((call) => call.body.type === 'message'
                && !call.body.sidechainId
                && call.opts?.meta?.happierStreamSegmentV1?.segmentState === 'complete')
            .map((call) => String(call.body?.message ?? ''));

        expect(assistantMessages).toEqual(expect.arrayContaining(['Raw item answer', 'Normalized item answer']));
        expect(assistantMessages).not.toContain('Raw item answerNormalized item answer');
    });

    it('commits an item-scoped raw final before a following tool call boundary', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-raw-before-tool-');

        const eventOrder: string[] = [];
        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async (_provider: string, body: { type?: string }, opts: { meta?: Record<string, unknown> }) => {
                const segmentState = opts.meta?.happierStreamSegmentV1 && typeof opts.meta.happierStreamSegmentV1 === 'object'
                    ? (opts.meta.happierStreamSegmentV1 as { segmentState?: unknown }).segmentState
                    : null;
                if (body.type === 'message' && segmentState === 'complete') {
                    eventOrder.push('assistant-final');
                }
            }),
            sendCodexMessage: vi.fn((message: { type?: string }) => {
                if (message.type === 'tool-call') eventOrder.push('tool-call');
            }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-item-raw-final-before-tool-call');

        expect(eventOrder).toContain('assistant-final');
        expect(eventOrder).toContain('tool-call');
        expect(eventOrder.indexOf('assistant-final')).toBeLessThan(eventOrder.indexOf('tool-call'));
    });

    it('emits a canonical Diff tool when the app-server publishes turn diff updates', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-turn-diff-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-turn-diff');

        expect(session.sendCodexMessage.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({
                    type: 'tool-call',
                    name: 'Diff',
                    input: expect.objectContaining({
                        files: [
                            expect.objectContaining({
                                file_path: 'src/diffed.ts',
                                unified_diff: expect.stringContaining('src/diffed.ts'),
                            }),
                        ],
                        _happier: expect.objectContaining({
                            provider: 'codex',
                            rawToolName: 'CodexDiff',
                            sessionChangeScope: 'turn',
                            turnId: 'turn-bridge-turn-diff',
                        }),
                    }),
                })],
            ]),
        );
    });

    it('does not infer a canonical Diff tool from git when command-only app-server turns mutate files without fileChange events', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-command-only-git-diff-');
        for (const args of [
            ['init'],
            ['config', 'user.email', 'test@example.com'],
            ['config', 'user.name', 'Test User'],
            ['commit', '--allow-empty', '-m', 'init'],
        ]) {
            const result = await runScmCommand({ bin: 'git', cwd: root, args });
            expect(result.success, `${args.join(' ')} failed: ${result.stderr}`).toBe(true);
        }
        await writeFile(join(root, 'pre-existing-dirty.txt'), 'already dirty before the turn\n', 'utf8');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-command-only-git-diff');

        const diffCall = session.sendCodexMessage.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'tool-call' && message.name === 'Diff');
        expect(diffCall).toBeUndefined();
    });

    it('does not infer a canonical Diff tool from a filesystem snapshot when command-only app-server turns mutate files outside git', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-command-only-filesystem-diff-');
        await writeFile(join(root, 'pre-existing-dirty.txt'), 'already present before the turn\n', 'utf8');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-command-only-git-diff');

        const diffCall = session.sendCodexMessage.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === 'tool-call' && message.name === 'Diff');
        expect(diffCall).toBeUndefined();
    });

    it('bridges completed-only command results as a synthetic tool-call plus tool-result', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-completed-only-command-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-completed-only-command-result');

        expect(session.sendCodexMessage.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({
                    type: 'tool-call',
                    callId: 'call_failed_1',
                    name: 'CodexBash',
                    input: { command: 'mkdir -p /tmp/demo', cwd: '/repo' },
                })],
                [expect.objectContaining({
                    type: 'tool-call-result',
                    callId: 'call_failed_1',
                    output: expect.objectContaining({
                        stderr: expect.stringContaining('rejected by user'),
                        exitCode: 1,
                    }),
                })],
            ]),
        );
    });

    it('routes child-thread item notifications into a synthetic SubAgent sidechain without leaking them into the parent transcript', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-foreign-thread-streams-');

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-foreign-thread-streams');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; sidechainId?: string | null }, { localId: string; meta?: Record<string, any> }]
        >;
        const parentAssistantMessages = committedCalls
            .map(([, body]) => body)
            .filter((body) => body?.type === 'message' && !body.sidechainId)
            .map((body) => String(body.message ?? ''));
        expect(parentAssistantMessages.some((value) => value.includes('Child'))).toBe(false);

        const childAssistantMessages = committedCalls
            .map(([, body]) => body)
            .filter((body) => body?.type === 'message' && body.sidechainId === 'thread-child')
            .map((body) => String(body.message ?? ''));
        expect(childAssistantMessages.some((value) => value.includes('Child'))).toBe(true);
        expect(childAssistantMessages.some((value) => value.includes('final'))).toBe(true);
        expect(session.sendAgentMessageCommitted.mock.calls).toEqual(
            expect.arrayContaining([
                ['codex', expect.objectContaining({ type: 'message', message: 'Parent final' }), expect.any(Object)],
            ]),
        );
        expect(session.sendAgentMessageCommitted.mock.calls).not.toEqual(
            expect.arrayContaining([
                ['codex', expect.objectContaining({ type: 'message', message: 'Child ' }), expect.any(Object)],
                ['codex', expect.objectContaining({ type: 'message', message: 'Child final' }), expect.any(Object)],
            ]),
        );
        expect(session.sendAgentMessage.mock.calls).toEqual(
            expect.arrayContaining([
                ['codex', expect.objectContaining({
                    type: 'tool-call',
                    callId: 'thread-child',
                    name: 'SubAgent',
                    input: expect.objectContaining({
                        threadId: 'thread-child',
                    }),
                })],
                ['codex', expect.objectContaining({
                    type: 'tool-call',
                    callId: 'child_cmd',
                    name: 'CodexBash',
                    sidechainId: 'thread-child',
                })],
                ['codex', expect.objectContaining({
                    type: 'tool-call-result',
                    callId: 'child_cmd',
                    sidechainId: 'thread-child',
                })],
                ['codex', expect.objectContaining({
                    type: 'tool-result',
                    callId: 'thread-child',
                    output: expect.objectContaining({
                        status: 'completed',
                        threadId: 'thread-child',
                    }),
                })],
            ]),
        );
    });

    it('finalizes a known child whose terminal arrives after the primary turn has cleared', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-late-child-terminal-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const sendAgentMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendAgentMessage,
                sendAgentMessageCommitted: vi.fn(async () => {}),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-late-child-terminal');

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
        await waitForCondition(() => sendAgentMessage.mock.calls.some(([, message]) => (
            message?.type === 'tool-result' && message.callId === 'thread-late-child'
        )), {
            timeoutMs: 1_000,
            intervalMs: 2,
            label: 'late child terminal finalization',
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(sendAgentMessage.mock.calls.filter(([, message]) => (
            message?.type === 'tool-result' && message.callId === 'thread-late-child'
        ))).toHaveLength(1);
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
    });

    it('ignores an unknown mismatched terminal id until the owned provider turn completes', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-finalize-mismatched-turn-');

        const onThinkingChange = vi.fn();
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const sendAgentMessageCommitted = vi.fn(async (
            _provider: string,
            _body: { type?: string; message?: string },
        ) => {});
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn(), sessionTurnLifecycle, sendAgentMessageCommitted } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        // A terminal id that was never observed as the active provider turn is not authoritative.
        // The real owned turn continues streaming and must retain the sole lifecycle owner.
        await runtime.sendPrompt('ignore-unknown-mismatched-turn-completion');
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledWith({ provider: 'codex' });
        expect(sendAgentMessageCommitted.mock.calls).toEqual(expect.arrayContaining([
            [
                'codex',
                expect.objectContaining({
                    type: 'message',
                    message: 'Still owned by the active turn',
                }),
                expect.any(Object),
            ],
        ]));
    });

    it('keeps the native turn authoritative when a nonterminal error is followed by primary activity', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-nonterminal-error-owner-',
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        let observedContinuedMessage = false;
        const sendAgentMessageCommitted = vi.fn(async (
            _provider: string,
            message: Readonly<{ type?: string; message?: string }>,
            _options: unknown,
        ) => {
            observedContinuedMessage ||= (
                message.type === 'message'
                && message.message === 'Continued after usage warning'
            );
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendAgentMessageCommitted,
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        const prompt = runtime.sendPrompt('usage-limit-error-then-primary-activity');

        await waitForCondition(() => observedContinuedMessage, {
            timeoutMs: 2_000,
            intervalMs: 2,
            label: 'primary activity after nonterminal error',
        });

        expect(runtime.hasActiveProviderTurn()).toBe(true);
        expect(runtime.isTurnInFlight()).toBe(true);
        expect(sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();
        await expect(runtime.sendPrompt('must-not-start-second-turn'))
            .rejects.toThrow('Codex app-server already has a turn in flight');

        await runtime.steerPrompt('steer-existing-turn');
        await runtime.cancel();
        await expect(prompt).resolves.toBeUndefined();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'turn/start')).toHaveLength(1);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'turn/steer',
                params: expect.objectContaining({
                    expectedTurnId: 'turn-usage-limit-error-then-primary-activity',
                }),
            }),
            expect.objectContaining({
                method: 'turn/interrupt',
                params: expect.objectContaining({
                    turnId: 'turn-usage-limit-error-then-primary-activity',
                }),
            }),
        ]));
    });

    it('releases the native turn when the provider process exits after a nonterminal error', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-nonterminal-error-exit-',
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        const promptOutcome = runtime.sendPrompt('nonterminal-error-then-process-exit').catch((error: unknown) => error);

        await waitForCondition(() => runtime.hasActiveProviderTurn(), {
            timeoutMs: 1_000,
            intervalMs: 2,
            label: 'native owner before app-server exit',
        });
        await waitForCondition(async () => (
            await readRequestLog(requestLogPath)
        ).some((entry) => entry.method === 'test/process-exit'), {
            timeoutMs: 1_000,
            intervalMs: 2,
            label: 'fake app-server process-exit marker',
        });
        await waitForCondition(() => !runtime.hasActiveProviderTurn(), {
            timeoutMs: 1_000,
            intervalMs: 2,
            label: 'native owner release after app-server exit',
        });

        await expect(promptOutcome).resolves.toMatchObject({
            message: expect.stringContaining('Codex app-server exited before completing the request'),
        });
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledTimes(1);
    });

    it('does not let an unknown terminal id claim a pending turn before its provider id is observed', async () => {
        const { root } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-unknown-terminal-before-start-response-',
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        const prompt = runtime.sendPrompt('unknown-terminal-before-turn-start-response');
        await new Promise((resolve) => setTimeout(resolve, 45));

        expect(runtime.isTurnInFlight()).toBe(true);
        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();

        await prompt;
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
    });

    it('replays an owned terminal notification after the delayed turn start response identifies it', async () => {
        const { root } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-owned-terminal-before-start-response-',
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        const completed = await Promise.race([
            runtime.sendPrompt('owned-terminal-before-turn-start-response').then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
        ]);

        expect(completed).toBe(true);
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
    });

    it.each([
        'owned-then-unknown-terminal-before-turn-start-response',
        'unknown-then-owned-terminal-before-turn-start-response',
    ])('retains the owned early terminal when competing unknown terminals arrive before start acknowledgement (%s)', async (prompt) => {
        const { root } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-competing-terminals-before-start-response-',
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        const completed = await Promise.race([
            runtime.sendPrompt(prompt).then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
        ]);

        expect(completed).toBe(true);
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
    });

    it.each([
        'no-id-response-unknown-before-owned-start',
        'no-id-response-owned-terminal-before-owned-start',
    ])('waits for authoritative provider identity before accepting a concrete terminal after an id-less start response (%s)', async (prompt) => {
        const { root } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-idless-start-response-terminal-correlation-',
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        let resolved = false;
        const completion = runtime.sendPrompt(prompt).then(() => {
            resolved = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(resolved).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(true);
        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();

        await Promise.race([
            completion,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for authoritative turn identity')), 500)),
        ]);
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
    });

    it.each([
        'child-terminal-before-primary-identity-no-activity',
        'child-terminal-after-primary-idless-activity',
    ])('finalizes a child terminal without binding or buffering it against an unidentified primary (%s)', async (prompt) => {
        const { root } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-child-terminal-primary-correlation-',
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const sendAgentMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendAgentMessage,
            } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        let resolved = false;
        const completion = runtime.sendPrompt(prompt).then(() => {
            resolved = true;
        });
        await waitForCondition(() => sendAgentMessage.mock.calls.some(([, message]) => (
            message?.type === 'tool-result' && message.callId === 'thread-child-terminal'
        )), {
            timeoutMs: 200,
            intervalMs: 2,
            label: 'child terminal finalization before primary identity',
        });

        expect(resolved).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(true);
        expect(sessionTurnLifecycle.completeTurn).not.toHaveBeenCalled();
        expect(sendAgentMessage.mock.calls).toEqual(expect.arrayContaining([
            ['codex', expect.objectContaining({
                type: 'tool-result',
                callId: 'thread-child-terminal',
                output: expect.objectContaining({
                    status: 'completed',
                    threadId: 'thread-child-terminal',
                }),
            })],
        ]));

        await Promise.race([
            completion,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for the primary terminal')), 1_000)),
        ]);
        expect(runtime.isTurnInFlight()).toBe(false);
        expect(sessionTurnLifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(sessionTurnLifecycle.completeTurn).toHaveBeenCalledTimes(1);
    });

    it('bridges approval and request-user-input server requests through the permission handler', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-approvals-');

        const permissionHandler = {
            handleToolCall: vi
                .fn()
                .mockResolvedValueOnce({ decision: 'approved_for_session' })
                .mockResolvedValueOnce({ decision: 'approved' })
                .mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-approvals');

        expect(permissionHandler.handleToolCall).toHaveBeenNthCalledWith(
            1,
            'cmd_approval',
            'CodexBash',
            { command: 'rm -rf /tmp/demo', cwd: '/repo' },
        );
        expect(permissionHandler.handleToolCall).toHaveBeenNthCalledWith(
            2,
            'patch_approval',
            'CodexPatch',
            { changes: { 'src/file.ts': { hunks: 1 } } },
        );
        expect(permissionHandler.handleToolCall).toHaveBeenNthCalledWith(
            3,
            'tool_input',
            'mcp__playwright__browser_navigate',
            {
                url: 'https://example.com',
                requestUserInput: {
                    questions: [
                        expect.objectContaining({ id: 'freeform_note' }),
                        expect.objectContaining({ id: 'tool_questions' }),
                    ],
                },
            },
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'approval-cmd', params: null, result: { decision: 'acceptForSession' }, error: null }),
                expect.objectContaining({ id: 'approval-patch', params: null, result: { decision: 'accept' }, error: null }),
                expect.objectContaining({
                    id: 'request-input',
                    params: null,
                    result: {
                        answers: {
                            tool_questions: {
                                answers: ['Approve Once'],
                            },
                        },
                    },
                    error: null,
                }),
            ]),
        );
    });

    it('bridges permission escalation server requests through the generic permission handler', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-request-permissions-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved_for_session' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-request-permissions');

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'perm_request_1',
            'request_permissions',
            {
                cwd: '/repo',
                reason: 'Needs network access',
                permissions: {
                    network: { enabled: true },
                    fileSystem: { write: ['/repo/generated'] },
                },
            },
        );

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'request-permissions',
                    params: null,
                    result: {
                        permissions: {
                            network: { enabled: true },
                            fileSystem: { write: ['/repo/generated'] },
                        },
                        scope: 'session',
                    },
                    error: null,
                }),
            ]),
        );
    });

    it('bridges MCP elicitation server requests through the permission handler', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'mcp-elicitation-request',
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'mcp_tool_1',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('syncs completed Happier title tool calls to the Codex native thread name', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-completed');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        method: 'thread/name/set',
                        params: { threadId: 'thread-started', name: 'New Title' },
                        error: null,
                    }),
                ]),
            );
        } finally {
            await runtime.reset();
        }
    });

    it('syncs completed Happier title tool calls returned in MCP content envelopes to the Codex native thread name', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-content-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-completed-content-envelope');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        method: 'thread/name/set',
                        params: { threadId: 'thread-started', name: 'Content Envelope Title' },
                        error: null,
                    }),
                ]),
            );
        } finally {
            await runtime.reset();
        }
    });

    it('does not sync blank completed Happier title tool calls to the Codex native thread name', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-blank-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-blank-title');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog.filter((entry) => entry.method === 'thread/name/set')).toEqual([]);
        } finally {
            await runtime.reset();
        }
    });

    it('does not sync failed completed Happier title tool calls to the Codex native thread name', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-failed-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-failed');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog.filter((entry) => entry.method === 'thread/name/set')).toEqual([]);
        } finally {
            await runtime.reset();
        }
    });

    it('keeps completed Happier title tool calls accepted when Codex native title sync fails', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-native-title-sync-fails-');
        const sendCodexMessage = vi.fn();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage,
            } as any,
            permissionHandler: { handleToolCall: vi.fn() } as any,
        } as any);

        try {
            await runtime.startOrLoad({});
            await runtime.sendPrompt('bridge-mcp-title-tool-native-sync-fails');

            await new Promise((resolve) => setTimeout(resolve, 30));
            const requestLog = await readRequestLog(requestLogPath);

            expect(requestLog).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        method: 'thread/name/set',
                        params: { threadId: 'thread-started', name: 'fail-native-title-sync' },
                    }),
                ]),
            );
            expect(sendCodexMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'tool-call-result',
                    callId: 'mcp_title_native_fail',
                    output: { success: true, title: 'fail-native-title-sync' },
                }),
            );
        } finally {
            await runtime.reset();
        }
    });

    it('bridges MCP elicitation requests that use callId fields through the permission handler', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-callid-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-callid');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'mcp-elicitation-request-callid',
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'call_test_1',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('bridges MCP elicitation requests with request-scoped params.id without rebinding the active turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-param-id-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-param-id');

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'mcp-elicitation-request-param-id',
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'mcp_request_param_id_1',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
        expect(sessionTurnLifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'turn-bridge-mcp-elicitation-param-id',
        });
        expect(sessionTurnLifecycle.attachProviderTurnId).not.toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'mcp_request_param_id_1',
        });
    });

    it('declines id-less provider requests when no Codex turn is active', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-idle-mcp-request-', {
            emitIdleMcpRequestAfterThreadStart: true,
        });

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await waitForCondition(async () => {
            const requestLog = await readRequestLog(requestLogPath);
            return requestLog.some((entry) => entry.id === 'idle-mcp-request');
        }, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'idle MCP request response',
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'idle-mcp-request',
                result: { action: 'decline' },
            }),
        ]));
        expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
        expect(sessionTurnLifecycle.beginTurn).not.toHaveBeenCalled();
        expect(runtime.hasActiveProviderTurn()).toBe(false);
        expect(runtime.isTurnInFlight()).toBe(false);
    });

    it('bridges Codex mcpServer/elicitation requests that only include serverName + message + _meta.tool_params', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-meta-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-meta');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 0,
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            '0',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('bridges Codex mcpServer/elicitation requests that identify the tool through _meta.tool_title', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-meta-tool-title-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-meta-tool-title');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 0,
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            '0',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('prefers the elicitation message tool id over a display-only _meta.tool_title label', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-display-title-message-tool-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-display-title-with-message-tool');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 0,
                    params: null,
                    result: { action: 'accept', content: {} },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            '0',
            'mcp__happier__change_title',
            { title: 'New Title' },
        );
    });

    it('declines unidentified Codex mcpServer/elicitation requests with the app-server response shape', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-mcp-elicitation-unidentified-');

        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValueOnce({ decision: 'approved' }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-mcp-elicitation-unidentified');

        await new Promise((resolve) => setTimeout(resolve, 30));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 0,
                    params: null,
                    result: { action: 'decline' },
                    error: null,
                }),
            ]),
        );

        expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
    });

    it('bridges non-approval request-user-input prompts as AskUserQuestion and returns structured answers', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-user-action-');

        const permissionHandler = {
            handleToolCall: vi
                .fn()
                .mockResolvedValueOnce({
                    decision: 'approved',
                    answers: {
                        'Which session export behavior should the plan target?': ['Single JSON'],
                    },
                }),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted: vi.fn(async () => {}),
                sendCodexMessage: vi.fn(),
            } as any,
            permissionHandler: permissionHandler as any,
        } as any);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-user-action');

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'tool_input_general',
            'AskUserQuestion',
            {
                questions: [
                    {
                        header: 'Export Shape',
                        question: 'Which session export behavior should the plan target?',
                        options: [
                            { label: 'Single JSON', description: 'Portable JSON export' },
                            { label: 'Single CSV', description: 'Spreadsheet export' },
                        ],
                        multiSelect: false,
                    },
                ],
            },
        );

        await waitForCondition(async () => {
            const requestLog = await readRequestLog(requestLogPath);
            return requestLog.some((entry) => entry.id === 'request-input-general');
        }, {
            timeoutMs: 500,
            intervalMs: 10,
            label: 'Codex app-server structured user-input response',
            debug: () => requestLogPath,
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'request-input-general',
                    params: null,
                    result: {
                        answers: {
                            export_shape: {
                                answers: ['Single JSON'],
                            },
                        },
                    },
                    error: null,
                }),
            ]),
        );
    });

    it('applies session mode, model, reasoning, and Fast overrides through app-server requests and republishes metadata', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-controls-');

        let metadata: Record<string, unknown> = { machineId: 'machine_1' };
        const updateMetadata = vi.fn((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
            metadata = updater(metadata);
            return metadata;
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
        });

        await runtime.startOrLoad({});
        await runtime.setSessionMode('plan');
        await runtime.setSessionConfigOption('service_tier', 'fast');
        await runtime.setSessionModel('gpt-5.4');
        await runtime.setSessionConfigOption('reasoning_effort', 'high');
        await runtime.sendPrompt('use-overrides');

        const latestMetadata = updateMetadata.mock.results.at(-1)?.value;

        expect(latestMetadata).toMatchObject({
            [SESSION_MODES_STATE_KEY]: expect.objectContaining({ currentModeId: 'plan' }),
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: expect.objectContaining({
                configOptions: [],
            }),
        });
        const modelsState = (latestMetadata as Record<string, unknown>)[SESSION_MODELS_STATE_KEY] as any;
        expect(modelsState).toMatchObject({ currentModelId: 'gpt-5.4' });
        const availableModels = Array.isArray(modelsState?.availableModels) ? modelsState.availableModels : [];
        const gptModel = availableModels.find((model: any) => model && model.id === 'gpt-5.4');
        expect(gptModel).toBeTruthy();
        const modelOptions = Array.isArray(gptModel?.modelOptions) ? gptModel.modelOptions : [];
        const byId = (id: string) => modelOptions.find((opt: any) => opt && opt.id === id);
        expect(byId('reasoning_effort')?.currentValue).toBe('high');
        expect(updateMetadata.mock.results.map((entry) => entry.value)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ codexSessionId: 'thread-started' }),
            ]),
        );

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(
            requestLog
                .filter((entry) => entry.method === 'collaborationMode/list')
                .every((entry) => JSON.stringify(entry.params ?? null) === '{}'),
        ).toBe(true);
        expect(
            requestLog
                .filter((entry) => entry.method === 'model/list')
                .every((entry) => JSON.stringify(entry.params ?? null) === '{}'),
        ).toBe(true);
        expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toEqual([]);
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'turn/start',
                    params: expect.objectContaining({
                        threadId: 'thread-started',
                        model: 'gpt-5.4',
                        effort: 'high',
                        serviceTier: 'fast',
                        collaborationMode: {
                            mode: 'plan',
                            settings: {
                                model: 'gpt-5.4',
                                reasoning_effort: 'high',
                                developer_instructions: null,
                            },
                        },
                    }),
                }),
            ]),
        );
    });

    it('includes preselected model, reasoning, and Fast service tier in fresh thread/start requests', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-thread-start-overrides-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.setSessionModel('gpt-5.4');
        await runtime.setSessionConfigOption('service_tier', 'fast');
        await runtime.setSessionConfigOption('reasoning_effort', 'high');
        await runtime.startOrLoad({});

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/start',
                    params: expect.objectContaining({
                        cwd: root,
                        model: 'gpt-5.4',
                        serviceTier: 'fast',
                        config: {
                            model_reasoning_effort: 'high',
                        },
                        persistExtendedHistory: true,
                    }),
                }),
            ]),
        );
    });

    it('keeps Fast service tier for the first turn even when thread/start responds with serviceTier: null', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-thread-start-fast-persist-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.setSessionModel('gpt-5.4');
        await runtime.setSessionConfigOption('service_tier', 'fast');
        await runtime.startOrLoad({});
        await runtime.sendPrompt('fast-persist');

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        const firstTurnStart = requestLog.find((entry) => entry.method === 'turn/start');
        expect(firstTurnStart).toMatchObject({
            params: expect.objectContaining({
                serviceTier: 'fast',
            }),
        });
    });

    it('clears Fast service tier by sending serviceTier: null when switching back to Standard', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-service-tier-clear-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        await runtime.setSessionConfigOption('service_tier', 'fast');
        await runtime.setSessionConfigOption('service_tier', 'standard');
        await runtime.sendPrompt('speed-standard');

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toEqual([]);
        const lastTurnStart = [...requestLog].reverse().find((entry) => entry.method === 'turn/start');
        expect(lastTurnStart).toMatchObject({
            params: expect.objectContaining({
                serviceTier: null,
            }),
        });
    });

    for (const authEnvVar of ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const) {
        it(`does not surface Speed controls when Codex is authenticated only by ${authEnvVar}`, async () => {
            const { root, requestLogPath: _requestLogPath, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-auth-');
            const scopedEnv = createCodexAppServerProcessEnv(fakeAppServer, {
                [authEnvVar]: 'sk-test-codex',
            });

            const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
                updater({ machineId: 'machine_1' }),
            );
            const runtime = createCodexAppServerRuntime({
                directory: root,
                processEnv: scopedEnv,
                onThinkingChange: vi.fn(),
                session: { updateMetadata } as any,
            });

            await runtime.startOrLoad({});

            expect(updateMetadata.mock.results.at(-1)?.value).toMatchObject({
                [SESSION_CONFIG_OPTIONS_STATE_KEY]: {
                    configOptions: [],
                },
            });
        });
    }

    it('forwards thread token usage updates and patches the active model context window from runtime telemetry', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-token-usage-');

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                sendCodexMessage,
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-token-usage');

        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'token_count',
            model: 'gpt-5.4',
            size: 1_000_000,
            tokens: expect.objectContaining({
                total: 1200,
                input: 700,
                cache_read: 200,
                output: 250,
                thought: 50,
            }),
        }));
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.not.objectContaining({
            used: expect.any(Number),
        }));

        const latestMetadata = updateMetadata.mock.results.at(-1)?.value as Record<string, unknown>;
        const modelsState = latestMetadata[SESSION_MODELS_STATE_KEY] as {
            currentModelId?: string;
            availableModels?: Array<Record<string, unknown>>;
        };
        expect(modelsState?.currentModelId).toBe('gpt-5.4');
        expect(modelsState?.availableModels).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'gpt-5.4',
                    contextWindowTokens: 1_000_000,
                }),
            ]),
        );
    });

    it('forwards app-server context compaction lifecycle notifications as session events', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-context-compaction-');

        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});
        await expect(runtime.sendPrompt('bridge-context-compaction')).resolves.toBeUndefined();

        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'context-compaction',
            phase: 'started',
            lifecycleId: 'compact_1',
            provider: 'codex',
            source: 'provider-event',
            providerEventId: 'compact_1',
        });
        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'context-compaction',
            phase: 'completed',
            lifecycleId: 'compact_1',
            provider: 'codex',
            source: 'provider-event',
            providerEventId: 'compact_1',
        });
    });

    it('triggers manual app-server compaction through thread/compact/start', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-manual-context-compaction-');

        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});
        const compactPromise = runtime.compactContext('/compact');
        await waitForCondition(() => runtime.isTurnInFlight(), {
            timeoutMs: 1_000,
            intervalMs: 1,
            label: 'manual compaction enters active control turn',
        });
        expect(runtime.canSteerPrompt()).toBe(false);
        await expect(runtime.steerPrompt('must-remain-queued-during-manual-compaction')).rejects.toThrow(/not steerable/i);
        await expect(compactPromise).resolves.toBeUndefined();

        const requestLog = (await readFile(requestLogPath, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/compact/start',
                params: { threadId: 'thread-started' },
            }),
        ]));
        expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'context-compaction',
            phase: 'started',
            lifecycleId: 'manual_compact_1',
        }));
        expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'context-compaction',
            phase: 'completed',
            lifecycleId: 'manual_compact_1',
        }));
    });

    it('surfaces failed turns as provider errors and aborts the pending turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-failed-turn-');

        const sendCodexMessage = vi.fn();
        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('failed-turn')).rejects.toThrow(/401 Unauthorized/);

        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('401 Unauthorized'),
        }));
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(1);
    });

    it('carries structured connected-service usage-limit classification on app-server turn failures', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-limit-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: null,
                groupId: null,
                resetsAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                planType: 'pro',
                source: 'structured_provider_error',
            },
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            issue: expect.objectContaining({
                source: 'usage_limit',
                usageLimit: expect.objectContaining({
                    resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                    recoverability: 'wait',
                    connectedService: {
                        serviceId: 'openai-codex',
                        profileId: null,
                        groupId: null,
                    },
                }),
            }),
        }));
    });

    it('carries selected Codex group context on app-server usage-limit failures', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-limit-group-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'happier',
                activeProfileId: 'leeroy',
                fallbackProfileId: 'backup',
                generation: 7,
            }]),
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_group_seed',
                accountLabel: null,
                profileId: 'leeroy',
                groupId: 'happier',
                generation: 7,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                credentialFingerprint: 'sha256:group001',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'leeroy',
                groupId: 'happier',
                groupGeneration: 7,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            issue: expect.objectContaining({
                source: 'usage_limit',
                usageLimit: expect.objectContaining({
                    recoverability: 'switch_account',
                    connectedService: {
                        serviceId: 'openai-codex',
                        profileId: 'leeroy',
                        groupId: 'happier',
                    },
                }),
            }),
        }));
    });

    it('attributes a delayed turn failure to frozen auth while keeping a later prompt eligible on hot-applied auth', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-turn-identity-race-',
            { accountReadResult: { account: { id: 'acct_replacement', email: 'replacement@example.test' } } },
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        (metadata as Record<string, unknown>).connectedServices = {
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'happier',
                    profileId: 'original',
                },
            },
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_original',
                accountLabel: 'original@example.test',
                profileId: 'original',
                groupId: 'happier',
                generation: 7,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                credentialFingerprint: 'sha256:11111111',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            onConnectedServiceAuthGenerationApplied: vi.fn(async () => {}),
            session: {
                sessionId: 'session-turn-identity-race',
                updateMetadata: vi.fn(async (handler: (current: Metadata) => Metadata) => {
                    metadata = handler(metadata);
                }),
                sessionTurnLifecycle,
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });
        const replacement = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'openai-codex',
            profileId: 'replacement',
            kind: 'oauth',
            expiresAt: 2_000,
            oauth: {
                accessToken: 'replacement-access',
                refreshToken: 'replacement-refresh',
                idToken: 'replacement-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_replacement',
                providerEmail: 'replacement@example.test',
            },
        });

        try {
            await runtime.startOrLoad({});
            const failedTurn = runtime.sendPrompt('usage-limit-after-mid-turn-auth-apply');
            await waitForCondition(async () => {
                const requestLog = await readRequestLog(requestLogPath);
                return requestLog.some((entry) => entry.method === 'turn/start');
            }, {
                timeoutMs: 1_000,
                intervalMs: 10,
                label: 'provider turn to start before connected-service auth apply',
            });

            const runtimeControls = runtime as typeof runtime & {
                applyConnectedServiceAuthGeneration: (request: unknown) => Promise<unknown>;
            };
            await expect(runtimeControls.applyConnectedServiceAuthGeneration({
                serviceId: 'openai-codex',
                reason: 'same_provider_account_exhausted',
                requireDirectLiveHotApply: true,
                expected: {
                    profileId: 'replacement',
                    groupId: 'happier',
                    generation: 8,
                    credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                },
                authGeneration: {
                    credential: replacement,
                    selection: {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'happier',
                        activeProfileId: 'replacement',
                        fallbackProfileId: 'original',
                        generation: 8,
                    },
                    forcedWorkspaceId: null,
                },
            })).resolves.toMatchObject({ ok: true, activeAccountId: 'acct_replacement' });
            (metadata as Record<string, unknown>).connectedServices = {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'happier',
                        profileId: 'replacement',
                    },
                },
            };

            await expect(failedTurn).rejects.toMatchObject({
                runtimeAuthClassification: {
                    kind: 'usage_limit',
                    profileId: 'original',
                    groupId: 'happier',
                    groupGeneration: 7,
                    credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                    sourceProviderAccountId: 'acct_original',
                    sourceAccountLabel: 'original@example.test',
                    failingAccessTokenFingerprint: 'sha256:11111111',
                },
            });

            await expect(runtime.sendPrompt('ordinary-prompt-after-superseded-failure')).resolves.toBeUndefined();
            await expect((runtime as unknown as {
                readConnectedServiceRuntimeIdentity: (request: unknown) => Promise<unknown>;
            }).readConnectedServiceRuntimeIdentity({
                serviceId: 'openai-codex',
                reason: 'diagnostic',
                expected: {
                    profileId: 'replacement',
                    groupId: 'happier',
                    generation: 8,
                },
                requireExactProof: true,
            })).resolves.toMatchObject({
                ok: true,
                runtime: {
                    profileId: 'replacement',
                    groupId: 'happier',
                    generation: 8,
                    credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('keeps provider-started turn failures provisional when auth changes before first observation', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-provider-started-identity-race-',
            {
                emitGoalContinuationUsageLimitFailure: true,
                accountReadResult: {
                    account: { id: 'acct_replacement', email: 'replacement@example.test' },
                },
            },
        );
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_original',
                accountLabel: 'original@example.test',
                profileId: 'original',
                groupId: 'happier',
                generation: 7,
                credentialFingerprint: 'sha256:11111111',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            onConnectedServiceAuthGenerationApplied: vi.fn(async () => {}),
            session: {
                sessionId: 'session-provider-started-identity-race',
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });
        const replacement = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'openai-codex',
            profileId: 'replacement',
            kind: 'oauth',
            expiresAt: 2_000,
            oauth: {
                accessToken: 'replacement-access',
                refreshToken: 'replacement-refresh',
                idToken: 'replacement-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_replacement',
                providerEmail: 'replacement@example.test',
            },
        });

        try {
            await runtime.startOrLoad({});
            await (runtime as unknown as { setGoal: (objective: string) => Promise<void> })
                .setGoal('Continue autonomously under the current credential');
            const runtimeControls = runtime as typeof runtime & {
                applyConnectedServiceAuthGeneration: (request: unknown) => Promise<unknown>;
            };
            await expect(runtimeControls.applyConnectedServiceAuthGeneration({
                serviceId: 'openai-codex',
                reason: 'same_provider_account_exhausted',
                requireDirectLiveHotApply: true,
                expected: { profileId: 'replacement', groupId: 'happier', generation: 8 },
                authGeneration: {
                    credential: replacement,
                    selection: {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'happier',
                        activeProfileId: 'replacement',
                        fallbackProfileId: 'original',
                        generation: 8,
                    },
                    forcedWorkspaceId: null,
                },
            })).resolves.toMatchObject({ ok: true, activeAccountId: 'acct_replacement' });

            await waitForCondition(() => vi.mocked(sessionTurnLifecycle.failTurn).mock.calls.length > 0, {
                timeoutMs: 1_000,
                intervalMs: 10,
                label: 'provider-started usage-limit failure after auth observation race',
            });
            expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
                provider: 'codex',
                issue: expect.objectContaining({
                    source: 'usage_limit',
                    usageLimit: expect.objectContaining({
                        recoverability: 'wait',
                        connectedService: {
                            serviceId: 'openai-codex',
                            profileId: null,
                            groupId: null,
                        },
                    }),
                }),
            }));
        } finally {
            await runtime.reset();
        }
    });

    it('does not infer connected-service failure identity from mutable session metadata', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-limit-metadata-group-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        (metadata as Record<string, unknown>).connectedServices = {
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'happier',
                    profileId: 'leeroy',
                },
            },
        };

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: null,
                groupId: null,
            },
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            issue: expect.objectContaining({
                source: 'usage_limit',
                usageLimit: expect.objectContaining({
                    recoverability: 'wait',
                    connectedService: {
                        serviceId: 'openai-codex',
                        profileId: null,
                        groupId: null,
                    },
                }),
            }),
        }));
    });

    it('prefers current session connected-service bindings over stale app-server env for usage-limit attribution', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-limit-stale-env-group-', {
            rateLimitReadResult: {
                plan_type: 'pro',
                primary: {
                    used_percent: 100,
                    resets_at: '2026-05-17T12:00:00.000Z',
                },
            },
            accountReadResult: {
                account: {
                    email: 'team@example.test',
                },
            },
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        (metadata as Record<string, unknown>).connectedServices = {
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'happier',
                    profileId: 'backup',
                },
            },
        };
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'happier',
                activeProfileId: 'primary',
                fallbackProfileId: 'backup',
                generation: 7,
            }]),
        });
        const onUsageLimitGroupRecovery = vi.fn(async () => ({
            handled: true,
            report: {
                ok: true,
                result: {
                    status: 'switch_attempted',
                    result: { status: 'no_eligible_member' },
                },
            },
            statusCode: 'switch_attempted_no_eligible_member',
            statusMessage: 'No eligible connected-service account is available.',
        }));
        const onRateLimitSnapshot = vi.fn();

        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_team_seeded',
                accountLabel: 'team@example.test',
                profileId: 'backup',
                groupId: 'happier',
                generation: 7,
                credentialFingerprint: 'sha256:deadbeef',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            onRateLimitSnapshot,
            onUsageLimitGroupRecovery,
            session: {
                sessionId: 'session-stale-env-group',
                updateMetadata: vi.fn(async (updater: (current: Metadata) => Metadata) => {
                    metadata = updater(metadata);
                }),
                sessionTurnLifecycle,
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});

            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: {
                    kind: 'usage_limit',
                    serviceId: 'openai-codex',
                    profileId: 'backup',
                    groupId: 'happier',
                    groupGeneration: 7,
                    sourceProviderAccountId: 'acct_team_seeded',
                    sourceAccountLabel: 'team@example.test',
                    failingAccessTokenFingerprint: 'sha256:deadbeef',
                },
            });
            expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
                provider: 'codex',
                issue: expect.objectContaining({
                    source: 'usage_limit',
                    usageLimit: expect.objectContaining({
                        recoverability: 'switch_account',
                        connectedService: {
                            serviceId: 'openai-codex',
                            profileId: 'backup',
                            groupId: 'happier',
                        },
                    }),
                }),
            }));
            expect(onRateLimitSnapshot).toHaveBeenCalledWith({
                plan_type: 'pro',
                primary: {
                    used_percent: 100,
                    resets_at: '2026-05-17T12:00:00.000Z',
                },
            }, {
                activeAccountId: 'acct_team_seeded',
                accountLabel: 'team@example.test',
                rawResetCredits: null,
                appliedIdentity: expect.objectContaining({
                    serviceId: 'openai-codex',
                    profileId: 'backup',
                    groupId: 'happier',
                    groupGeneration: 7,
                    activeAccountId: 'acct_team_seeded',
                }),
                policyDisposition: 'evidence_only',
            });
            const requestLogBeforeManualCheck = await readRequestLog(requestLogPath);
            expect(requestLogBeforeManualCheck.map((entry) => entry.method)).toEqual(expect.arrayContaining([
                'account/rateLimits/read',
                'account/read',
            ]));
            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };
            await expect(runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-stale-env-group',
            })).resolves.toMatchObject({
                ok: true,
                recovery: {
                    selectedAuth: {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'happier',
                        profileId: 'backup',
                    },
                },
            });
            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({
                sessionId: 'session-stale-env-group',
            })).resolves.toMatchObject({
                ok: true,
                status: 'waiting',
            });
            expect(onUsageLimitGroupRecovery).toHaveBeenCalledWith({
                sessionId: 'session-stale-env-group',
                classification: expect.objectContaining({
                    kind: 'usage_limit',
                    serviceId: 'openai-codex',
                    groupId: 'happier',
                    profileId: 'backup',
                }),
            });
        } finally {
            await runtime.reset();
        }
    });

    it('fails closed instead of joining a mismatched live account to the seeded profile and generation', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-limit-live-account-id-', {
            rateLimitReadResult: {
                plan_type: 'pro',
                primary: {
                    used_percent: 100,
                    resets_at: '2026-05-17T12:00:00.000Z',
                },
            },
            accountReadResult: {
                chatgpt_account_id: 'acct_live_codex',
                account: {
                    email: 'live@example.test',
                },
            },
        });
        const metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        (metadata as Record<string, unknown>).connectedServices = {
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'happier',
                    profileId: 'backup',
                },
            },
        };
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'happier',
                activeProfileId: 'backup',
                generation: 7,
            }]),
        });
        const onRateLimitSnapshot = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_seeded_stale',
                accountLabel: 'seeded@example.test',
                profileId: 'backup',
                groupId: 'happier',
                generation: 7,
                credentialFingerprint: 'sha256:seeded1',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            onRateLimitSnapshot,
            onUsageLimitGroupRecovery: vi.fn(async () => ({
                handled: true,
                report: {
                    ok: true,
                    result: {
                        status: 'switch_attempted',
                        result: { status: 'no_eligible_member' },
                    },
                },
                statusCode: 'switch_attempted_no_eligible_member',
                statusMessage: 'No eligible connected-service account is available.',
            })),
            session: {
                sessionId: 'session-live-account-id',
                updateMetadata: vi.fn(),
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});

            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: {
                    kind: 'usage_limit',
                    serviceId: 'openai-codex',
                    profileId: 'backup',
                    groupId: 'happier',
                },
            });
            expect(onRateLimitSnapshot).toHaveBeenCalledWith({
                plan_type: 'pro',
                primary: {
                    used_percent: 100,
                    resets_at: '2026-05-17T12:00:00.000Z',
                },
            }, {
                activeAccountId: null,
                accountLabel: null,
                rawResetCredits: null,
                policyDisposition: 'evidence_only',
            });
            await expect((runtime as any).readConnectedServiceRuntimeIdentity({
                serviceId: 'openai-codex',
                reason: 'same_provider_account_exhausted',
                expected: {
                    profileId: 'backup',
                    groupId: 'happier',
                    generation: 7,
                },
                requireExactProof: true,
            })).resolves.toEqual({
                ok: false,
                errorCode: 'runtime_identity_probe_missing_exact_identity',
                error: 'runtime_identity_probe_missing_exact_identity',
            });
        } finally {
            await runtime.reset();
        }
    });

    it('persists observed stable Codex usage-limit failures through the real session lifecycle', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-stable-usage-limit-');
        const mutations: unknown[] = [];
        const sessionTurnLifecycle = createSessionTurnLifecycle({
            sessionId: 'session-stable-usage-limit',
            createId: () => `stable-${mutations.length}`,
            now: () => 1_700_000_000_000 + mutations.length,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });

        const sendCodexMessage = vi.fn((body: ACPMessageData) => {
            void sessionTurnLifecycle.observeAcpLifecycleMarker({
                provider: 'codex',
                body,
            }).pendingWrite;
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-stable-usage-limit',
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-stable-message')).rejects.toThrow(/usage limit/i);

        expect(mutations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                action: 'begin',
                provider: 'codex',
            }),
            expect.objectContaining({
                action: 'fail',
                provider: 'codex',
                issue: expect.objectContaining({
                    source: 'usage_limit',
                    usageLimit: expect.objectContaining({
                        v: 1,
                        recoverability: 'wait',
                    }),
                }),
            }),
        ]));
    });

    it('persists alternate reused refresh-token wording as a connected-service auth failure', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-refresh-reused-');
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'happier',
                activeProfileId: 'bot',
                fallbackProfileId: 'leeroy',
                generation: 9,
            }]),
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_bot',
                accountLabel: 'bot@example.test',
                profileId: 'bot',
                groupId: 'happier',
                generation: 9,
                credentialFingerprint: 'sha256:b0b0b0b0',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-refresh-token-reused',
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('refresh-token-was-already-used')).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'refresh_failed',
                limitCategory: 'auth_invalid',
                serviceId: 'openai-codex',
                profileId: 'bot',
                groupId: 'happier',
            },
        });
        expect(sessionTurnLifecycle.failTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            issue: expect.objectContaining({
                source: 'auth_error',
                usageLimit: expect.objectContaining({
                    limitCategory: 'auth_invalid',
                    connectedService: {
                        serviceId: 'openai-codex',
                        profileId: 'bot',
                        groupId: 'happier',
                    },
                }),
            }),
        }));
    });

    it('persists early app-server usage-limit errors before the turn start response is adopted', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-early-usage-limit-');
        const mutations: unknown[] = [];
        const sessionTurnLifecycle = createSessionTurnLifecycle({
            sessionId: 'session-early-usage-limit',
            createId: () => `early-${mutations.length}`,
            now: () => 1_700_000_000_000 + mutations.length,
            enqueueSessionTurn: async (mutation) => {
                mutations.push(mutation);
            },
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'happier',
                activeProfileId: 'bot',
                fallbackProfileId: 'leeroy',
                generation: 9,
            }]),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_bot',
                accountLabel: 'bot@example.test',
                profileId: 'bot',
                groupId: 'happier',
                generation: 9,
                credentialFingerprint: 'sha256:b0b0b0b0',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-early-usage-limit',
                updateMetadata: vi.fn(),
                sessionTurnLifecycle,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        const onPromptAcceptedByProvider = vi.fn();
        runtime.setOnPromptAcceptedByProvider(onPromptAcceptedByProvider);
        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('usage-limit-before-turn-response', { userMessageSeq: 50 })).rejects.toMatchObject({
            runtimeAuthClassification: {
                kind: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'bot',
                groupId: 'happier',
            },
        });

        expect(mutations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                action: 'fail',
                provider: 'codex',
                issue: expect.objectContaining({
                    source: 'usage_limit',
                    usageLimit: expect.objectContaining({
                        recoverability: 'switch_account',
                        connectedService: {
                            serviceId: 'openai-codex',
                            profileId: 'bot',
                            groupId: 'happier',
                        },
                    }),
                }),
            }),
        ]));
        expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
            providerTurnId: 'turn-usage-limit-before-turn-response',
            userMessageSeq: 50,
        });
    });

    it('arms usage-limit wait/resume from the latest issue and probes Codex rate limits on check-now', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-recovery-');
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const rememberUsageLimitRecoveryPreference = vi.fn(async () => {});
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                {
                    kind: 'profile',
                    serviceId: 'openai-codex',
                    profileId: 'work',
                },
            ]),
        });
        const session = {
            sessionId: 'session-usage-recovery',
            updateMetadata,
            sessionTurnLifecycle,
            getMetadataSnapshot: () => metadata,
            sendCodexMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
        } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'];
        const runtimeParams: Parameters<typeof createCodexAppServerRuntime>[0] & {
            rememberUsageLimitRecoveryPreference: typeof rememberUsageLimitRecoveryPreference;
        } = {
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session,
            rememberUsageLimitRecoveryPreference,
        };
        const runtime = createCodexAppServerRuntime(runtimeParams);

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: {
                    kind: 'usage_limit',
                },
            });
            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string; rememberPreference?: boolean; resumePromptMode?: 'standard' | 'off' | 'custom' }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };

            expect(runtimeControls.enableUsageLimitWaitResume).toBeTypeOf('function');
            await expect(runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-usage-recovery',
                rememberPreference: true,
                resumePromptMode: 'custom',
            })).resolves.toMatchObject({
                ok: true,
                recovery: {
                    status: 'waiting',
                    resumePromptMode: 'custom',
                },
            });
            expect(rememberUsageLimitRecoveryPreference).toHaveBeenCalledTimes(1);
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'waiting',
                    resumePromptMode: 'custom',
                    resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                    selectedAuth: {
                        kind: 'profile',
                        serviceId: 'openai-codex',
                        profileId: 'work',
                    },
                },
            });

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({ sessionId: 'session-usage-recovery' })).resolves.toMatchObject({
                ok: true,
                status: 'resumed',
            });
            const requestLog = await readRequestLog(requestLogPath);
            expect(requestLog.map((entry) => entry.method)).toContain('account/rateLimits/read');
            expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toEqual([
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'thread-started',
                    }),
                }),
            ]);
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'cancelled',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('allocates distinct same-millisecond epochs through the production metadata transaction and preserves them across restart', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-cas-');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        let metadata: Metadata = {
            ...createRuntimeMetadata(root),
            sessionUsageLimitRecoveryV1: {
                v: 1,
                status: 'waiting',
                issueFingerprint: 'base-issue',
                armedAtMs: 999,
                resetAtMs: 5_000,
                nextCheckAtMs: 5_000,
                attemptCount: 0,
                maxAttempts: 3,
                lastProbeError: null,
                resumePromptMode: 'standard',
                selectedAuth: { kind: 'native' },
            },
        };
        const pendingUpdates: Array<Readonly<{
            commit: () => void;
        }>> = [];
        let holdUsageUpdates = false;
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            if (!holdUsageUpdates) {
                metadata = handler(metadata);
                return;
            }
            await new Promise<void>((resolve, reject) => {
                pendingUpdates.push({
                    commit: () => {
                        try {
                            metadata = handler(metadata);
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                    },
                });
            });
        });
        const createRuntime = () => createCodexAppServerRuntime({
            directory: root,
            processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-cas',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });
        const olderRuntime = createRuntime();
        const newerRuntime = createRuntime();

        try {
            await Promise.all([olderRuntime.startOrLoad({}), newerRuntime.startOrLoad({})]);
            await Promise.all([
                expect(olderRuntime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({ runtimeAuthClassification: { kind: 'usage_limit' } }),
                expect(newerRuntime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({ runtimeAuthClassification: { kind: 'usage_limit' } }),
            ]);
            const olderControls = olderRuntime as typeof olderRuntime & {
                enableUsageLimitWaitResume: (request: { sessionId: string; issueFingerprint: string }) => Promise<unknown>;
            };
            const newerControls = newerRuntime as typeof newerRuntime & {
                enableUsageLimitWaitResume: (request: { sessionId: string; issueFingerprint: string }) => Promise<unknown>;
            };

            holdUsageUpdates = true;
            const older = olderControls.enableUsageLimitWaitResume({
                sessionId: 'session-usage-cas',
                issueFingerprint: 'z-older',
            });
            const newer = newerControls.enableUsageLimitWaitResume({
                sessionId: 'session-usage-cas',
                issueFingerprint: 'a-newer',
            });
            await waitForCondition(() => pendingUpdates.length === 2, {
                timeoutMs: 1_000,
                label: 'two production usage-limit metadata transactions',
            });
            pendingUpdates[0]!.commit();
            const olderResult = await older;
            pendingUpdates[1]!.commit();
            const newerResult = await newer;

            expect(olderResult).toMatchObject({ ok: true, recovery: { issueFingerprint: 'z-older', armedAtMs: 1_000 } });
            expect(newerResult).toMatchObject({ ok: true, recovery: { issueFingerprint: 'a-newer', armedAtMs: 1_001 } });
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: { issueFingerprint: 'a-newer', armedAtMs: 1_001 },
            });

            await Promise.all([olderRuntime.reset(), newerRuntime.reset()]);
            holdUsageUpdates = false;
            const replacement = createRuntime();
            try {
                await replacement.startOrLoad({});
                await expect(replacement.sendPrompt('usage-limit-structured')).rejects.toMatchObject({ runtimeAuthClassification: { kind: 'usage_limit' } });
                const replacementControls = replacement as typeof replacement & {
                    enableUsageLimitWaitResume: (request: { sessionId: string; issueFingerprint: string }) => Promise<unknown>;
                };
                await expect(replacementControls.enableUsageLimitWaitResume({
                    sessionId: 'session-usage-cas',
                    issueFingerprint: 'm-after-restart',
                })).resolves.toMatchObject({
                    ok: true,
                    recovery: { issueFingerprint: 'm-after-restart', armedAtMs: 1_002 },
                });
            } finally {
                await replacement.reset();
            }
        } finally {
            nowSpy.mockRestore();
            await Promise.allSettled([olderRuntime.reset(), newerRuntime.reset()]);
        }
    });

    it('reports a superseded exact cancel when attempt B commits between attempt A observation and settlement', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-cancel-cas-');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_001);
        let metadata: Metadata = createRuntimeMetadata(root);
        const pendingUpdates: Array<Readonly<{ commit: () => void }>> = [];
        let holdUsageUpdates = false;
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            if (!holdUsageUpdates) {
                metadata = handler(metadata);
                return;
            }
            await new Promise<void>((resolve, reject) => {
                pendingUpdates.push({
                    commit: () => {
                        try {
                            metadata = handler(metadata);
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                    },
                });
            });
        });
        const createRuntime = () => createCodexAppServerRuntime({
            directory: root,
            processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-cancel-cas',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });
        const cancellingRuntime = createRuntime();
        const rearmingRuntime = createRuntime();

        try {
            await Promise.all([cancellingRuntime.startOrLoad({}), rearmingRuntime.startOrLoad({})]);
            await expect(rearmingRuntime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({ runtimeAuthClassification: { kind: 'usage_limit' } });
            metadata = {
                ...createRuntimeMetadata(root),
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status: 'waiting',
                    issueFingerprint: 'attempt-a',
                    armedAtMs: 1_000,
                    resetAtMs: 5_000,
                    nextCheckAtMs: 5_000,
                    attemptCount: 0,
                    maxAttempts: 3,
                    lastProbeError: null,
                    resumePromptMode: 'standard',
                    selectedAuth: { kind: 'native' },
                },
            };
            const cancelControls = cancellingRuntime as typeof cancellingRuntime & {
                cancelUsageLimitWaitResume: (request: { sessionId: string; issueFingerprint: string; armedAtMs: number }) => Promise<unknown>;
            };
            const rearmControls = rearmingRuntime as typeof rearmingRuntime & {
                enableUsageLimitWaitResume: (request: { sessionId: string; issueFingerprint: string }) => Promise<unknown>;
                cancelUsageLimitWaitResume: (request: { sessionId: string; issueFingerprint: string; armedAtMs: number }) => Promise<unknown>;
            };

            holdUsageUpdates = true;
            const cancelA = cancelControls.cancelUsageLimitWaitResume({
                sessionId: 'session-usage-cancel-cas',
                issueFingerprint: 'attempt-a',
                armedAtMs: 1_000,
            });
            await waitForCondition(() => pendingUpdates.length === 1, { timeoutMs: 1_000, label: 'attempt A cancel transaction' });
            const enableB = rearmControls.enableUsageLimitWaitResume({
                sessionId: 'session-usage-cancel-cas',
                issueFingerprint: 'attempt-b',
            });
            await waitForCondition(() => pendingUpdates.length === 2, { timeoutMs: 1_000, label: 'attempt B rearm transaction' });
            pendingUpdates[1]!.commit();
            const enabledB = await enableB as { recovery: { armedAtMs: number } };
            pendingUpdates[0]!.commit();

            await expect(cancelA).resolves.toMatchObject({
                ok: false,
                errorCode: 'usage_limit_recovery_attempt_superseded',
            });
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: { issueFingerprint: 'attempt-b', armedAtMs: enabledB.recovery.armedAtMs, status: 'waiting' },
            });

            holdUsageUpdates = false;
            await expect(rearmControls.cancelUsageLimitWaitResume({
                sessionId: 'session-usage-cancel-cas',
                issueFingerprint: 'attempt-b',
                armedAtMs: enabledB.recovery.armedAtMs,
            })).resolves.toMatchObject({ ok: true, recovery: { status: 'cancelled' } });
        } finally {
            nowSpy.mockRestore();
            await Promise.allSettled([cancellingRuntime.reset(), rearmingRuntime.reset()]);
        }
    });

    it('returns a typed failure when the production usage-limit metadata transaction cannot persist', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-persist-failure-');
        let metadata: Metadata = createRuntimeMetadata(root);
        let failUsagePersistence = false;
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            const next = handler(metadata);
            if (failUsagePersistence && SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY in next) {
                throw new Error('metadata persistence unavailable');
            }
            metadata = next;
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-persist-failure',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({ runtimeAuthClassification: { kind: 'usage_limit' } });
            failUsagePersistence = true;
            const controls = runtime as typeof runtime & {
                enableUsageLimitWaitResume: (request: { sessionId: string; issueFingerprint: string }) => Promise<unknown>;
            };
            await expect(controls.enableUsageLimitWaitResume({
                sessionId: 'session-usage-persist-failure',
                issueFingerprint: 'persist-failure',
            })).resolves.toMatchObject({
                ok: false,
                errorCode: 'usage_limit_recovery_persistence_failed',
            });
            expect(metadata).not.toHaveProperty(SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY);
        } finally {
            await runtime.reset();
        }
    });

    it.each([
        ['mismatched generation', JSON.stringify({ daemonExecutionGenerationV1: 'daemon-after-restart' })],
        ['malformed JSON', '{'],
        ['non-string generation field', JSON.stringify({ daemonExecutionGenerationV1: ['daemon-before-restart'] })],
        ['missing daemon state', null],
    ])('keeps a surviving runner automatic usage-limit retry active across %s', async (_label, daemonStateContents) => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-stale-daemon-usage-recovery-',
        );
        const daemonStatePath = join(root, 'daemon.state.json');
        if (daemonStateContents !== null) {
            await writeFile(daemonStatePath, daemonStateContents);
        }
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            HAPPIER_DAEMON_EXECUTION_GENERATION_V1: 'daemon-before-restart',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            daemonStatePath,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-stale-daemon-usage-recovery',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });
            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };

            await runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-stale-daemon-usage-recovery',
            });
            await waitForCondition(async () => (
                (await readRequestLog(requestLogPath)).filter((entry) => entry.method === 'thread/resume').length === 1
            ), {
                timeoutMs: 2_000,
                label: 'surviving-runner usage recovery to continue',
            });

            const requestLog = await readRequestLog(requestLogPath);
            expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1);
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: { status: 'cancelled' },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('arms usage-limit recovery from the latest issue before probing on check-now', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-check-now-');
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-check-now',
                updateMetadata,
                sessionTurnLifecycle,
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });
            const runtimeControls = runtime as typeof runtime & {
                checkUsageLimitRecoveryNow?: (request: { sessionId: string; resumePromptMode?: 'standard' | 'off' | 'custom' }) => Promise<unknown>;
            };

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({
                sessionId: 'session-usage-check-now',
                resumePromptMode: 'off',
            })).resolves.toMatchObject({
                ok: true,
                status: 'resumed',
            });

            const requestLog = await readRequestLog(requestLogPath);
            expect(requestLog.map((entry) => entry.method)).toContain('account/rateLimits/read');
            expect(requestLog.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1);
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'cancelled',
                    resumePromptMode: 'off',
                    selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
                },
            });
            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({ sessionId: 'session-usage-check-now' })).resolves.toMatchObject({
                ok: true,
                status: 'rate_limited',
                errorCode: 'probe_rate_limited',
                retryAfterMs: expect.any(Number),
            });
        } finally {
            await runtime.reset();
        }
    });

    it('routes usage-limit rate-limit probes through the shared param-compat reader with null params when accepted', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-rate-limit-params-',
        );
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const sessionTurnLifecycle = createSessionTurnLifecycleTestDouble();
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-check-now',
                updateMetadata,
                sessionTurnLifecycle,
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });
            const runtimeControls = runtime as typeof runtime & {
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({ sessionId: 'session-usage-check-now' })).resolves.toMatchObject({
                ok: true,
                status: 'resumed',
            });

            const rateLimitReads = (await readRequestLog(requestLogPath))
                .filter((entry) => entry.method === 'account/rateLimits/read');
            expect(rateLimitReads.map((entry) => entry.params)).toEqual([null, null]);
        } finally {
            await runtime.reset();
        }
    });

    it('reruns connected-service group fallback when check-now finds the active Codex member still exhausted', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-group-recovery-', {
            rateLimitReadResult: {
                plan_type: 'pro',
                primary: {
                    used_percent: 100,
                    resets_at: '2026-05-17T12:00:00.000Z',
                },
            },
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const onUsageLimitGroupRecovery = vi.fn(async () => ({
            handled: true,
            statusCode: null,
            statusMessage: null,
            report: {
                ok: true,
                result: {
                    status: 'switch_attempted',
                    result: {
                        status: 'switched',
                        activeProfileId: 'backup',
                        generation: 2,
                        verificationByServiceId: {
                            'openai-codex': { status: 'verified', reason: 'active_account_match' },
                        },
                    },
                },
            },
        }));
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                {
                    kind: 'group',
                    serviceId: 'openai-codex',
                    groupId: 'team',
                    activeProfileId: 'primary',
                    fallbackProfileId: 'primary',
                    generation: 1,
                },
            ]),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            onUsageLimitGroupRecovery,
            session: {
                sessionId: 'session-usage-group-recovery',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });

            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };
            await expect(runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-usage-group-recovery',
            })).resolves.toMatchObject({
                ok: true,
                recovery: {
                    selectedAuth: {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'team',
                        profileId: 'primary',
                    },
                },
            });

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({ sessionId: 'session-usage-group-recovery' })).resolves.toMatchObject({
                ok: true,
                status: 'ready',
            });
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'paused',
                    nextCheckAtMs: null,
                    selectedAuth: {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'team',
                        profileId: 'backup',
                    },
                },
            });
            expect(onUsageLimitGroupRecovery).toHaveBeenCalledWith({
                sessionId: 'session-usage-group-recovery',
                classification: expect.objectContaining({
                    kind: 'usage_limit',
                    serviceId: 'openai-codex',
                    groupId: 'team',
                    profileId: 'primary',
                    resetsAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                    planType: 'pro',
                }),
            });
        } finally {
            await runtime.reset();
        }
    });

    it('surfaces typed group generation apply failures during usage-limit check-now', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-group-apply-failed-', {
            rateLimitReadResult: {
                plan_type: 'pro',
                primary: {
                    used_percent: 100,
                    resets_at: '2026-05-17T12:00:00.000Z',
                },
            },
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const onUsageLimitGroupRecovery = vi.fn(async () => ({
            handled: true,
            statusCode: null,
            statusMessage: null,
            report: {
                ok: true,
                result: {
                    status: 'switch_attempted',
                    result: {
                        status: 'generation_apply_failed',
                        activeProfileId: 'backup',
                        generation: 2,
                        errorCode: 'provider_session_state_unavailable_for_resume',
                    },
                },
            },
        }));
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
                {
                    kind: 'group',
                    serviceId: 'openai-codex',
                    groupId: 'team',
                    activeProfileId: 'primary',
                    fallbackProfileId: 'primary',
                    generation: 1,
                },
            ]),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            onUsageLimitGroupRecovery,
            session: {
                sessionId: 'session-usage-group-apply-failed',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });

            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };
            await runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-usage-group-apply-failed',
            });

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({
                sessionId: 'session-usage-group-apply-failed',
            })).resolves.toMatchObject({
                ok: true,
                status: 'exhausted',
            });
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'exhausted',
                    lastProbeError: 'connected_service_generation_apply_failed:provider_session_state_unavailable_for_resume',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('keeps usage-limit recovery waiting when the rate-limit probe fails transiently (never durable exhausted)', async () => {
        // RD-CDX-8: a transient `account/rateLimits/read` failure (timeout/conn-reset/RPC
        // unavailable, incl. a probe racing the hot-swap app-server restart) is not an
        // authoritative provider verdict and must keep the durable intent WAITING.
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-probe-failure-', {
            rejectRateLimitRead: true,
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-probe-failure',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });

            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };
            await runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-usage-probe-failure',
            });

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({
                sessionId: 'session-usage-probe-failure',
            })).resolves.toMatchObject({
                ok: true,
                status: 'waiting',
            });
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'waiting',
                    nextCheckAtMs: expect.any(Number),
                    lastProbeError: 'codex_app_server_rate_limit_probe_unavailable',
                },
            });
            const recovery = (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] as { nextCheckAtMs?: number };
            // Bounded degraded retry: never immediate, never terminal.
            expect(recovery.nextCheckAtMs).toBeGreaterThan(Date.now());
        } finally {
            await runtime.reset();
        }
    });

    it('routes a source-real token_invalidated quota-probe verdict into connected credential recovery', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-probe-token-invalid-', {
            rateLimitReadError: {
                code: -32000,
                message: 'unexpected status 401 Unauthorized: authentication token has been invalidated; auth error code: token_invalidated',
            },
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const onUsageLimitGroupRecovery = vi.fn(async () => ({
            handled: true,
            statusCode: null,
            statusMessage: null,
            report: {
                ok: true,
                result: { status: 'recovery_action_required', action: { kind: 'reconnect_profile' } },
            },
        }));
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'team',
                activeProfileId: 'primary',
                fallbackProfileId: 'primary',
                generation: 7,
            }]),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_primary',
                accountLabel: null,
                profileId: 'primary',
                groupId: 'team',
                generation: 7,
                credentialFingerprint: 'sha256:primary1',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            onUsageLimitGroupRecovery,
            session: {
                sessionId: 'session-usage-probe-token-invalid',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });
            const runtimeControls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };
            await runtimeControls.enableUsageLimitWaitResume?.({
                sessionId: 'session-usage-probe-token-invalid',
            });

            await expect(runtimeControls.checkUsageLimitRecoveryNow?.({
                sessionId: 'session-usage-probe-token-invalid',
            })).resolves.toMatchObject({ ok: true, status: 'exhausted' });
            expect(onUsageLimitGroupRecovery).toHaveBeenCalledWith({
                sessionId: 'session-usage-probe-token-invalid',
                classification: expect.objectContaining({
                    kind: 'auth_expired',
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'team',
                    groupGeneration: 7,
                }),
            });
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'exhausted',
                    lastProbeError: 'connected_service_probe_credential_recovery_committed',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it.each(['recovery_retry_scheduled', 'recovery_handler_failed', 'action_required'] as const)(
      'keeps waiting when token_invalidated recovery reports %s without a committed disposition',
      async (recoveryStatus) => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-probe-token-invalid-unhandled-', {
            rateLimitReadError: {
                code: -32000,
                message: 'unexpected status 401 Unauthorized: authentication token has been invalidated; auth error code: token_invalidated',
            },
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const onUsageLimitGroupRecovery = vi.fn(async () => ({
            handled: true,
            report: { ok: true, result: { status: recoveryStatus } },
            statusCode: null,
            statusMessage: null,
        }));
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                CODEX_HOME: join(root, 'codex-home'),
                OPENAI_API_KEY: 'test-openai-key',
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                    kind: 'group', serviceId: 'openai-codex', groupId: 'team', activeProfileId: 'primary', generation: 7,
                }]),
            }),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_primary',
                accountLabel: null,
                profileId: 'primary',
                groupId: 'team',
                generation: 7,
                credentialFingerprint: 'sha256:primary1',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            onUsageLimitGroupRecovery,
            session: {
                sessionId: 'session-usage-probe-token-invalid-unhandled',
                updateMetadata: vi.fn(async (handler: (current: Metadata) => Metadata) => { metadata = handler(metadata); }),
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });
            const controls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };
            await controls.enableUsageLimitWaitResume?.({ sessionId: 'session-usage-probe-token-invalid-unhandled' });
            await expect(controls.checkUsageLimitRecoveryNow?.({
                sessionId: 'session-usage-probe-token-invalid-unhandled',
            })).resolves.toMatchObject({ ok: true, status: 'waiting' });
            expect(onUsageLimitGroupRecovery).toHaveBeenCalledOnce();
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'waiting',
                    lastProbeError: 'connected_service_probe_credential_recovery_uncommitted',
                },
            });
        } finally {
            await runtime.reset();
        }
      },
    );

    it('settles token_invalidated waiting from an explicit terminal recovery receipt independent of presentation handling', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-usage-probe-terminal-receipt-', {
            rateLimitReadError: {
                code: -32000,
                message: 'unexpected status 401 Unauthorized: authentication token has been invalidated; auth error code: token_invalidated',
            },
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const onUsageLimitGroupRecovery = vi.fn(async () => ({
            handled: false,
            report: { ok: true, result: { status: 'recovery_retry_scheduled' } },
            statusCode: null,
            statusMessage: null,
            recoveryReceipt: {
                reportId: 'runtime-auth-report:terminal-receipt',
                attemptId: 'attempt-terminal-receipt',
                transition: 'terminal',
                eventLocalId: 'runtime-auth-recovery:attempt-terminal-receipt:terminal',
            },
        }));
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv: createCodexAppServerProcessEnv(fakeAppServer, {
                CODEX_HOME: join(root, 'codex-home'),
                OPENAI_API_KEY: 'test-openai-key',
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                    kind: 'group', serviceId: 'openai-codex', groupId: 'team', activeProfileId: 'primary', generation: 7,
                }]),
            }),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex', activeAccountId: 'acct_primary', accountLabel: null,
                profileId: 'primary', groupId: 'team', generation: 7,
                credentialFingerprint: 'sha256:primary1', source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            onUsageLimitGroupRecovery,
            session: {
                sessionId: 'session-usage-probe-terminal-receipt',
                updateMetadata: vi.fn(async (handler: (current: Metadata) => Metadata) => { metadata = handler(metadata); }),
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });
            const controls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
            };
            await controls.enableUsageLimitWaitResume?.({ sessionId: 'session-usage-probe-terminal-receipt' });
            await expect(controls.checkUsageLimitRecoveryNow?.({
                sessionId: 'session-usage-probe-terminal-receipt',
            })).resolves.toMatchObject({ ok: true, status: 'exhausted' });
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'exhausted',
                    lastProbeError: 'connected_service_probe_credential_recovery_committed',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('does not attribute a delayed quota-probe auth error to a credential hot-applied after the request began', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-quota-probe-identity-race-', {
            rateLimitReadDelayMs: 200,
            rateLimitReadError: {
                code: -32000,
                message: 'unexpected status 401 Unauthorized: authentication token has been invalidated; auth error code: token_invalidated',
            },
            accountReadResult: { account: { email: 'replacement@example.test' } },
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const onUsageLimitGroupRecovery = vi.fn(async () => ({
            handled: false,
            report: null,
            statusCode: null,
            statusMessage: null,
        }));
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv: createCodexAppServerProcessEnv(fakeAppServer),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_original',
                accountLabel: 'original@example.test',
                profileId: 'original',
                groupId: 'team',
                generation: 7,
                credentialFingerprint: 'sha256:original1',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            onUsageLimitGroupRecovery,
            onConnectedServiceAuthGenerationApplied: vi.fn(async () => {}),
            session: {
                sessionId: 'session-quota-probe-identity-race',
                updateMetadata: vi.fn(async (handler: (current: Metadata) => Metadata) => { metadata = handler(metadata); }),
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });
        const replacement = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'openai-codex',
            profileId: 'replacement',
            kind: 'oauth',
            expiresAt: 2_000,
            oauth: {
                accessToken: 'replacement-access',
                refreshToken: 'replacement-refresh',
                idToken: 'replacement-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_replacement',
                providerEmail: 'replacement@example.test',
            },
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });
            const controls = runtime as typeof runtime & {
                enableUsageLimitWaitResume?: (request: { sessionId: string }) => Promise<unknown>;
                checkUsageLimitRecoveryNow?: (request: { sessionId: string }) => Promise<unknown>;
                applyConnectedServiceAuthGeneration?: (request: unknown) => Promise<unknown>;
            };
            await controls.enableUsageLimitWaitResume?.({ sessionId: 'session-quota-probe-identity-race' });
            onUsageLimitGroupRecovery.mockClear();

            const check = controls.checkUsageLimitRecoveryNow?.({ sessionId: 'session-quota-probe-identity-race' });
            await new Promise((resolve) => setTimeout(resolve, 25));
            const apply = controls.applyConnectedServiceAuthGeneration?.({
                serviceId: 'openai-codex',
                reason: 'usage_limit',
                expected: { profileId: 'replacement', groupId: 'team', generation: 8 },
                authGeneration: {
                    credential: replacement,
                    selection: {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'team',
                        activeProfileId: 'replacement',
                        fallbackProfileId: 'original',
                        generation: 8,
                    },
                    forcedWorkspaceId: null,
                },
            });

            await expect(check).resolves.toMatchObject({ ok: true, status: 'waiting' });
            await expect(apply).resolves.toMatchObject({ ok: true, activeAccountId: 'acct_replacement' });
            expect(onUsageLimitGroupRecovery).not.toHaveBeenCalled();
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'waiting',
                    lastProbeError: 'codex_app_server_rate_limit_probe_unavailable',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('auto-arms usage-limit wait/resume when the account setting is auto-wait', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-auto-wait-');
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: {
                usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' },
            } as AccountSettings,
            settingsVersion: 1,
            loadedAtMs: Date.now(),
            settingsSecretsReadKeys: [],
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-auto-wait',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                runtimeAuthClassification: { kind: 'usage_limit' },
            });

            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'waiting',
                    resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
                    selectedAuth: { kind: 'native' },
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it.each(['off', 'custom'] as const)(
        'auto-arms usage-limit wait/resume preserving the account resumePromptMode=%s',
        async (resumePromptMode) => {
            const { root, fakeAppServer } = await createRuntimeFixture(`happier-codex-app-server-runtime-usage-auto-wait-resume-${resumePromptMode}-`);
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: {
                    usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait', resumePromptMode },
                } as AccountSettings,
                settingsVersion: 1,
                loadedAtMs: Date.now(),
                settingsSecretsReadKeys: [],
            });
            let metadata: Metadata = {
                path: root,
                host: 'test-host',
                homeDir: root,
                happyHomeDir: join(root, '.happier'),
                happyLibDir: join(root, '.happier', 'lib'),
                happyToolsDir: join(root, '.happier', 'tools'),
            };
            const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
                metadata = handler(metadata);
            });
            const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
                CODEX_HOME: join(root, 'codex-home'),
                OPENAI_API_KEY: 'test-openai-key',
            });
            const runtime = createCodexAppServerRuntime({
                directory: root,
                processEnv,
                onThinkingChange: vi.fn(),
                session: {
                    sessionId: `session-usage-auto-wait-resume-${resumePromptMode}`,
                    updateMetadata,
                    sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                    getMetadataSnapshot: () => metadata,
                    sendCodexMessage: vi.fn(),
                    sendSessionEvent: vi.fn(),
                } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
            });

            try {
                await runtime.startOrLoad({});
                await expect(runtime.sendPrompt('usage-limit-structured')).rejects.toMatchObject({
                    runtimeAuthClassification: { kind: 'usage_limit' },
                });

                // The auto-armed recovery intent must carry the account's configured resume-prompt
                // behavior, not silently default to 'standard'.
                expect(metadata).toMatchObject({
                    sessionUsageLimitRecoveryV1: {
                        status: 'waiting',
                        resumePromptMode,
                    },
                });
            } finally {
                await runtime.reset();
            }
        },
    );

    it('auto-arms usage-limit recovery with a derived next check when only retry-after timing is available', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-retry-after-auto-wait-');
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: {
                usageLimitRecoverySettingsV1: { v: 1, mode: 'auto_wait' },
            } as AccountSettings,
            settingsVersion: 1,
            loadedAtMs: Date.now(),
            settingsSecretsReadKeys: [],
        });
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-retry-after-auto-wait',
                updateMetadata,
                sessionTurnLifecycle: createSessionTurnLifecycleTestDouble(),
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});
            const beforeFailureMs = Date.now();
            await expect(runtime.sendPrompt('usage-limit-retry-after-only')).rejects.toMatchObject({
                runtimeAuthClassification: {
                    kind: 'usage_limit',
                    resetsAtMs: null,
                    retryAfterMs: 120_000,
                },
            });
            const afterFailureMs = Date.now();

            const recovery = (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] as {
                resetAtMs?: number | null;
                nextCheckAtMs?: number | null;
            };
            expect(recovery).toMatchObject({
                status: 'waiting',
                resetAtMs: null,
                selectedAuth: { kind: 'native' },
            });
            expect(recovery.nextCheckAtMs).toBeGreaterThanOrEqual(beforeFailureMs + 120_000);
            expect(recovery.nextCheckAtMs).toBeLessThanOrEqual(afterFailureMs + 120_000);
        } finally {
            await runtime.reset();
        }
    });

    it('keeps a persisted usage-limit intent dormant after start without resuming the provider', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-usage-recovery-restore-');
        let metadata: Metadata = {
            path: root,
            host: 'test-host',
            homeDir: root,
            happyHomeDir: join(root, '.happier'),
            happyLibDir: join(root, '.happier', 'lib'),
            happyToolsDir: join(root, '.happier', 'tools'),
            sessionUsageLimitRecoveryV1: {
                v: 1,
                status: 'waiting',
                issueFingerprint: 'usage-limit:session-usage-restore:1',
                armedAtMs: Date.now() - 1_000,
                resetAtMs: Date.now(),
                nextCheckAtMs: Date.now(),
                attemptCount: 0,
                maxAttempts: 3,
                lastProbeError: null,
                resumePromptMode: 'standard',
                selectedAuth: { kind: 'native' },
            },
        };
        const updateMetadata = vi.fn(async (handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                sessionId: 'session-usage-restore',
                updateMetadata,
                getMetadataSnapshot: () => metadata,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as unknown as Parameters<typeof createCodexAppServerRuntime>[0]['session'],
        });

        try {
            await runtime.startOrLoad({});

            await new Promise((resolve) => setTimeout(resolve, 100));
            const requestLog = await readRequestLog(requestLogPath);
            expect(requestLog.map((entry) => entry.method)).not.toContain('thread/resume');
            expect(metadata).toMatchObject({
                sessionUsageLimitRecoveryV1: {
                    status: 'waiting',
                },
            });
        } finally {
            await runtime.reset();
        }
    });

    it('publishes Codex account/rateLimits/updated snapshots to the runtime quota callback', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-rate-limit-update-');

        const onRateLimitSnapshot = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onRateLimitSnapshot,
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('rate-limit-update');

        expect(onRateLimitSnapshot).toHaveBeenCalledWith({
            rateLimits: {
                limitId: 'codex',
                limitName: null,
                primary: {
                    usedPercent: 88,
                    windowDurationMins: 300,
                    resetsAt: 1_779_098_400,
                },
                secondary: null,
                credits: null,
                planType: 'pro',
                rateLimitReachedType: null,
            },
        }, undefined);
    });

    it('notifies prompt acceptance only after the provider turn/started event', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-prompt-accepted-');

        const onPromptAcceptedByProvider = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        (runtime as any).setOnPromptAcceptedByProvider(onPromptAcceptedByProvider);

        await runtime.startOrLoad({});
        await runtime.sendPrompt('hello-world', {
            userMessageSeq: 42,
            appliedModelId: 'gpt-5.6-sol',
        } as any);

        expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
            userMessageSeq: 42,
            providerTurnId: 'turn-hello-world',
            appliedModelId: 'gpt-5.6-sol',
        });
        expect(onPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
    });

    it('uses the exact turn/start response as prompt acceptance while notification and completion remain outstanding', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-prompt-accepted-response-', {
            omitTurnStartedForPrompt: 'turn-start-response-only',
            omitTurnCompletedForPrompt: 'turn-start-response-only',
        });

        const onPromptAcceptedByProvider = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        (runtime as any).setOnPromptAcceptedByProvider(onPromptAcceptedByProvider);

        await runtime.startOrLoad({});
        const send = runtime.sendPrompt('turn-start-response-only', {
            localId: 'local-turn-start-response-only',
            userMessageSeq: 43,
        } as any);

        await vi.waitFor(() => {
            expect(onPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'turn/start',
                params: expect.objectContaining({
                    input: [expect.objectContaining({ text: 'turn-start-response-only' })],
                }),
            }),
        ]));
        expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
            localIds: ['local-turn-start-response-only'],
            userMessageSeq: 43,
            providerTurnId: 'turn-turn-start-response-only',
        });
        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.reset();
        await send.catch(() => undefined);
    });

    it('merges sparse Codex account/rateLimits/updated notifications with the last known snapshot', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-rate-limit-sparse-update-');

        const onRateLimitSnapshot = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onRateLimitSnapshot,
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('rate-limit-update-sparse-after-full');

        expect(onRateLimitSnapshot).toHaveBeenCalledTimes(2);
        expect(onRateLimitSnapshot.mock.calls[1]?.[0]).toEqual({
            rateLimits: {
                account: {
                    id: 'acct_live_codex',
                    email: 'codex-user@example.test',
                },
                primary: {
                    usedPercent: 88,
                    windowDurationMins: 300,
                    resetsAt: 1_779_098_400,
                },
                secondary: {
                    usedPercent: 40,
                    windowDurationMins: 10080,
                    resetsAt: 1_779_698_400,
                },
                planType: 'pro',
            },
        });
    });

    it('handles Codex ChatGPT token refresh requests without returning refresh tokens', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-chatgpt-refresh-');

        const onChatGptAuthTokensRefresh = vi.fn(async () => ({
            accessToken: 'fresh-access',
            chatgptAccountId: 'acct_123',
            chatgptPlanType: 'plus',
            credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        }));
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onChatGptAuthTokensRefresh,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_123',
                accountLabel: null,
                profileId: 'primary',
                groupId: 'main',
                generation: 7,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                credentialFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                source: 'spawn_selection',
            },
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-chatgpt-refresh');

        expect(onChatGptAuthTokensRefresh).toHaveBeenCalledWith({
            chatgptPlanType: 'plus',
        });
        await waitForCondition(async () => {
            const entries = await readRequestLog(requestLogPath);
            return entries.some((entry) => entry.id === 'refresh-chatgpt-tokens' && entry.result);
        }, {
            timeoutMs: 1_000,
            intervalMs: 5,
            label: 'ChatGPT token refresh response write',
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'refresh-chatgpt-tokens',
                result: {
                    accessToken: 'fresh-access',
                    chatgptAccountId: 'acct_123',
                    chatgptPlanType: 'plus',
                    credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                },
            }),
        ]));
        const refreshResponse = requestLog.find((entry) => entry.id === 'refresh-chatgpt-tokens' && entry.result);
        expect(refreshResponse?.result).not.toHaveProperty('refreshToken');
        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            requireExactProof: true,
        })).resolves.toMatchObject({
            ok: true,
            runtime: {
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            },
        });
    });

    it('retains the exact runtime revision when a surviving predecessor daemon omits it from a token refresh response', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-predecessor-chatgpt-refresh-',
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onChatGptAuthTokensRefresh: vi.fn(async () => ({
                accessToken: 'fresh-access-from-predecessor',
                chatgptAccountId: 'acct_123',
                chatgptPlanType: 'plus',
            })),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_123',
                accountLabel: null,
                profileId: 'primary',
                groupId: 'main',
                generation: 7,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                credentialFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                source: 'spawn_selection',
            },
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-chatgpt-refresh');
        await waitForCondition(async () => {
            const entries = await readRequestLog(requestLogPath);
            return entries.some((entry) => entry.id === 'refresh-chatgpt-tokens' && entry.result);
        }, {
            timeoutMs: 1_000,
            intervalMs: 5,
            label: 'predecessor ChatGPT token refresh response write',
        });
        const requestLog = await readRequestLog(requestLogPath);
        const refreshResponse = requestLog.find((entry) => entry.id === 'refresh-chatgpt-tokens' && entry.result);
        expect(refreshResponse?.result).not.toHaveProperty('credentialRevision');
        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            requireExactProof: true,
        })).resolves.toMatchObject({
            ok: true,
            runtime: {
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
        });
    });

    it('routes Codex cached-account changes to daemon runtime-auth recovery instead of locally resuming as success', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-auth-account-change-');

        const sendCodexMessage = vi.fn();
        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('account-mismatch-once')).rejects.toMatchObject({
            runtimeAuthClassification: expect.objectContaining({
                kind: 'account_changed',
                serviceId: 'openai-codex',
            }),
        });

        expect(runtime.getSessionId()).toBe('thread-started');
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(1);
        expect(requestLog.some((entry: { method: string }) => entry.method === 'thread/resume')).toBe(false);
        const retriedTurnStarts = requestLog.filter((entry: { method: string; params?: { input?: Array<{ text?: string }>; threadId?: string } }) =>
            entry.method === 'turn/start' && entry.params?.input?.[0]?.text === 'account-mismatch-once',
        );
        expect(retriedTurnStarts).toHaveLength(1);
        expect(retriedTurnStarts.map((entry: { params?: { threadId?: string } }) => entry.params?.threadId)).toEqual([
            'thread-started',
        ]);
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('access token could not be refreshed'),
        }));
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));
        expect(sendSessionEvent).not.toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('refused to continue in the current process'),
        });
    });

    it('recovers by compacting then resuming before retrying a context-window-exhausted turn', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-context-window-recovery-');

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('context-window-exhausted-once')).resolves.toBeUndefined();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/compact/start',
                params: { threadId: 'thread-started' },
            }),
            expect.objectContaining({
                method: 'thread/resume',
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    persistExtendedHistory: true,
                }),
            }),
        ]));
        const retriedTurnStarts = requestLog.filter((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }>; threadId?: string } | null;
            return entry.method === 'turn/start' && params?.input?.[0]?.text === 'context-window-exhausted-once';
        });
        expect(retriedTurnStarts).toHaveLength(2);
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('context window'),
        }));
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));
    });

    it('re-arms history hydration when context-window recovery resumes the existing client', async () => {
        const { root } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-context-window-history-rearm-',
            { emitHistoricalNotificationOnResume: true },
        );
        const sendAgentMessageCommitted = vi.fn(async (
            _provider: string,
            _body: { type?: string; message?: string },
        ) => {});
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted,
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await expect(runtime.sendPrompt('context-window-exhausted-once')).resolves.toBeUndefined();

        const committedAssistantText = sendAgentMessageCommitted.mock.calls
            .map(([, body]) => body)
            .filter((body) => body.type === 'message')
            .map((body) => body.message);
        expect(committedAssistantText).not.toContain('Historical recovery replay');
    });

    it('continues instead of replaying the original prompt after context-window exhaustion with turn activity', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-context-window-activity-');

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('context-window-exhausted-after-activity')).resolves.toBeUndefined();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(1);
        const turnStarts = requestLog.filter((entry) => entry.method === 'turn/start') as Array<{
            params?: { input?: Array<{ text?: string }>; threadId?: string };
        }>;
        const prompts = turnStarts.map((entry) => entry.params?.input?.[0]?.text ?? '');
        expect(prompts.filter((text) => text === 'context-window-exhausted-after-activity')).toHaveLength(1);
        expect(prompts.some((text) => text.includes('continue') && text.includes('repeat completed work'))).toBe(true);
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('context window'),
        }));
    });

    it('retries the original prompt once after a transient Codex model-capacity failure without turn activity', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-model-capacity-retry-');

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('model-capacity-once')).resolves.toBeUndefined();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(0);
        const turnStarts = requestLog.filter((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }>; threadId?: string } | null;
            return entry.method === 'turn/start' && params?.input?.[0]?.text === 'model-capacity-once';
        });
        expect(turnStarts).toHaveLength(2);
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('capacity'),
        }));
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));
    });

    it('continues instead of replaying the original prompt after transient Codex model-capacity failure with turn activity', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-model-capacity-activity-');

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('model-capacity-after-activity-once')).resolves.toBeUndefined();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(0);
        const turnStarts = requestLog.filter((entry) => entry.method === 'turn/start') as Array<{
            params?: { input?: Array<{ text?: string }>; threadId?: string };
        }>;
        const prompts = turnStarts.map((entry) => entry.params?.input?.[0]?.text ?? '');
        expect(prompts.filter((text) => text === 'model-capacity-after-activity-once')).toHaveLength(1);
        expect(prompts.some((text) => text.includes('continue') && text.includes('repeat completed work'))).toBe(true);
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('capacity'),
        }));
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));
    });

    it('uses the configured continuation prompt after transient Codex model-capacity failure with turn activity', async () => {
        const { root, requestLogPath, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-model-capacity-custom-continuation-');
        const customContinuationPrompt = 'CUSTOM_CAPACITY_CONTINUATION_PROMPT';
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            HAPPIER_CODEX_CONTEXT_WINDOW_CONTINUATION_PROMPT: customContinuationPrompt,
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('model-capacity-after-activity-once')).resolves.toBeUndefined();

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(0);
        const turnStarts = requestLog.filter((entry) => entry.method === 'turn/start') as Array<{
            params?: { input?: Array<{ text?: string }>; threadId?: string };
        }>;
        const prompts = turnStarts.map((entry) => entry.params?.input?.[0]?.text ?? '');
        expect(prompts.filter((text) => text === 'model-capacity-after-activity-once')).toHaveLength(1);
        expect(prompts).toContain(customContinuationPrompt);
    });

    it('surfaces the original transient Codex model-capacity failure when the retry fails again', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-model-capacity-repeat-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        let caughtError: unknown;
        try {
            await runtime.sendPrompt('model-capacity-twice');
        } catch (error) {
            caughtError = error;
        }

        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toContain('ORIGINAL_CAPACITY_FAILURE');
        expect((caughtError as Error).message).not.toContain('RETRY_CAPACITY_FAILURE');
        expect(caughtError).toMatchObject({
            runtimeAuthClassification: {
                kind: 'capacity',
                limitCategory: 'capacity',
                quotaScope: 'provider',
                serviceId: 'openai-codex',
            },
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(0);
        const retriedTurnStarts = requestLog.filter((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }>; threadId?: string } | null;
            return entry.method === 'turn/start' && params?.input?.[0]?.text === 'model-capacity-twice';
        });
        expect(retriedTurnStarts).toHaveLength(2);
    });

    it('surfaces context-window exhaustion without compacting when Codex recovery is disabled', async () => {
        const { root, requestLogPath, fakeAppServer } = await createRuntimeFixture('happier-codex-app-server-runtime-context-window-disabled-');
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            HAPPIER_CODEX_CONTEXT_WINDOW_RECOVERY_MODE: 'off',
        });

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('context-window-exhausted-once')).rejects.toThrow(/upstream provider rejected/);

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(0);
        const turnStarts = requestLog.filter((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }> } | null;
            return entry.method === 'turn/start' && params?.input?.[0]?.text === 'context-window-exhausted-once';
        });
        expect(turnStarts).toHaveLength(1);
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('upstream provider rejected'),
        }));
    });

    it('surfaces the original context-window failure when retrying after compaction fails again', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-context-window-repeat-');

        const sendCodexMessage = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('context-window-exhausted-twice')).rejects.toThrow('ORIGINAL_CONTEXT_WINDOW_FAILURE');

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'thread/compact/start')).toHaveLength(1);
        const retriedTurnStarts = requestLog.filter((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }>; threadId?: string } | null;
            return entry.method === 'turn/start' && params?.input?.[0]?.text === 'context-window-exhausted-twice';
        });
        expect(retriedTurnStarts).toHaveLength(2);
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('ORIGINAL_CONTEXT_WINDOW_FAILURE'),
        }));
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('RETRY_CONTEXT_WINDOW_FAILURE'),
        }));
    });

    it('applies connected-service auth directly to the running app-server and publishes exact applied account quota proof', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-live-auth-apply-', {
            accountReadResult: { account: { email: 'target@example.test', planType: 'team' } },
            rateLimitReadResult: { plan_type: 'team', primary: { used_percent: 3, resets_at: '2026-05-17T12:00:00.000Z' } },
        });
        const quotaSnapshots: Array<Readonly<{ rawSnapshot: unknown; context: unknown }>> = [];
        const refreshSelectionUpdates: unknown[] = [];
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onRateLimitSnapshot: vi.fn(async (rawSnapshot, context) => {
                quotaSnapshots.push({ rawSnapshot, context });
            }),
            onConnectedServiceAuthGenerationApplied: vi.fn(async ({ selection }) => {
                refreshSelectionUpdates.push(selection);
            }),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });
        const candidate = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'target',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'target-access',
                refreshToken: 'target-refresh',
                idToken: 'target-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_target',
                providerEmail: 'target@example.test',
            },
        });
        const selection = {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'target',
            fallbackProfileId: 'old',
            generation: 8,
        } as const;

        await runtime.startOrLoad({});

        await expect((runtime as any).applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'usage_limit',
            expected: {
                profileId: 'target',
                groupId: 'main',
                generation: 8,
            },
            authGeneration: {
                credential: candidate,
                selection,
                forcedWorkspaceId: null,
            },
        })).resolves.toMatchObject({
            ok: true,
            appliedVia: 'direct_live_hot_auth',
            verification: {
                activeAccountId: 'acct_target',
                proofStrength: 'exact',
                source: 'applied_credential',
                reason: 'direct_live_exact_proof_accepted',
            },
        });

        await waitForCondition(() => quotaSnapshots.length > 0, {
            timeoutMs: 2_000,
            label: 'post-apply quota observation to finish',
        });
        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            requireExactProof: true,
        })).resolves.toMatchObject({
            ok: true,
            serviceId: 'openai-codex',
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
                providerAccountId: 'acct_target',
                accountLabel: 'target@example.test',
                source: 'applied_credential',
            },
            runtime: {
                safeToApply: true,
                inProviderTurn: false,
                profileId: 'target',
                groupId: 'main',
                generation: 8,
            },
        });

        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.filter((entry) => entry.method === 'initialize')).toHaveLength(1);
        expect(requestLog.filter((entry) => entry.method === 'account/login/start')).toHaveLength(1);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'account/login/start',
                params: {
                    type: 'chatgptAuthTokens',
                    accessToken: 'target-access',
                    chatgptAccountId: 'acct_target',
                },
            }),
            expect.objectContaining({ method: 'account/read' }),
            expect.objectContaining({ method: 'account/rateLimits/read' }),
        ]));
        expect(refreshSelectionUpdates).toEqual([selection]);
        expect(quotaSnapshots.at(-1)).toMatchObject({
            rawSnapshot: {
                plan_type: 'team',
                primary: { used_percent: 3, resets_at: '2026-05-17T12:00:00.000Z' },
            },
            context: {
                activeAccountId: 'acct_target',
                accountLabel: 'target@example.test',
            },
        });
        await expect(readFile(join(root, 'codex-home', 'auth.json'), 'utf8'))
            .resolves
            .toContain('"account_id": "acct_target"');
    });

    it('keeps exact direct-live proof when account-read diagnostics fail after live auth apply', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-live-auth-account-read-diagnostic-',
            {
                rejectAccountRead: true,
                rateLimitReadResult: {
                    plan_type: 'team',
                    primary: { used_percent: 3, resets_at: '2026-05-17T12:00:00.000Z' },
                },
            },
        );
        const quotaSnapshots: Array<Readonly<{ rawSnapshot: unknown; context: unknown }>> = [];
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onRateLimitSnapshot: vi.fn(async (rawSnapshot, context) => {
                quotaSnapshots.push({ rawSnapshot, context });
            }),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });
        const candidate = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'target',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'target-access',
                refreshToken: 'target-refresh',
                idToken: 'target-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_target',
                providerEmail: 'target@example.test',
            },
        });

        await runtime.startOrLoad({});

        await expect((runtime as any).applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'usage_limit',
            authGeneration: {
                credential: candidate,
                forcedWorkspaceId: null,
            },
        })).resolves.toMatchObject({
            ok: true,
            appliedVia: 'direct_live_hot_auth',
            activeAccountId: 'acct_target',
            verification: {
                activeAccountId: 'acct_target',
                proofStrength: 'exact',
                source: 'applied_credential',
                reason: 'direct_live_exact_proof_accepted',
            },
        });

        await waitForCondition(() => quotaSnapshots.length > 0, {
            timeoutMs: 2_000,
            label: 'quota observation to continue after account diagnostics failed',
        });
        expect(quotaSnapshots.at(-1)).toMatchObject({
            context: {
                activeAccountId: 'acct_target',
                accountLabel: null,
            },
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).toEqual(expect.arrayContaining([
            'account/read',
            'account/rateLimits/read',
        ]));
    });

    it('settles exact hot auth before post-apply quota publication finishes', async () => {
        const { root } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-live-auth-observation-settlement-',
            {
                accountReadResult: { account: { email: 'target@example.test', planType: 'team' } },
                rateLimitReadResult: {
                    plan_type: 'team',
                    primary: { used_percent: 3, resets_at: '2026-05-17T12:00:00.000Z' },
                },
            },
        );
        let releaseQuotaPublication!: () => void;
        const quotaPublicationGate = new Promise<void>((resolve) => {
            releaseQuotaPublication = resolve;
        });
        const onRateLimitSnapshot = vi.fn(async () => {
            await quotaPublicationGate;
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onRateLimitSnapshot,
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });
        const candidate = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'target',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'target-access',
                refreshToken: 'target-refresh',
                idToken: 'target-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_target',
                providerEmail: 'target@example.test',
            },
        });

        await runtime.startOrLoad({});
        let applySettled = false;
        const applyPromise = (runtime as any).applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'usage_limit',
            authGeneration: {
                credential: candidate,
                forcedWorkspaceId: null,
            },
        }).then((result: unknown) => {
            applySettled = true;
            return result;
        });

        await waitForCondition(() => onRateLimitSnapshot.mock.calls.length === 1, {
            timeoutMs: 2_000,
            label: 'post-apply quota publication to start',
        });
        try {
            await Promise.resolve();
            expect(applySettled).toBe(true);
            await expect(applyPromise).resolves.toMatchObject({
                ok: true,
                appliedVia: 'direct_live_hot_auth',
                activeAccountId: 'acct_target',
            });
        } finally {
            releaseQuotaPublication();
            await applyPromise;
        }
    });

    it('reports auth-store persistence failure after direct-live auth as restart-required partial state', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-live-auth-durability-failure-',
        );
        await writeFile(join(root, 'codex-home'), 'not a directory');
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });
        const candidate = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'target',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'target-access',
                refreshToken: 'target-refresh',
                idToken: 'target-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_target',
                providerEmail: 'target@example.test',
            },
        });

        await runtime.startOrLoad({});

        await expect((runtime as any).applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'usage_limit',
            authGeneration: {
                credential: candidate,
                forcedWorkspaceId: null,
            },
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'auth_store_persistence_failed_after_live_apply',
            error: 'auth_store_persistence_failed_after_live_apply',
            appliedVia: 'direct_live_hot_auth',
            activeAccountId: 'acct_target',
            partialState: 'runtime_auth_applied',
            recovery: 'restart_resume',
            verification: {
                activeAccountId: 'acct_target',
                proofStrength: 'exact',
                source: 'applied_credential',
                reason: 'direct_live_exact_proof_accepted',
            },
            durability: {
                persisted: false,
                errorCode: 'auth_store_persistence_failed_after_live_apply',
            },
        });

        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            requireExactProof: true,
        })).resolves.toMatchObject({
            ok: true,
            identity: {
                providerAccountId: 'acct_target',
                proofStrength: 'exact',
                source: 'applied_credential',
            },
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).toContain('account/login/start');
    });

    it('reports exact spawn-time connected-service runtime identity before direct live apply', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-spawn-identity-');
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_spawned',
                accountLabel: 'spawned@example.test',
                profileId: 'team',
                groupId: 'main',
                generation: 42,
                credentialFingerprint: 'sha256:spawn042',
                source: 'spawn_selection',
            },
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        } as any);

        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            expected: {
                profileId: 'team',
                groupId: 'main',
                generation: 42,
            },
            requireExactProof: true,
        })).resolves.toMatchObject({
            ok: true,
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
                providerAccountId: 'acct_spawned',
                accountLabel: 'spawned@example.test',
                source: 'spawn_selection',
            },
            runtime: {
                profileId: 'team',
                groupId: 'main',
                generation: 42,
            },
        });
    });

    it('uses the frozen exact applied identity for cold same-account fanout siblings', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-cold-sibling-live-identity-',
            {
                accountReadResult: {
                    account: {
                        id: 'acct_live_sibling',
                        email: 'sibling@example.test',
                    },
                },
            },
        );
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'main',
                activeProfileId: 'target',
                fallbackProfileId: 'backup',
                generation: 12,
            }]),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_live_sibling',
                accountLabel: null,
                profileId: 'target',
                groupId: 'main',
                generation: 12,
                credentialFingerprint: 'sha256:sibling1',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        } as any);

        await runtime.startOrLoad({});

        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            expected: {
                profileId: 'stale-daemon-profile',
                groupId: 'main',
                generation: 1,
            },
            requireExactProof: true,
        })).resolves.toEqual({
            ok: true,
            serviceId: 'openai-codex',
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
                providerAccountId: 'acct_live_sibling',
                source: 'spawn_selection',
            },
            runtime: {
                safeToProbe: true,
                safeToApply: true,
                inProviderTurn: false,
                profileId: 'target',
                groupId: 'main',
                generation: 12,
            },
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).not.toContain('account/read');
    });

    it('uses daemon expected runtime context with live account proof when local selection is missing', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-expected-context-live-identity-',
            {
                accountReadResult: {
                    account: {
                        id: 'acct_live_expected',
                        email: 'expected@example.test',
                    },
                },
            },
        );
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer);
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        } as any);

        await runtime.startOrLoad({});

        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            expected: {
                profileId: 'daemon-profile',
                groupId: 'main',
                generation: 12,
            },
            requireExactProof: true,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_identity_probe_missing_exact_identity',
            error: 'runtime_identity_probe_missing_exact_identity',
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).toContain('account/read');
    });

    it('does not replace a frozen exact identity when an optional live account read would fail', async () => {
        const { root, fakeAppServer } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-cold-sibling-live-identity-retry-',
            {
                rejectAccountReadCount: 1,
                accountReadResult: {
                    account: {
                        id: 'acct_live_retry',
                        email: 'retry@example.test',
                    },
                },
            },
        );
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer);
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_live_retry',
                accountLabel: null,
                profileId: 'daemon-profile',
                groupId: 'main',
                generation: 12,
                credentialFingerprint: 'sha256:retry001',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        } as any);

        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            expected: {
                profileId: 'daemon-profile',
                groupId: 'main',
                generation: 12,
            },
            requireExactProof: true,
        })).resolves.toEqual({
            ok: true,
            serviceId: 'openai-codex',
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
                providerAccountId: 'acct_live_retry',
                source: 'spawn_selection',
            },
            runtime: {
                safeToProbe: true,
                safeToApply: true,
                inProviderTurn: false,
                profileId: 'daemon-profile',
                groupId: 'main',
                generation: 12,
            },
        });
    });

    it('refreshes stale cached runtime identity from current selection and live account proof', async () => {
        const { root, fakeAppServer, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-stale-sibling-live-identity-',
            {
                accountReadResult: {
                    account: {
                        id: 'acct_live_current',
                        email: 'current@example.test',
                    },
                },
            },
        );
        const processEnv = createCodexAppServerProcessEnv(fakeAppServer, {
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'main',
                activeProfileId: 'current',
                fallbackProfileId: 'backup',
                generation: 12,
            }]),
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_stale',
                accountLabel: 'stale@example.test',
                profileId: 'stale',
                groupId: 'main',
                generation: 7,
                credentialFingerprint: 'sha256:stale001',
                source: 'spawn_selection',
            },
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        } as any);

        await runtime.startOrLoad({});

        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            expected: {
                profileId: 'stale-daemon-profile',
                groupId: 'main',
                generation: 7,
            },
            requireExactProof: true,
        })).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_identity_probe_missing_exact_identity',
            error: 'runtime_identity_probe_missing_exact_identity',
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).toContain('account/read');
    });

    it('keeps exact runtime identity available when daemon expected profile and generation are stale', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-stale-expected-identity-');
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_runtime',
                accountLabel: 'runtime@example.test',
                profileId: 'runtime-current',
                groupId: 'main',
                generation: 337,
                credentialFingerprint: 'sha256:runtime3',
                source: 'spawn_selection',
            },
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        } as any);

        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            expected: {
                profileId: 'stale-daemon-profile',
                groupId: 'main',
                generation: 4,
            },
            requireExactProof: true,
        })).resolves.toMatchObject({
            ok: true,
            serviceId: 'openai-codex',
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
                providerAccountId: 'acct_runtime',
                accountLabel: 'runtime@example.test',
                source: 'spawn_selection',
            },
            runtime: {
                profileId: 'runtime-current',
                groupId: 'main',
                generation: 337,
            },
        });
    });

    it('returns exact current runtime identity when the daemon expected opaque target is stale', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-stale-exact-expected-');
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex',
                activeAccountId: 'acct_current',
                accountLabel: 'current@example.test',
                profileId: 'current',
                groupId: 'main',
                generation: 8,
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
                credentialFingerprint: 'sha256:current8',
                source: 'spawn_selection',
            },
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        } as any);

        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            expected: {
                profileId: 'reported',
                groupId: 'main',
                generation: 7,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            requireExactProof: true,
        })).resolves.toMatchObject({
            ok: true,
            serviceId: 'openai-codex',
            runtime: {
                profileId: 'current',
                groupId: 'main',
                generation: 8,
                credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
            },
        });
    });

    it('does not adopt runtime identity when refresh bridge update fails before live auth mutation', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-live-auth-partial-');
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onConnectedServiceAuthGenerationApplied: vi.fn(async () => {
                throw new Error('selection update failed');
            }),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });
        const candidate = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'target',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'target-access',
                refreshToken: 'target-refresh',
                idToken: 'target-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_target',
                providerEmail: 'target@example.test',
            },
        });
        const selection = {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'main',
            activeProfileId: 'target',
            fallbackProfileId: 'old',
            generation: 8,
        } as const;

        await runtime.startOrLoad({});

        await expect((runtime as any).applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'usage_limit',
            expected: {
                profileId: 'target',
                groupId: 'main',
                generation: 8,
            },
            authGeneration: {
                credential: candidate,
                selection,
                forcedWorkspaceId: null,
            },
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'refresh_selection_resync_failed',
        });

        await expect((runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'diagnostic',
            expected: {
                profileId: 'target',
                groupId: 'main',
                generation: 8,
            },
            requireExactProof: true,
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'runtime_identity_probe_missing_exact_identity',
        });
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).not.toContain('account/login/start');
    });

    it('direct-live applies connected-service auth while a provider turn is in flight', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-live-auth-busy-', {
            omitTurnCompletedForPrompt: 'overlap-start',
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onConnectedServiceAuthGenerationApplied: vi.fn(async () => {}),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });
        const candidate = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'target',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'target-access',
                refreshToken: 'target-refresh',
                idToken: 'target-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_target',
                providerEmail: null,
            },
        });

        await runtime.startOrLoad({});
        const promptPromise = runtime.sendPrompt('overlap-start');
        const promptOutcome = promptPromise.catch(() => undefined);
        await waitForCondition(async () => {
            const requestLog = await readRequestLog(requestLogPath);
            return requestLog.some((entry) => {
                const params = entry.params as { input?: Array<{ text?: string }> } | null;
                return entry.method === 'turn/start' && params?.input?.[0]?.text === 'overlap-start';
            });
        }, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server test prompt to start before live auth apply',
        });

        await expect((runtime as any).applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            requireDirectLiveHotApply: true,
            expected: {
                profileId: 'target',
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
            authGeneration: {
                credential: candidate,
                forcedWorkspaceId: null,
            },
        })).resolves.toMatchObject({
            ok: true,
            appliedVia: 'direct_live_hot_auth',
            activeAccountId: 'acct_target',
            verification: {
                activeAccountId: 'acct_target',
                proofStrength: 'exact',
                source: 'applied_credential',
                reason: 'direct_live_exact_proof_accepted',
            },
        });

        const identityResponse = await (runtime as any).readConnectedServiceRuntimeIdentity({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            expected: {
                profileId: 'target',
            },
            requireExactProof: true,
        });
        expect(identityResponse).toMatchObject({
            ok: true,
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
                providerAccountId: 'acct_target',
                source: 'applied_credential',
            },
            runtime: {
                inProviderTurn: true,
                safeToApply: true,
                profileId: 'target',
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
            },
        });
        expect(identityResponse.runtime).not.toHaveProperty('safeToDirectLiveApply');
        expect(identityResponse.runtime).not.toHaveProperty('requiresTurnBoundaryForApply');

        expect(runtime.isTurnInFlight()).toBe(true);
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).toContain('account/login/start');
        await runtime.reset();
        await promptOutcome;
    });

    it('diagnoses whether a new prompt can start while direct-live auth mutation is unfinished', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-live-auth-new-prompt-',
            { loginStartResponseDelayMs: 20 },
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            onConnectedServiceAuthGenerationApplied: vi.fn(async () => {}),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });
        const candidate = buildConnectedServiceCredentialRecord({
            now: 1000,
            serviceId: 'openai-codex',
            profileId: 'target',
            kind: 'oauth',
            expiresAt: 2000,
            oauth: {
                accessToken: 'target-access',
                refreshToken: 'target-refresh',
                idToken: 'target-id',
                scope: null,
                tokenType: null,
                providerAccountId: 'acct_target',
                providerEmail: null,
            },
        });

        await runtime.startOrLoad({});
        const inFlightPrompt = runtime.sendPrompt('overlap-start');
        await waitForCondition(async () => (
            (await readRequestLog(requestLogPath)).some((entry) => {
                const params = entry.params as { input?: Array<{ text?: string }> } | null;
                return entry.method === 'turn/start' && params?.input?.[0]?.text === 'overlap-start';
            })
        ), {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex prompt to enter its active provider turn before live auth apply',
        });
        const authApply = (runtime as any).applyConnectedServiceAuthGeneration({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            requireDirectLiveHotApply: true,
            expected: { profileId: 'target' },
            authGeneration: {
                credential: candidate,
                forcedWorkspaceId: null,
            },
        });
        await expect(runtime.sendPrompt('new-prompt-during-auth-apply'))
            .rejects.toThrow('already has a turn in flight');

        await expect(authApply).resolves.toMatchObject({ ok: true, appliedVia: 'direct_live_hot_auth' });
        await expect(inFlightPrompt).resolves.toBeUndefined();
        const requestLog = await readRequestLog(requestLogPath);
        expect(requestLog.map((entry) => entry.method)).toContain('account/login/start');
        expect(requestLog.some((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }> } | null;
            return entry.method === 'turn/start'
                && params?.input?.[0]?.text === 'new-prompt-during-auth-apply';
        })).toBe(false);
    });

    it('invalidates connected-service auth transports by restarting the app-server and resuming the same thread', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-hot-apply-invalidate-');

        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});

        await expect((runtime as any).invalidateConnectedServiceAuthTransports?.({})).resolves.toEqual({ ok: true });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(2);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/resume',
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    persistExtendedHistory: true,
                }),
            }),
        ]));
        // Intentional connected-service switch must NOT use the native "refused to continue" copy.
        expect(sendSessionEvent).not.toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('refused to continue in the current process'),
        });
        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('applying a connected-service account switch'),
        });
    });

    it('continues an active prompt after connected-service auth transport invalidation restarts the app-server', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-hot-apply-invalidate-active-');

        const sendCodexMessage = vi.fn();
        const sendAgentMessageCommitted = vi.fn(async () => {});
        const sendSessionEvent = vi.fn();
        const undeliverablePrompts: Array<Readonly<{
            localIds?: readonly string[] | null;
            text: string;
            userMessageSeq: number | null;
        }>> = [];
        const acceptedPrompts: Array<Readonly<{
            localIds?: readonly string[] | null;
            userMessageSeq: number | null;
            providerTurnId: string;
        }>> = [];
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendAgentMessageCommitted,
                sendCodexMessage,
                sendSessionEvent,
            } as any,
        });
        runtime.setOnUndeliverablePrompts((prompts) => {
            undeliverablePrompts.push(...prompts);
        });
        runtime.setOnPromptAcceptedByProvider((prompt) => {
            acceptedPrompts.push(prompt);
        });

        await runtime.startOrLoad({});

        const prompt = 'connected-service-invalidation-before-acceptance-after-activity';
        const promptPromise = runtime.sendPrompt(prompt, {
            localId: 'local-auth-invalidation',
            userMessageSeq: 927,
        });
        await waitForCondition(async () => {
            const requestLog = await readRequestLog(requestLogPath);
            return requestLog.some((entry) => {
                const params = entry.params as { input?: Array<{ text?: string }> } | null;
                return entry.method === 'turn/start' && params?.input?.[0]?.text === prompt;
            });
        }, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server test prompt to start before transport invalidation',
        });
        await waitForCondition(() => sendAgentMessageCommitted.mock.calls.length > 0, {
            timeoutMs: 1_000,
            intervalMs: 10,
            label: 'Codex app-server test prompt to report meaningful provider activity before transport invalidation',
        });

        await expect((runtime as any).invalidateConnectedServiceAuthTransports?.({})).resolves.toEqual({ ok: true });
        await expect(promptPromise).resolves.toBeUndefined();

        const requestLog = await readRequestLog(requestLogPath);
        const turnStartPrompts = requestLog.flatMap((entry) => {
            const params = entry.params as { input?: Array<{ text?: string }> } | null;
            return entry.method === 'turn/start' ? [params?.input?.[0]?.text ?? null] : [];
        });
        expect(turnStartPrompts).toHaveLength(2);
        expect(turnStartPrompts[0]).toBe(prompt);
        expect(turnStartPrompts[1]).not.toBe(prompt);
        expect(requestLog.filter((entry) => entry.method === 'initialize')).toHaveLength(2);
        expect(requestLog).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/resume',
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    persistExtendedHistory: true,
                }),
            }),
        ]));
        expect(acceptedPrompts).toEqual([{
            localIds: ['local-auth-invalidation'],
            userMessageSeq: 927,
            providerTurnId: 'turn-Please continue the interrupted work from the compacted Codex context. Do not restart or repeat completed work.',
        }]);
        expect(undeliverablePrompts).toEqual([]);
        // Intentional connected-service switch must NOT use the native "refused to continue" copy.
        expect(sendSessionEvent).not.toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('refused to continue in the current process'),
        });
        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('applying a connected-service account switch'),
        });
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('access token could not be refreshed'),
        }));
    });

    it('treats connected-service auth invalidation as a no-op when no active thread is running', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-hot-apply-unsupported-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
            } as any,
        });

        await expect((runtime as any).invalidateConnectedServiceAuthTransports?.({})).resolves.toEqual({ ok: true });
    });

    it('suppresses retryable Codex errors until a later hard failure aborts the pending turn', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-retry-then-failed-turn-');

        const sendCodexMessage = vi.fn();
        const sendSessionEvent = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(),
                sendCodexMessage,
                sendSessionEvent,
            } as any,
        });

        await runtime.startOrLoad({});

        await expect(runtime.sendPrompt('retry-then-failed-turn')).rejects.toThrow(/401 Unauthorized/);

        const surfacedMessages = sendCodexMessage.mock.calls
            .map(([message]) => message)
            .filter((message) => message?.type === 'message');
        expect(surfacedMessages).toHaveLength(1);
        expect(surfacedMessages[0]).toEqual(expect.objectContaining({
            message: expect.stringContaining('401 Unauthorized'),
        }));
        expect(surfacedMessages[0]).toEqual(expect.not.objectContaining({
            message: expect.stringContaining('temporary upstream overload'),
        }));
        expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));
        expect(sendSessionEvent).not.toHaveBeenCalled();
    });

    it('rolls back the latest conversation turn through the app-server thread API and records its transcript seq range', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-');

        let lastObservedMessageSeq = 7;
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = 11;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams', { userMessageSeq: 7 });
        await (runtime as any).rollbackConversation({ v: 1, target: { type: 'latest_turn' } });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/rollback',
                    params: { threadId: 'thread-started', numTurns: 1 },
                }),
            ]),
        );
        expect(updateMetadata.mock.results.at(-1)?.value).toMatchObject({
            sessionRollbackRangesV1: {
                v: 1,
                ranges: [
                    {
                        target: { type: 'latest_turn' },
                        startSeqInclusive: 7,
                        endSeqInclusive: 11,
                        rolledBackAt: expect.any(Number),
                    },
                ],
                updatedAt: expect.any(Number),
            },
        });
    });

    it('does not fail rollback after app-server success when rollback metadata persistence rejects', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-metadata-reject-');

        let lastObservedMessageSeq = 7;
        let metadataSnapshot: Record<string, unknown> = { machineId: 'machine_1' };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                    const nextMetadata = updater(metadataSnapshot);
                    if (Object.prototype.hasOwnProperty.call(nextMetadata, 'sessionRollbackRangesV1')) {
                        throw new Error('rollback metadata unavailable');
                    }
                    metadataSnapshot = nextMetadata;
                    return metadataSnapshot;
                }),
                getMetadataSnapshot: vi.fn(() => metadataSnapshot),
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => localId === 'rollback-metadata-reject-local' ? 7 : null),
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = 11;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-metadata-reject-local' });

        await expect((runtime as any).rollbackConversation({ v: 1, target: { type: 'latest_turn' } })).resolves.toMatchObject({
            ok: true,
            target: { type: 'latest_turn' },
            threadId: 'thread-started',
        });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/rollback',
                    params: { threadId: 'thread-started', numTurns: 1 },
                }),
            ]),
        );
    });

    it('rolls back before a user message even when user-message seq increments after the onUserMessage callback fires', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-user-message-seq-order-');

        let lastObservedMessageSeq = 0;
        let lastObservedUserMessageSeq = 0;
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                getLastObservedUserMessageSeq: vi.fn(() => lastObservedUserMessageSeq),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => localId === 'rollback-seq-order-local' ? 1 : null),
                // Simulate session client updating the seq counters after the user-message callback begins.
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = 3;
                    lastObservedUserMessageSeq = 1;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-seq-order-local' });

        await expect((runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 1,
            },
        })).resolves.toMatchObject({ ok: true });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/rollback',
                    params: { threadId: 'thread-started', numTurns: 1 },
                }),
            ]),
        );
    });

    it('does not use legacy session turn metadata as rollback evidence after resume', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-resume-session-turn-');

        let metadataSnapshot: Record<string, unknown> = {
            machineId: 'machine_1',
            sessionTurnLedgerV1: {
                v: 1,
                sessionId: 'codex-app-server',
                backendId: 'codex-app-server',
                agentId: 'codex',
                providerThreadId: 'thread-resumed',
                currentTurnId: 'provider-turn-1',
                updatedAt: 10,
                entries: [
                    {
                        turnId: 'provider-turn-1',
                        status: 'completed',
                        startedAt: 1,
                        updatedAt: 10,
                        terminalAt: 10,
                        transcriptAnchors: {
                            startUserMessageSeq: 21,
                            userMessageSeqs: [21],
                            startSeqInclusive: 21,
                            endSeqInclusive: 25,
                        },
                        rollback: { state: 'eligible', updatedAt: 10 },
                    },
                ],
                recentMutationIds: ['provider-turn-1'],
            },
        };
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            metadataSnapshot = updater(metadataSnapshot);
            return metadataSnapshot;
        });

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                getMetadataSnapshot: vi.fn(() => metadataSnapshot),
                getLastObservedMessageSeq: vi.fn(() => 25),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({ existingSessionId: 'thread-resumed' });

        await expect((runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 21,
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            errorMessage: 'Rollback target is not available in the active conversation',
        });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/rollback')).toEqual([]);
    });

    it('rolls back multiple turns before a target user message and records the rolled-back seq range', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-before-user-message-');

        let lastObservedMessageSeq = 3;
        let lastObservedUserMessageSeq = 1;
        let nextTurnEndSeq = 5;
        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata,
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                getLastObservedUserMessageSeq: vi.fn(() => lastObservedUserMessageSeq),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => {
                    if (localId === 'rollback-first-local') return 1;
                    if (localId === 'rollback-second-local') return 4;
                    return null;
                }),
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = nextTurnEndSeq;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-first-local' });
        lastObservedMessageSeq = 7;
        lastObservedUserMessageSeq = 4;
        nextTurnEndSeq = 9;
        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-second-local' });

        await (runtime as any).rollbackConversation({
            v: 1,
            target: {
                type: 'before_user_message',
                userMessageSeq: 1,
            },
        });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/rollback',
                    params: { threadId: 'thread-started', numTurns: 2 },
                }),
            ]),
        );
        expect(updateMetadata.mock.results.at(-1)?.value).toMatchObject({
            sessionRollbackRangesV1: {
                v: 1,
                ranges: [
                    {
                        target: {
                            type: 'before_user_message',
                            userMessageSeq: 1,
                        },
                        startSeqInclusive: 3,
                        endSeqInclusive: 9,
                        rolledBackAt: expect.any(Number),
                    },
                ],
                updatedAt: expect.any(Number),
            },
        });
    });

    it('returns unsupported_action when rollback is rejected by app-server schema support', async () => {
        const { root, requestLogPath } = await createRuntimeFixture(
            'happier-codex-app-server-runtime-rollback-unsupported-',
            { rollbackError: { code: -32602, message: 'invalid params: expected { threadId, numTurns }' } },
        );

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => updater({ machineId: 'machine_1' })),
                getLastObservedMessageSeq: vi.fn(() => 11),
                waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => localId === 'rollback-unsupported-local' ? 11 : null),
                sendAgentMessageCommitted: vi.fn(async () => undefined),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await (runtime as any).sendPrompt('bridge-streams', { localId: 'rollback-unsupported-local' });

        await expect((runtime as any).rollbackConversation({ v: 1, target: { type: 'latest_turn' } })).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_action',
            errorMessage: expect.stringContaining('invalid params'),
        });
    });
});
