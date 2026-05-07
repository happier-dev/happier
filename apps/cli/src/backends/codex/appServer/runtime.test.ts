import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';
import type { SessionMediaItemV1 } from '@happier-dev/protocol';

import type { AgentMessage } from '@/agent';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { createCodexAppServerRuntime } from './runtime';
import { createCodexAppServerProcessEnv, createCodexAppServerTestEnvScope } from './testkit/fakeCodexAppServer';

type CommittedSnapshotBody = Readonly<{
    type?: string;
    message?: string;
    text?: string;
    sidechainId?: string | null;
}>;

type RuntimeSessionMediaMessage = Extract<AgentMessage, { type: 'session-media' }>;

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
        'import { appendFile, readFile } from "node:fs/promises";',
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
        '    if (msg.method === "turn/start") {',
        '        const text = Array.isArray(msg.params?.input) ? String(msg.params.input[0]?.text ?? "unknown") : "unknown";',
        '        const turnId = `turn-${text}`;',
        '        const matchingTurnStartCount = (await readFile(requestLogPath, "utf8").catch(() => "")).split("\\n").filter((line) => { try { const entry = JSON.parse(line); return entry.method === "turn/start" && Array.isArray(entry.params?.input) && String(entry.params.input[0]?.text ?? "") === text; } catch { return false; } }).length;',
        '        const completionDelayMs = text === "cancel-me" ? 50 : 15;',
        '        const respondDelayMs = text === "steer-delay" ? 60 : 0;',
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId: msg.params?.threadId ?? null } }) + "\\n");',
        '        }, respondDelayMs);',
        '        setTimeout(() => {',
            '            process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '        }, respondDelayMs + 5);',
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
        '        if (text === "bridge-turn-diff") {',
            '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/diff/updated", params: { threadId: msg.params?.threadId ?? null, turnId, unifiedDiff: "diff --git a/src/diffed.ts b/src/diffed.ts\\n--- a/src/diffed.ts\\n+++ b/src/diffed.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" } }) + "\\n");',
        '            }, 8);',
        '            setTimeout(() => {',
        '                process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '            }, 16);',
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
        '        setTimeout(() => {',
        '            process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: msg.params?.threadId ?? null, turn: { id: turnId } } }) + "\\n");',
        '        }, respondDelayMs + completionDelayMs);',
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
        '        const expectedTurnId = typeof msg.params?.expectedTurnId === "string" ? msg.params.expectedTurnId : null;',
        '        const turnId = typeof msg.params?.turnId === "string" ? msg.params.turnId : null;',
        '        const selected = expectedTurnId ?? turnId;',
        '        if (!selected) {',
        '            process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "turn/steer requires expectedTurnId" } }) + "\\n");',
        '            continue;',
        '        }',
        '        process.stdout.write(JSON.stringify({ id: msg.id, result: { turnId: selected } }) + "\\n");',
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
            CODEX_HOME: join(root, 'codex-home'),
            OPENAI_API_KEY: 'test-openai-key',
            CODEX_API_KEY: undefined,
        });
        return { root, requestLogPath, fakeAppServer };
    }

    async function readRequestLog(requestLogPath: string): Promise<Array<{ id: unknown; method: string; params: any; result: any; error: any }>> {
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
                        modelOptions: expect.arrayContaining([
                            expect.objectContaining({ id: 'reasoning_effort', currentValue: 'medium' }),
                        ]),
                    }),
                ]),
            }),
        });
        expect(updateMetadata.mock.results[1]?.value).toMatchObject({
            [SESSION_MODES_STATE_KEY]: expect.objectContaining({
                v: 1,
                provider: 'codex',
                currentModeId: 'default',
                availableModes: expect.arrayContaining([
                    expect.objectContaining({ id: 'default', name: 'Default' }),
                    expect.objectContaining({ id: 'plan', name: 'Plan' }),
                ]),
            }),
        });
        const requestLog = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(requestLog).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    method: 'thread/start',
                    params: expect.objectContaining({
                        cwd: root,
                        approvalPolicy: expect.objectContaining({
                            granular: expect.objectContaining({
                                mcp_elicitations: true,
                                request_permissions: true,
                                rules: true,
                                sandbox_approval: true,
                                skill_approval: false,
                            }),
                        }),
                        approvalsReviewer: 'user',
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
                        approvalPolicy: {
                            granular: expect.objectContaining({
                                request_permissions: true,
                                sandbox_approval: true,
                            }),
                        },
                        approvalsReviewer: 'auto_review',
                        sandbox: 'workspace-write',
                    }),
                }),
            ]),
        );
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

    it('advertises in-flight steer support and can call turn/steer while a turn is in flight', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-steer-');

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
                    expectedTurnId: 'turn-cancel-me',
                    input: [{ type: 'text', text: 'nudge' }],
                }),
            }),
        ]);
        expect(requestLog.filter((entry: { method: string }) => entry.method === 'turn/start')).toHaveLength(1);
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
        await runtime.steerPrompt('nudge-early');
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
            session: session as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');

        const committedCalls = session.sendAgentMessageCommitted.mock.calls as unknown as Array<
            [string, { type?: string; message?: string; text?: string }, { localId: string; meta?: Record<string, any> }]
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
                [expect.objectContaining({ type: 'tool-call', callId: 'patch_1', name: 'CodexPatch', input: { auto_approved: true, changes: { 'src/file.ts': { hunks: 2 } } } })],
                [expect.objectContaining({ type: 'tool-call-result', callId: 'patch_1', output: { stdout: 'patched', success: true } })],
            ]),
        );
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
            sendAgentMessageCommitted: vi.fn(async () => {}),
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
        const sessionMediaPersist = vi.fn(
            async (_message: RuntimeSessionMediaMessage): Promise<readonly SessionMediaItemV1[]> => [persistedMediaItem],
        );
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
        const sessionMediaPersist = vi.fn(
            async (_message: RuntimeSessionMediaMessage): Promise<readonly SessionMediaItemV1[]> => [persistedMediaItem],
        );
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

    it('commits a late final assistant item that arrives after turn/completed', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-late-final-');

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
    });

    it('commits a raw assistant final when no normalized assistant final arrives', async () => {
        const { root } = await createRuntimeFixture('happier-codex-app-server-runtime-raw-final-only-');

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

    it('includes preselected model and Fast service tier in fresh thread/start requests', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-thread-start-overrides-');

        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: { updateMetadata: vi.fn() } as any,
        });

        await runtime.setSessionModel('gpt-5.4');
        await runtime.setSessionConfigOption('service_tier', 'fast');
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
        await expect(runtime.compactContext('/compact')).resolves.toBeUndefined();

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

    it('restarts the app-server process and resumes the same thread when Codex reports the cached auth account changed', async () => {
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

        await expect(runtime.sendPrompt('account-mismatch-once')).resolves.toBeUndefined();

        expect(runtime.getSessionId()).toBe('thread-started');
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
        const retriedTurnStarts = requestLog.filter((entry: { method: string; params?: { input?: Array<{ text?: string }>; threadId?: string } }) =>
            entry.method === 'turn/start' && entry.params?.input?.[0]?.text === 'account-mismatch-once',
        );
        expect(retriedTurnStarts).toHaveLength(2);
        expect(retriedTurnStarts.map((entry: { params?: { threadId?: string } }) => entry.params?.threadId)).toEqual([
            'thread-started',
            'thread-started',
        ]);
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('access token could not be refreshed'),
        }));
        expect(sendCodexMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'turn_aborted',
        }));
        expect(sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: expect.stringContaining('refused to continue in the current process'),
        });
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

    it('does not fail rollback after app-server success when rollback metadata persistence rejects', async () => {
        const { root, requestLogPath } = await createRuntimeFixture('happier-codex-app-server-runtime-rollback-metadata-reject-');

        let lastObservedMessageSeq = 7;
        const runtime = createCodexAppServerRuntime({
            directory: root,
            onThinkingChange: vi.fn(),
            session: {
                updateMetadata: vi.fn(async () => {
                    throw new Error('metadata unavailable');
                }),
                getLastObservedMessageSeq: vi.fn(() => lastObservedMessageSeq),
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = 11;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');

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
                // Simulate session client updating the seq counters after the user-message callback begins.
                sendAgentMessageCommitted: vi.fn(async () => {
                    lastObservedMessageSeq = 3;
                    lastObservedUserMessageSeq = 1;
                }),
                sendCodexMessage: vi.fn(),
            } as any,
        });

        await runtime.startOrLoad({});
        await runtime.sendPrompt('bridge-streams');

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
