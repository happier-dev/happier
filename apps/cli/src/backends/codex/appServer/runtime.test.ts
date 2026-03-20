import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';

import { createCodexAppServerRuntime } from './runtime';

async function writeFakeCodexAppServerScript(params: Readonly<{
    dir: string;
    requestLogPath: string;
    rollbackError?: Readonly<{
        code: number;
        message: string;
    }>;
}>): Promise<string> {
    const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
    const script = [
        '#!/usr/bin/env node',
        'import { appendFile } from "node:fs/promises";',
        'import readline from "node:readline";',
        `const requestLogPath = ${JSON.stringify(params.requestLogPath)};`,
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
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
        '        if (msg.params?.persistExtendedHistory !== true || msg.params?.experimentalRawEvents !== true) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "missing thread/start flags" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "thread/resume") {',
        '        if (msg.params?.persistExtendedHistory !== true) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "missing thread/resume flags" } }) + "\\n");',
        '            continue;',
        '        }',
        '        const adoptsOverrideThread = Object.prototype.hasOwnProperty.call(msg.params ?? {}, "model") || Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier");',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: adoptsOverrideThread ? "thread-overrides" : (msg.params?.threadId ?? null), model: msg.params?.model ?? (adoptsOverrideThread ? "gpt-5.4-mini" : "gpt-5.4"), serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null } }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "collaborationMode/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: [{ name: "Default", mode: "default", reasoning_effort: null }, { name: "Plan", mode: "plan", reasoning_effort: "medium" }] }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "model/list") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }, { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini" }] }) + "\\n");',
        '        continue;',
        '    }',
        '    if (msg.method === "turn/start") {',
        '        const text = Array.isArray(msg.params?.input) ? String(msg.params.input[0]?.text ?? "unknown") : "unknown";',
        '        const turnId = `turn-${text}`;',
        '        const completionDelayMs = text === "cancel-me" ? 50 : 15;',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '        setTimeout(() => {',
            '            process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '        }, 5);',
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
        '                process.stdout.write(JSON.stringify({ method: "item/started", params: { item: { id: "patch_1", type: "fileChange", auto_approved: true, changes: { "src/file.ts": { hunks: 2 } } } } }) + "\\n");',
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
        '        if (text === "bridge-turn-diff") {',
            '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/diff/updated", params: { threadId: msg.params?.threadId ?? null, turnId, unifiedDiff: "diff --git a/src/diffed.ts b/src/diffed.ts\\n--- a/src/diffed.ts\\n+++ b/src/diffed.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
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
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '        }, completionDelayMs);',
        '        continue;',
        '    }',
        '    if (msg.method === "turn/interrupt") {',
        '        const turnId = msg.params?.turnId ?? null;',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/interrupted", params: { threadId: msg.params?.threadId ?? null, turn: turnId ? { id: turnId } : undefined } }) + "\\n");',
        '        }, 5);',
        '        continue;',
        '    }',
        '    if (msg.method === "turn/steer") {',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
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
    const originalAppServerBin = process.env.HAPPIER_CODEX_APP_SERVER_BIN;
    const originalRpcTimeout = process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS;
    const originalTranscriptStorage = process.env.HAPPIER_TRANSCRIPT_STORAGE;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

    afterEach(() => {
        if (originalAppServerBin === undefined) {
            delete process.env.HAPPIER_CODEX_APP_SERVER_BIN;
        } else {
            process.env.HAPPIER_CODEX_APP_SERVER_BIN = originalAppServerBin;
        }
        if (originalRpcTimeout === undefined) {
            delete process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS;
        } else {
            process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = originalRpcTimeout;
        }
        if (originalTranscriptStorage === undefined) {
            delete process.env.HAPPIER_TRANSCRIPT_STORAGE;
        } else {
            process.env.HAPPIER_TRANSCRIPT_STORAGE = originalTranscriptStorage;
        }
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = originalCodexHome;
        }
        if (originalOpenAiApiKey === undefined) {
            delete process.env.OPENAI_API_KEY;
        } else {
            process.env.OPENAI_API_KEY = originalOpenAiApiKey;
        }
    });

    it('starts a new app-server thread and publishes the thread id to session metadata', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-start-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
            permissionMode: 'acceptEdits',
        });

        await runtime.startOrLoad({});

        expect(runtime.getSessionId()).toBe('thread-started');
        expect(updateMetadata).toHaveBeenCalled();
        expect(updateMetadata.mock.results[0]?.value).toMatchObject({
            codexSessionId: 'thread-started',
            codexBackendMode: 'appServer',
        });
        expect(updateMetadata.mock.results[1]?.value).toMatchObject({
            [SESSION_MODES_STATE_KEY]: expect.objectContaining({
                currentModeId: 'default',
                availableModes: expect.arrayContaining([
                    expect.objectContaining({ id: 'default', name: 'Default' }),
                    expect.objectContaining({ id: 'plan', name: 'Plan' }),
                ]),
            }),
            [SESSION_MODELS_STATE_KEY]: expect.objectContaining({
                currentModelId: 'gpt-5.4',
                availableModels: expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.4', name: 'GPT-5.4' })]),
            }),
        });
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/start',
                    params: expect.objectContaining({
                        cwd: root,
                        approvalPolicy: 'on-request',
                        sandbox: 'workspace-write',
                        experimentalRawEvents: true,
                        persistExtendedHistory: true,
                    }),
                }),
                expect.objectContaining({ method: 'collaborationMode/list' }),
                expect.objectContaining({ method: 'model/list' }),
            ]),
        );
    });

    it('publishes connected-service direct-session metadata when activeServerDir owns CODEX_HOME', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-direct-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';
        process.env.HAPPIER_TRANSCRIPT_STORAGE = 'direct';
        process.env.CODEX_HOME = join(root, 'servers', 'cloud', 'daemon', 'connected-services', 'homes', 'openai-codex', 'profile', 'codex', 'codex-home');

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            activeServerDir: join(root, 'servers', 'cloud'),
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
        });

        await runtime.startOrLoad({});

        expect(updateMetadata.mock.results[0]?.value).toMatchObject({
            directSessionV1: {
                source: {
                    kind: 'codexHome',
                    home: 'connectedService',
                    connectedServiceId: 'openai-codex',
                    connectedServiceProfileId: 'profile',
                },
            },
        });
    });

    it('resumes an existing app-server thread for resume ids and existing session ids', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-resume-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({ resumeId: 'resume-123', importHistory: false });
        await runtime.startOrLoad({ existingSessionId: 'existing-456' });

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        const resumeRequests = requestLog.filter((entry: { method: string }) => entry.method === 'thread/resume');
        expect(resumeRequests).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ params: expect.objectContaining({ threadId: 'resume-123', persistExtendedHistory: true }) }),
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'resume-123',
                        approvalPolicy: 'never',
                        sandbox: 'read-only',
                        persistExtendedHistory: true,
                    }),
                }),
                expect.objectContaining({
                    params: expect.objectContaining({
                        threadId: 'existing-456',
                        approvalPolicy: 'never',
                        sandbox: 'read-only',
                        persistExtendedHistory: true,
                    }),
                }),
            ]),
        );
    });

    it('sends prompts over the persistent client and waits for turn completion notifications', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-turn-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

        const onThinkingChange = vi.fn();
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange,
            session: { updateMetadata: vi.fn() } as any,
            permissionMode: 'read-only',
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('hello-world');

        expect(runtime.isTurnInFlight()).toBe(false);
        expect(onThinkingChange).toHaveBeenCalledWith(true);
        expect(onThinkingChange).toHaveBeenLastCalledWith(false);

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'initialize')).toHaveLength(1);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'thread/start')).toHaveLength(1);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/start')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    input: [{ type: 'text', text: 'hello-world' }],
                    approvalPolicy: 'never',
                    sandboxPolicy: {
                        type: 'readOnly',
                        access: { type: 'fullAccess' },
                        networkAccess: true,
                    },
                }),
            }),
        ]);
    });

    it('interrupts an in-flight turn without spawning a replacement app-server process', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-interrupt-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

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

    it('steers an in-flight turn through turn/steer without replacing the active turn', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-steer-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        expect(runtime.supportsInFlightSteer()).toBe(true);

        const sendPromptPromise = runtime.sendPrompt('cancel-me');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(runtime.isTurnInFlight()).toBe(true);
        await runtime.steerPrompt('nudge');
        await sendPromptPromise;

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/steer')).toEqual([
            expect.objectContaining({
                params: expect.objectContaining({
                    threadId: 'thread-started',
                    turnId: 'turn-cancel-me',
                    input: [{ type: 'text', text: 'nudge' }],
                }),
            }),
        ]);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/start')).toHaveLength(1);
    });

    it('bridges stream notifications into transcript deltas and tool updates during sendPrompt', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-bridge-streams-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendTranscriptDraftDelta: vi.fn(),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');

        expect(session.sendTranscriptDraftDelta).toHaveBeenCalledWith(
            'codex',
            expect.objectContaining({ segmentKind: 'assistant', deltaText: 'Hello ' }),
        );
        expect(session.sendTranscriptDraftDelta).toHaveBeenCalledWith(
            'codex',
            expect.objectContaining({ segmentKind: 'thinking', deltaText: 'thinking' }),
        );
        expect(session.sendAgentMessageCommitted.mock.calls).toEqual(
            expect.arrayContaining([
                ['codex', expect.objectContaining({ type: 'message', message: 'Hello ' }), expect.any(Object)],
                ['codex', expect.objectContaining({ type: 'message', message: 'world' }), expect.any(Object)],
                ['codex', expect.objectContaining({ type: 'thinking', text: 'thinking' }), expect.any(Object)],
                ['codex', expect.objectContaining({ type: 'thinking', text: ' hard' }), expect.any(Object)],
            ]),
        );
        expect(session.sendCodexMessage.mock.calls).toEqual(
            expect.arrayContaining([
                [expect.objectContaining({ type: 'tool-call', callId: 'cmd_1', name: 'CodexBash', input: { command: 'ls -la', cwd: '/repo' } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'cmd_1', output: { stdout: 'done', exitCode: 0 } })],
                [expect.objectContaining({ type: 'tool-call', callId: 'tool_1', name: 'mcp__playwright__browser_navigate', input: { url: 'https://example.com' } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'tool_1', output: { status: 'ok' } })],
                [expect.objectContaining({ type: 'tool-call', callId: 'patch_1', name: 'CodexPatch', input: { auto_approved: true, changes: { 'src/file.ts': { hunks: 2 } } } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'patch_1', output: { stdout: 'patched', success: true } })],
            ]),
        );
    });

    it('does not append the full final assistant text into streaming drafts when the final text diverges from earlier deltas', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-divergent-final-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendTranscriptDraftDelta: vi.fn(),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams-divergent-final');

        expect(session.sendTranscriptDraftDelta.mock.calls).toEqual([
            ['codex', expect.objectContaining({ segmentKind: 'assistant', deltaText: 'READY ' })],
        ]);
        expect(session.sendAgentMessageCommitted.mock.calls).toEqual(
            expect.arrayContaining([
                ['codex', expect.objectContaining({ type: 'message', message: 'READY_FOR_FOLLOWUP' }), expect.any(Object)],
            ]),
        );
    });

    it('emits a canonical Diff tool when the app-server publishes turn diff updates', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-bridge-turn-diff-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

        const session = {
            updateMetadata: vi.fn(),
            sendAgentMessageCommitted: vi.fn(async () => {}),
            sendTranscriptDraftDelta: vi.fn(),
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

    it('bridges approval and request-user-input server requests through the permission handler', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-bridge-approvals-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

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
                sendTranscriptDraftDelta: vi.fn(),
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

    it('applies session mode, model, and Speed overrides through app-server requests and republishes metadata', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-controls-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata } as any,
        });

        await runtime.startOrLoad({});
        await runtime.setSessionMode('plan');
        await runtime.setSessionModel('gpt-5.4');
        await runtime.setSessionConfigOption('speed', 'fast');
        await runtime.sendPrompt('use-overrides');

        expect(updateMetadata.mock.results.at(-1)?.value).toMatchObject({
            [SESSION_MODES_STATE_KEY]: expect.objectContaining({ currentModeId: 'plan' }),
            [SESSION_MODELS_STATE_KEY]: expect.objectContaining({ currentModelId: 'gpt-5.4' }),
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: expect.objectContaining({
                configOptions: [expect.objectContaining({ id: 'speed', currentValue: 'fast' })],
            }),
        });
        expect(updateMetadata.mock.results.map((entry) => entry.value)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ codexSessionId: 'thread-overrides' }),
            ]),
        );

        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/resume',
                    params: expect.objectContaining({ threadId: 'thread-started', model: 'gpt-5.4', persistExtendedHistory: true }),
                }),
                expect.objectContaining({
                    method: 'thread/resume',
                    params: expect.objectContaining({ threadId: 'thread-overrides', serviceTier: 'fast', persistExtendedHistory: true }),
                }),
                expect.objectContaining({
                    method: 'turn/start',
                    params: expect.objectContaining({
                        threadId: 'thread-overrides',
                        collaborationMode: {
                            mode: 'plan',
                            settings: {
                                model: 'gpt-5.4',
                                reasoning_effort: 'medium',
                                developer_instructions: null,
                            },
                        },
                    }),
                }),
            ]),
        );
    });

    it('does not surface Speed controls when Codex is authenticated only by OPENAI_API_KEY', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-auth-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';
        process.env.OPENAI_API_KEY = 'sk-test-codex';

        const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) =>
            updater({ machineId: 'machine_1' }),
        );
        const runtime = createCodexAppServerRuntime({
            directory: root,
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

    it('rolls back the latest conversation turn through the app-server thread API and records its transcript seq range', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-rollback-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

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
                sendTranscriptDraftDelta: vi.fn(),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');
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

    it('rolls back multiple turns before a target user message and records the rolled-back seq range', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-rollback-before-user-message-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({ dir: root, requestLogPath });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

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
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = nextTurnEndSeq;
                }),
                sendTranscriptDraftDelta: vi.fn(),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});

        await runtime.sendPrompt('bridge-streams');
        lastObservedMessageSeq = 7;
        lastObservedUserMessageSeq = 4;
        nextTurnEndSeq = 9;
        await runtime.sendPrompt('bridge-streams');

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
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-app-server-runtime-rollback-unsupported-'));
        const requestLogPath = join(root, 'requests.log');
        const fakeAppServer = await writeFakeCodexAppServerScript({
            dir: root,
            requestLogPath,
            rollbackError: { code: -32602, message: 'invalid params: expected { threadId, numTurns }' },
        });
        process.env.HAPPIER_CODEX_APP_SERVER_BIN = fakeAppServer;
        process.env.HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS = '10000';

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => updater({ machineId: 'machine_1' })),
                getLastObservedMessageSeq: vi.fn(() => 11),
                sendAgentMessageCommitted: vi.fn(async () => undefined),
                sendTranscriptDraftDelta: vi.fn(),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');

        await expect((runtime as any).rollbackConversation({ v: 1, target: { type: 'latest_turn' } })).resolves.toEqual({
            ok: false,
            errorCode: 'unsupported_action',
            errorMessage: expect.stringContaining('invalid params'),
        });
    });
});
