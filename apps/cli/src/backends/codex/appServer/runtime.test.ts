import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { createCodexAppServerRuntime } from './runtime';
import { createCodexAppServerTestEnvScope } from './testkit/fakeCodexAppServer';

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
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium" }, { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", supportedReasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }] }) + "\\n");',
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
        '        if (text === "bridge-turn-diff") {',
            '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/diff/updated", params: { threadId: msg.params?.threadId ?? null, turnId, unifiedDiff: "diff --git a/src/diffed.ts b/src/diffed.ts\\n--- a/src/diffed.ts\\n+++ b/src/diffed.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
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
    let envScope = createCodexAppServerTestEnvScope();
    const tempRoots = new Set<string>();

    afterEach(async () => {
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
        });
        envScope.patch({
            HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
        });
        return { root, requestLogPath, fakeAppServer };
    }

    it('starts a new app-server thread and publishes the thread id to session metadata', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-start-');

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
            [SESSION_MODELS_STATE_KEY]: expect.objectContaining({
                currentModelId: 'gpt-5.4',
                availableModels: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'gpt-5.4',
                        name: 'GPT-5.4',
                        modelOptions: expect.arrayContaining([
                            expect.objectContaining({ id: 'reasoning_effort', currentValue: 'medium' }),
                            expect.objectContaining({
                                id: 'speed',
                                currentValue: 'standard',
                                options: expect.arrayContaining([
                                    expect.objectContaining({ value: 'standard', name: 'Standard' }),
                                    expect.objectContaining({ value: 'fast', name: 'Fast' }),
                                ]),
                            }),
                        ]),
                    }),
                ]),
            }),
        });
        expect(updateMetadata.mock.results[1]?.value?.[SESSION_MODES_STATE_KEY]).toBeUndefined();
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
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-direct-');
        const scopedEnv = {
            HAPPIER_TRANSCRIPT_STORAGE: 'direct',
            CODEX_HOME: join(root, 'servers', 'cloud', 'daemon', 'connected-services', 'homes', 'openai-codex', 'profile', 'codex', 'codex-home'),
        } satisfies NodeJS.ProcessEnv;
        await mkdir(scopedEnv.CODEX_HOME, { recursive: true });

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
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-resume-');

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
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-turn-');

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

    it('does not advertise in-flight steer support even though turn/steer is available at the transport level', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.startOrLoad({});
        expect(runtime.supportsInFlightSteer()).toBe(false);

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
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-streams-');

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

        expect(session.sendTranscriptDraftDelta).not.toHaveBeenCalled();
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
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-divergent-final-');

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

        expect(session.sendTranscriptDraftDelta).not.toHaveBeenCalled();
        expect(session.sendAgentMessageCommitted.mock.calls).toEqual(
            expect.arrayContaining([
                ['codex', expect.objectContaining({ type: 'message', message: 'READY_FOR_FOLLOWUP' }), expect.any(Object)],
            ]),
        );
    });

    it('keeps multiple assistant and reasoning item streams isolated within one turn', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-multi-item-');

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

    it('emits a canonical Diff tool when the app-server publishes turn diff updates', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-turn-diff-');

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

    it('bridges completed-only command results as a synthetic tool-call plus tool-result', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-completed-only-command-');

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
            sendTranscriptDraftDelta: vi.fn(),
            sendCodexMessage: vi.fn(),
        };
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-foreign-thread-streams');

        const draftAssistantTexts = session.sendTranscriptDraftDelta.mock.calls
            .map((call) => call[1]?.sidechainId ? null : call[1]?.deltaText)
            .filter((value): value is string => typeof value === 'string');
        const childDraftCalls = session.sendTranscriptDraftDelta.mock.calls.filter(
            (call) => call[1]?.sidechainId === 'thread-child',
        );
        expect(draftAssistantTexts.some((value) => value.includes('Child'))).toBe(false);
        expect(childDraftCalls).toEqual([]);
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
                    type: 'tool-result',
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

    it('bridges non-approval request-user-input prompts as AskUserQuestion and returns structured answers', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-bridge-user-action-');

        const permissionHandler = {
            handleToolCall: vi
                .fn()
                .mockResolvedValueOnce({
                    decision: 'approved',
                    answers: {
                        'Which session export behavior should the plan target?': 'Single JSON',
                    },
                }),
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

        await new Promise((resolve) => setTimeout(resolve, 20));
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
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
        await runtime.setSessionConfigOption('speed', 'fast');
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
        expect((latestMetadata as Record<string, unknown>)[SESSION_MODELS_STATE_KEY]).toEqual(
            expect.objectContaining({
                currentModelId: 'gpt-5.4',
                availableModels: expect.arrayContaining([
                    expect.objectContaining({
                        id: 'gpt-5.4',
                        modelOptions: expect.arrayContaining([
                            expect.objectContaining({ id: 'reasoning_effort', currentValue: 'high' }),
                            expect.objectContaining({
                                id: 'speed',
                                currentValue: 'fast',
                                options: expect.arrayContaining([
                                    expect.objectContaining({ value: 'standard', name: 'Standard' }),
                                    expect.objectContaining({ value: 'fast', name: 'Fast' }),
                                ]),
                            }),
                        ]),
                    }),
                ]),
            }),
        );
        expect(updateMetadata.mock.results.map((entry) => entry.value)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ codexSessionId: 'thread-overrides' }),
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
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/resume',
                    params: expect.objectContaining({ threadId: 'thread-started', serviceTier: 'fast', persistExtendedHistory: true }),
                }),
                expect.objectContaining({
                    method: 'thread/resume',
                    params: expect.objectContaining({
                        threadId: 'thread-overrides',
                        model: 'gpt-5.4',
                        serviceTier: 'fast',
                        persistExtendedHistory: true,
                    }),
                }),
                expect.objectContaining({
                    method: 'turn/start',
                    params: expect.objectContaining({
                        threadId: 'thread-overrides',
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

    it('includes preselected model and Fast service tier in fresh thread/start requests', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-thread-start-overrides-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.setSessionModel('gpt-5.4');
        await runtime.setSessionConfigOption('speed', 'fast');
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
                        persistExtendedHistory: true,
                    }),
                }),
            ]),
        );
    });

    it('does not surface Speed controls when Codex is authenticated only by OPENAI_API_KEY', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-auth-');
        const scopedEnv = {
            OPENAI_API_KEY: 'sk-test-codex',
        } satisfies NodeJS.ProcessEnv;

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
